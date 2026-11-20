import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { encryptField } from '@cost-core/crypto';
import { moneyFromMinor } from '@cost-core/types';
import { runMigrations } from '../src/migrations.js';
import { migrateMoneyOffline } from '../src/money-migration.js';
import { encryptMoneyMinor } from '../src/money-codec.js';
import { openExactTransactionMoneyRepository } from '../src/repos/exact-transaction-money.repo.js';

const key = 'synthetic-test-key';
const policy = { version: 'test-v1', exponents: { AAA: 2, BBB: 0, CCC: 18 } };
const provenance = { tx: 'BBB', hidden: 'BBB', deleted: 'BBB', nullproject: 'BBB' };
const all = { all: true } as const;
const opened: InstanceType<typeof Database>[] = [];
type DB = InstanceType<typeof Database>;
afterEach(() => { while (opened.length) opened.pop()!.close(); });
function insert(d: DB, id: string, project: string | null, amount: string, base: string, deleted: string | null = null) {
  d.prepare(`INSERT INTO transactions (id,project_id,type,date,amount_encrypted,currency,base_amount_encrypted,category_id,title_encrypted,title_blind_index,account_from_id,account_to_id,payment_source,oto_kasa_transaction_id,is_paid,status,deleted_at,created_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, project, 'expense', 'date', amount, 'AAA', base, 'category', 'title', 'index', 'orphan-from', 'orphan-to', 'person_out_of_pocket', 'orphan-oto', 0, 'paid', deleted, 'user', 'created', 'updated');
}
function fixture(): DB {
  const d = new Database(':memory:'); opened.push(d); d.pragma('foreign_keys = ON'); runMigrations(d);
  const legacy = encryptField(1, key);
  insert(d, 'tx', 'p', legacy, legacy);
  insert(d, 'hidden', 'q', legacy, legacy);
  insert(d, 'deleted', 'p', legacy, legacy, 'removed');
  insert(d, 'nullproject', null, legacy, legacy);
  migrateMoneyOffline(d, key, policy, provenance);
  d.prepare('UPDATE transactions SET amount_encrypted=?,base_amount_encrypted=? WHERE id=?').run(encryptMoneyMinor(900719925474099312345n, 'AAA', policy, key), encryptMoneyMinor(-42n, 'BBB', policy, key), 'tx');
  return d;
}
function snapshot(d: DB): string {
  return JSON.stringify({
    schema: d.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all(),
    accounts: d.prepare('SELECT * FROM main.accounts ORDER BY rowid').all(),
    transactions: d.prepare('SELECT * FROM main.transactions ORDER BY rowid').all(),
    audit: d.prepare('SELECT * FROM main.audit_logs ORDER BY rowid').all(),
    history: d.prepare('SELECT * FROM main.schema_migrations ORDER BY rowid').all(),
    format: d.prepare('SELECT * FROM main.money_format ORDER BY rowid').all(),
    provenance: d.prepare('SELECT * FROM main.transaction_base_currencies ORDER BY rowid').all(),
    changes: d.prepare('SELECT total_changes() AS count').get(),
  });
}
function failure(fn: () => unknown) {
  let error: unknown;
  try { fn(); } catch (e) { error = e; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe('Exact transaction money operation failed');
  expect(Object.hasOwn(error as object, 'cause')).toBe(false);
}
const open = (d: DB) => openExactTransactionMoneyRepository(d, key, policy, provenance);

describe('exact transaction money reader', () => {
  it('projects exactly the stored metadata and exact native and historical base values without writes', () => {
    const d = fixture(); const before = snapshot(d); const repo = open(d);
    expect(repo.getTransactionMoneyInScope('tx', all)).toEqual({ transactionId: 'tx', projectId: 'p', type: 'expense', status: 'paid', paymentSource: 'person_out_of_pocket', isPaid: false, currency: 'AAA', amount: moneyFromMinor(900719925474099312345n, 'AAA', policy), baseCurrency: 'BBB', baseAmount: moneyFromMinor(-42n, 'BBB', policy), accountFromId: 'orphan-from', accountToId: 'orphan-to', otoKasaTransactionId: 'orphan-oto', deletedAt: null, updatedAt: 'updated' });
    expect(snapshot(d)).toBe(before);
  });
  it('applies project and deletion filters before decrypting selected rows', () => {
    const d = fixture(); const repo = open(d);
    d.prepare("UPDATE transactions SET amount_encrypted='corrupt' WHERE id IN ('hidden','deleted')").run();
    const before = snapshot(d);
    expect(repo.getTransactionMoneyInScope('hidden', { all: false, projectIds: ['p', 'p'] })).toBeNull();
    expect(repo.getTransactionMoneyInScope('deleted', all)).toBeNull();
    expect(repo.getTransactionMoneyInScope('nullproject', { all: false, projectIds: ['p'] })).toBeNull();
    expect(repo.getTransactionMoneyInScope('tx', { all: false, projectIds: [] })).toBeNull();
    expect(repo.getTransactionMoneyInScope('missing', all)).toBeNull();
    failure(() => repo.getTransactionMoneyInScope('hidden', all));
    failure(() => repo.getTransactionMoneyInScope('deleted', all, true));
    expect(snapshot(d)).toBe(before);
  });
  it('fails rather than hiding a newly inserted visible row without provenance', () => {
    const d = fixture(); const repo = open(d);
    insert(d, 'new-visible', 'p', encryptMoneyMinor(0n, 'AAA', policy, key), encryptMoneyMinor(0n, 'BBB', policy, key));
    const before = snapshot(d);
    failure(() => repo.getTransactionMoneyInScope('new-visible', all));
    expect(snapshot(d)).toBe(before);
  });
  it('validates arguments and descriptors even on missing and deny paths', () => {
    const d = fixture(); const repo = open(d); const before = snapshot(d);
    for (const id of ['', ' ', 'x'.repeat(129), String.fromCharCode(0xd800), 1, null]) failure(() => repo.getTransactionMoneyInScope(id as string, all));
    let reads = 0; const getter = Object.defineProperty({}, 'all', { get() { reads++; return true; } });
    const arrayGetter = Object.defineProperty(['p'], '0', { get() { reads++; return 'p'; } });
    const extra = ['p']; Object.defineProperty(extra, 'extra', { value: 1 });
    const symbol = ['p']; Object.defineProperty(symbol, Symbol('extra'), { value: 1 });
    const coercion = { toString() { reads++; return 'p'; } };
    const scopes: unknown[] = [null, {}, { all: true, projectIds: [] }, { all: false }, { all: 1 }, { all: false, projectIds: new Array(1) }, { all: false, projectIds: arrayGetter }, { all: false, projectIds: extra }, { all: false, projectIds: symbol }, { all: false, projectIds: new Array(100001).fill('p') }, { all: false, projectIds: [' '] }, { all: false, projectIds: [coercion] }, getter, { all: true, [Symbol('extra')]: 1 }];
    for (const scope of scopes) failure(() => repo.getTransactionMoneyInScope('missing', scope as typeof all));
    let traps = 0; const proxy = new Proxy({}, { ownKeys() { traps++; throw new Error('secret'); } });
    failure(() => repo.getTransactionMoneyInScope('missing', proxy as typeof all));
    expect(traps).toBeGreaterThan(0); expect(reads).toBe(0);
    for (const value of [null, 0, 1, 'false']) failure(() => repo.getTransactionMoneyInScope('missing', all, value as unknown as boolean));
    expect(repo.getTransactionMoneyInScope('tx', all, undefined)).not.toBeNull();
    expect(repo.getTransactionMoneyInScope('tx', { all: false, projectIds: [' p '] })).toBeNull();
    expect(repo.getTransactionMoneyInScope('deleted', all, true)?.deletedAt).toBe('removed');
    expect(snapshot(d)).toBe(before);
  });
  it('copies mutable factory context and returns independent results', () => {
    const d = fixture(); const secret = createHash('sha256').update(key).digest(); const localPolicy = { version: policy.version, exponents: { ...policy.exponents } }; const localProvenance = { ...provenance };
    const repo = openExactTransactionMoneyRepository(d, secret, localPolicy, localProvenance);
    secret.fill(0); localPolicy.exponents.AAA = 18; localProvenance.tx = 'AAA';
    const ids = ['p', 'p']; const scope = { all: false as const, projectIds: ids };
    const first = repo.getTransactionMoneyInScope('tx', scope)!; const second = repo.getTransactionMoneyInScope('tx', scope)!;
    expect(ids).toEqual(['p', 'p']); expect(first.amount).toEqual(moneyFromMinor(900719925474099312345n, 'AAA', policy));
    expect(first.baseAmount).toEqual(moneyFromMinor(-42n, 'BBB', policy)); expect(second).toEqual(first); expect(second).not.toBe(first); expect(second.amount).not.toBe(first.amount);
  });
  it('rejects invalid factory context, mismatches, v3 and active transactions without writes', () => {
    const d = fixture(); const before = snapshot(d); let reads = 0;
    failure(() => openExactTransactionMoneyRepository(d, 'wrong', policy, provenance));
    failure(() => openExactTransactionMoneyRepository(d, key, { version: 'other', exponents: policy.exponents }, provenance));
    failure(() => openExactTransactionMoneyRepository(d, key, policy, { ...provenance, tx: 'AAA' }));
    failure(() => openExactTransactionMoneyRepository(d, key, { ...policy, extra: 1 } as typeof policy, provenance));
    const bad = Object.defineProperty({}, 'tx', { get() { reads++; return 'BBB'; }, enumerable: true });
    failure(() => openExactTransactionMoneyRepository(d, key, policy, bad)); expect(reads).toBe(0);
    d.transaction(() => { failure(() => open(d)); expect(d.inTransaction).toBe(true); })(); expect(snapshot(d)).toBe(before);
    const v3 = new Database(':memory:'); opened.push(v3); v3.pragma('foreign_keys = ON'); runMigrations(v3);
    const schema = JSON.stringify(v3.prepare('SELECT * FROM main.sqlite_schema ORDER BY type,name').all()); const changes = v3.prepare('SELECT total_changes() AS n').get();
    failure(() => openExactTransactionMoneyRepository(v3, key, policy, {}));
    expect(JSON.stringify(v3.prepare('SELECT * FROM main.sqlite_schema ORDER BY type,name').all())).toBe(schema); expect(v3.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });
  it('rechecks full metadata and current TEMP/FK on missing and deny paths', () => {
    const changes: Array<(d: DB) => void> = [
      d => { d.exec('CREATE TABLE unrelated_fence_change (id INTEGER)'); },
      d => { d.prepare("UPDATE main.schema_migrations SET name='changed' WHERE version=1").run(); },
      d => { d.prepare("UPDATE main.money_format SET migrated_at='changed' WHERE id=1").run(); },
      d => { d.prepare("UPDATE main.transaction_base_currencies SET currency='AAA' WHERE transaction_id='tx'").run(); },
      d => { d.exec('CREATE TEMP TABLE shadow (id INTEGER)'); },
      d => { d.pragma('foreign_keys = OFF'); },
    ];
    for (const change of changes) { const d = fixture(); const repo = open(d); change(d); const before = snapshot(d);
      failure(() => repo.getTransactionMoneyInScope('missing', all)); failure(() => repo.getTransactionMoneyInScope('tx', { all: false, projectIds: [] })); expect(snapshot(d)).toBe(before);
    }
  });
  it('maps all enumerations and raw paid flags, rejecting malformed selected metadata', () => {
    const d = fixture(); const repo = open(d);
    for (const type of ['expense', 'income', 'transfer']) { d.prepare('UPDATE transactions SET type=? WHERE id=?').run(type, 'tx'); expect(repo.getTransactionMoneyInScope('tx', all)?.type).toBe(type); }
    for (const status of ['draft', 'pending_approval', 'pending', 'approved', 'paid', 'rejected', 'cancelled']) { d.prepare('UPDATE transactions SET status=? WHERE id=?').run(status, 'tx'); expect(repo.getTransactionMoneyInScope('tx', all)?.status).toBe(status); }
    for (const source of ['company_account', 'person_out_of_pocket']) { d.prepare('UPDATE transactions SET payment_source=? WHERE id=?').run(source, 'tx'); expect(repo.getTransactionMoneyInScope('tx', all)?.paymentSource).toBe(source); }
    for (const paid of [0, 1]) { d.prepare('UPDATE transactions SET is_paid=? WHERE id=?').run(paid, 'tx'); expect(repo.getTransactionMoneyInScope('tx', all)?.isPaid).toBe(Boolean(paid)); }
    const invalid: Array<[string, unknown, unknown]> = [["UPDATE main.transactions SET type=? WHERE id='tx'", 'bad', 'transfer'], ["UPDATE main.transactions SET status=? WHERE id='tx'", 'bad', 'cancelled'], ["UPDATE main.transactions SET payment_source=? WHERE id='tx'", 'bad', 'person_out_of_pocket'], ["UPDATE main.transactions SET is_paid=? WHERE id='tx'", 2, 1], ["UPDATE main.transactions SET project_id=? WHERE id='tx'", ' ', 'p'], ["UPDATE main.transactions SET account_from_id=? WHERE id='tx'", ' ', 'orphan-from'], ["UPDATE main.transactions SET account_to_id=? WHERE id='tx'", 'x'.repeat(129), 'orphan-to'], ["UPDATE main.transactions SET oto_kasa_transaction_id=? WHERE id='tx'", ' ', 'orphan-oto'], ["UPDATE main.transactions SET deleted_at=? WHERE id='tx'", '', null], ["UPDATE main.transactions SET updated_at=? WHERE id='tx'", '', 'updated']];
    for (const [sql, value, restore] of invalid) { d.prepare(sql).run(value); failure(() => repo.getTransactionMoneyInScope('tx', all, true)); d.prepare(sql).run(restore); }
  });
  it('reads same-currency zero and negative exponent-18 amounts exactly', () => {
    const d = fixture(); const repo = open(d);
    d.prepare('UPDATE transactions SET currency=?,amount_encrypted=?,base_amount_encrypted=? WHERE id=?').run('BBB', encryptMoneyMinor(0n, 'BBB', policy, key), encryptMoneyMinor(0n, 'BBB', policy, key), 'tx');
    expect(repo.getTransactionMoneyInScope('tx', all)?.amount).toEqual(moneyFromMinor(0n, 'BBB', policy)); expect(repo.getTransactionMoneyInScope('tx', all)?.baseAmount).toEqual(moneyFromMinor(0n, 'BBB', policy));
    d.prepare('UPDATE transactions SET currency=?,amount_encrypted=? WHERE id=?').run('CCC', encryptMoneyMinor(-1234567890123456789n, 'CCC', policy, key), 'tx');
    expect(repo.getTransactionMoneyInScope('tx', all)?.amount).toEqual(moneyFromMinor(-1234567890123456789n, 'CCC', policy));
  });
  it('preserves caller work across nested success and failure savepoints', () => {
    const d = fixture(); const repo = open(d);
    expect(() => d.transaction(() => {
      d.prepare("UPDATE main.transactions SET status='invalid' WHERE id='tx'").run(); const before = snapshot(d);
      failure(() => repo.getTransactionMoneyInScope('tx', all)); expect(d.inTransaction).toBe(true); expect(snapshot(d)).toBe(before);
      d.prepare("UPDATE main.transactions SET status='draft' WHERE id='tx'").run(); expect(repo.getTransactionMoneyInScope('tx', all)?.status).toBe('draft');
      expect(d.inTransaction).toBe(true); throw new Error('rollback caller');
    })()).toThrow('rollback caller');
    expect(repo.getTransactionMoneyInScope('tx', all)?.status).toBe('paid');
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('additional transaction reader acceptance gaps', () => {
  it('uses historical base currency rather than the current setting', () => {
    const d = fixture();
    d.prepare("INSERT INTO main.white_label_settings (id,base_currency,updated_at) VALUES ('global','AAA','settings')").run();
    const before = snapshot(d); const result = open(d).getTransactionMoneyInScope('tx', all)!;
    expect(result.baseCurrency).toBe('BBB');
    expect(result.baseAmount).toEqual(moneyFromMinor(-42n, 'BBB', policy));
    expect(snapshot(d)).toBe(before);
  });
  it('rejects malformed factory descriptors and bounds without invoking getters or coercion', () => {
    const d = fixture(); const before = snapshot(d); let calls = 0;
    const getter = () => { calls++; return 'BBB'; };
    const accessor = Object.defineProperty({}, 'tx', { enumerable: true, get: getter });
    const policyAccessor = Object.defineProperty({ exponents: policy.exponents }, 'version', { enumerable: true, get: getter });
    const exponentAccessor = Object.defineProperty({}, 'AAA', { enumerable: true, get: getter });
    const inherited = Object.assign(Object.create({ inherited: 'BBB' }), provenance);
    const symbol = { ...provenance, [Symbol('extra')]: 'BBB' };
    const proxy = new Proxy({}, { ownKeys() { throw new Error('private proxy detail'); } });
    const coercion = { toString() { calls++; return 'BBB'; } };
    const policies: unknown[] = [policyAccessor, { version: policy.version, exponents: exponentAccessor }, { version: policy.version, exponents: { AAA: coercion } }, { version: policy.version, exponents: {} }, { version: 'x'.repeat(65), exponents: policy.exponents }, { version: policy.version, exponents: { AAA: 19 } }, Object.assign(Object.create({ x: 1 }), policy), { ...policy, [Symbol('x')]: 1 }, proxy];
    for (const p of policies) failure(() => openExactTransactionMoneyRepository(d, key, p as typeof policy, provenance));
    for (const p of [accessor, inherited, symbol, proxy, { ...provenance, tx: coercion }, { ...provenance, ['x'.repeat(129)]: 'BBB' }]) failure(() => openExactTransactionMoneyRepository(d, key, policy, p as typeof provenance));
    expect(calls).toBe(0); expect(snapshot(d)).toBe(before);
  });
  it('sanitizes transaction completion failures after a real read and copies only own SQLITE_BUSY', () => {
    const d = fixture(); const repo = open(d); const before = snapshot(d);
    const original = d.transaction;
    try {
      for (const thrown of [{ code: 'SQLITE_BUSY', message: 'private' }, { code: 'SQLITE_CONSTRAINT', message: 'private' }, Object.create({ code: 'SQLITE_BUSY' })]) {
        (d as any).transaction = (fn: () => unknown) => ({ deferred: () => { original.call(d, fn).deferred(); throw thrown; } });
        let caught: any; try { repo.getTransactionMoneyInScope('tx', all); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(Error); expect(caught.message).toBe('Exact transaction money operation failed'); expect(Object.hasOwn(caught, 'cause')).toBe(false);
        if (Object.hasOwn(thrown, 'code') && thrown.code === 'SQLITE_BUSY') expect(caught.code).toBe('SQLITE_BUSY'); else expect(Object.hasOwn(caught, 'code')).toBe(false);
      }
    } finally { (d as any).transaction = original; }
    expect(snapshot(d)).toBe(before);
  });
  it('sanitizes real factory SQLITE_BUSY and succeeds after the writer releases its lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'costcore-transaction-test-')); const file = join(dir, 'synthetic.sqlite');
    const writer = new Database(file); const reader = new Database(file);
    try {
      writer.pragma('foreign_keys = ON'); reader.pragma('foreign_keys = ON'); reader.pragma('busy_timeout = 0'); runMigrations(writer);
      const legacy = encryptField(1, key); insert(writer, 'tx', 'p', legacy, legacy);
      migrateMoneyOffline(writer, key, policy, { tx: 'BBB' });
      const before = snapshot(writer); writer.exec('BEGIN IMMEDIATE');
      let caught: any; try { openExactTransactionMoneyRepository(reader, key, policy, { tx: 'BBB' }); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(Error); expect(caught.message).toBe('Exact transaction money operation failed'); expect(caught.code).toBe('SQLITE_BUSY'); expect(Object.hasOwn(caught, 'cause')).toBe(false);
      writer.exec('ROLLBACK'); expect(snapshot(writer)).toBe(before);
      expect(openExactTransactionMoneyRepository(reader, key, policy, { tx: 'BBB' }).getTransactionMoneyInScope('tx', all)).not.toBeNull();
      expect(snapshot(writer)).toBe(before);
    } finally { if (writer.inTransaction) writer.exec('ROLLBACK'); reader.close(); writer.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
