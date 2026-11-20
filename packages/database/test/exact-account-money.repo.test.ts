import { createHash } from 'node:crypto';
import { mkdtempSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cryptoModule from '@cost-core/crypto';
import * as moneyCodec from '../src/money-codec.js';
import Database from 'better-sqlite3';
import { encryptField } from '@cost-core/crypto';
import { moneyFromMinor } from '@cost-core/types';
import { runMigrations } from '../src/migrations.js';
import { encryptMoneyMinor } from '../src/money-codec.js';
import { migrateMoneyOffline, verifyMoneyStore } from '../src/money-migration.js';
import { openExactAccountMoneyRepository } from '../src/repos/exact-account-money.repo.js';

const key = 'synthetic-test-key';
const policy = { version: 'test-v1', exponents: { AAA: 2, BBB: 0, CCC: 18 } };
const all = { all: true } as const;
const none = { all: false, projectIds: [] } as const;
const scoped = { all: false, projectIds: ['p'] } as const;
const opened: InstanceType<typeof Database>[] = [];
type DB = InstanceType<typeof Database>;
function db(): DB {
  const d = new Database(':memory:'); opened.push(d);
  d.pragma('foreign_keys = ON'); runMigrations(d); return d;
}
afterEach(() => { while (opened.length) opened.pop()!.close(); });
function snapshot(d: DB): string {
  const exists = !!d.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='money_format'").get();
  return JSON.stringify({
    schema: d.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all(),
    accounts: d.prepare('SELECT * FROM main.accounts ORDER BY rowid').all(),
    transactions: d.prepare('SELECT * FROM main.transactions ORDER BY rowid').all(),
    audit: d.prepare('SELECT * FROM main.audit_logs ORDER BY rowid').all(),
    history: d.prepare('SELECT * FROM main.schema_migrations ORDER BY rowid').all(),
    format: exists ? d.prepare('SELECT * FROM main.money_format ORDER BY rowid').all() : null,
    provenance: exists ? d.prepare('SELECT * FROM main.transaction_base_currencies ORDER BY rowid').all() : null,
  });
}
function v4(): DB {
  const d = db();
  const project = d.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)');
  project.run('p', 'P', 'old', 'old'); project.run('q', 'Q', 'old', 'old');
  migrateMoneyOffline(d, key, policy, {});
  const insert = d.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,iban_encrypted,project_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('a', 'A', 'a-index', 'AAA', encryptMoneyMinor(10n, 'AAA', policy, key), null, encryptField('synthetic-iban', key), 'p', 0, 'old', 'old');
  insert.run('b', 'B', 'b-index', 'BBB', encryptMoneyMinor(-2n, 'BBB', policy, key), encryptMoneyMinor(0n, 'BBB', policy, key), null, 'q', 1, 'old', 'old');
  insert.run('c', 'C', 'c-index', 'CCC', encryptMoneyMinor(1n, 'CCC', policy, key), null, null, null, 1, 'old', 'old');
  return d;
}
const amount = (n: bigint, currency = 'AAA') => moneyFromMinor(n, currency, policy);
const delta = (accountId: string, n: bigint, currency = 'AAA') => ({ accountId, delta: amount(n, currency) });
const repository = (d: DB) => openExactAccountMoneyRepository(d, key, policy, {});
const failure = 'Exact account money operation failed';
function exactFailure(fn: () => unknown): void {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(failure);
  expect(Object.hasOwn(caught as object, 'cause')).toBe(false);
}
function updateSeam(d: DB) {
  const original = d.prepare;
  let count = 0;
  let attempts = 0;
  let action: ((n: number, result: Database.RunResult) => Database.RunResult) | undefined;
  const accountUpdate = /^\s*UPDATE\s+(?:(?:main|"main"|`main`|\[main\])\s*\.\s*)?(?:accounts\b|"accounts"|`accounts`|\[accounts\])(?=\s|$)/i;
  (d as any).prepare = function(sql: string) {
    const statement = original.call(d, sql);
    if (!accountUpdate.test(sql)) return statement;
    const proxy = new Proxy(statement, { get(target, prop) {
      if (prop === 'run') return (...args: unknown[]) => {
        if (action) attempts++;
        const result = Reflect.apply(target.run, target, args) as Database.RunResult;
        return action ? action(++count, result) : result;
      };
      const value = (target as any)[prop];
      return typeof value === 'function' ? (...args: unknown[]) => {
        const returned = value.apply(target, args);
        return returned === target ? proxy : returned;
      } : value;
    }});
    return proxy;
  };
  return {
    arm(fn: (n: number, result: Database.RunResult) => Database.RunResult) { count = 0; attempts = 0; action = fn; },
    attempts() { return attempts; },
    count() { return count; },
    restore() { (d as any).prepare = original; },
  };
}

describe('verify-only money store', () => {
  it('rejects v3 without changing ciphertext, schema or history', () => {
    const d = db();
    d.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('a', 'A', 'idx', 'AAA', encryptField(1, key), 'old', 'old');
    const before = snapshot(d);
    expect(() => verifyMoneyStore(d, key, policy, {})).toThrow();
    expect(snapshot(d)).toBe(before);
  });
  it('verifies v4 without changing bytes and rejects wrong credentials or policy', () => {
    const d = v4(); const before = snapshot(d);
    expect(verifyMoneyStore(d, key, policy, {})).toEqual({ status: 'verified', accounts: 3, transactions: 0, encryptedFields: 4 });
    expect(() => verifyMoneyStore(d, 'wrong-key', policy, {})).toThrow();
    expect(() => verifyMoneyStore(d, key, { ...policy, version: 'wrong' }, {})).toThrow();
    expect(snapshot(d)).toBe(before);
  });
  it('uses nested savepoints while the offline migrator refuses caller transactions', () => {
    const d = v4(); const before = snapshot(d);
    d.exec('BEGIN'); d.prepare('UPDATE accounts SET name=? WHERE id=?').run('sentinel', 'a');
    expect(verifyMoneyStore(d, key, policy, {}).status).toBe('verified');
    expect(() => verifyMoneyStore(d, 'wrong', policy, {})).toThrow();
    expect(() => migrateMoneyOffline(d, key, policy, {})).toThrow();
    expect(d.inTransaction).toBe(true);
    expect((d.prepare('SELECT name FROM accounts WHERE id=?').get('a') as any).name).toBe('sentinel');
    d.exec('ROLLBACK'); expect(snapshot(d)).toBe(before);
  });
});

describe('dormant exact account money repository', () => {
  it('reads exact money in stable order and preserves SQL null', () => {
    const d = v4(); const r = repository(d);
    expect(r.listAccountMoneyInScope(all).map(x => x.accountId)).toEqual(['a', 'b', 'c']);
    expect(r.getAccountMoneyInScope('a', all)).toMatchObject({ accountId: 'a', currency: 'AAA', balance: amount(10n), creditLimit: null, updatedAt: 'old' });
    expect(r.getAccountMoneyInScope('b', all)?.creditLimit).toEqual(amount(0n, 'BBB'));
    expect(r.getAccountMoneyInScope('a', none)).toBeNull();
    expect(r.listAccountMoneyInScope(none)).toEqual([]);
    expect(r.getAccountMoneyInScope('missing', all)).toBeNull();
    expect(r.listAccountMoneyInScope(scoped).map(x => x.accountId)).toEqual(['a']);
    expect(r.getAccountMoneyInScope('b', scoped)).toBeNull();
    expect(r.getAccountMoneyInScope('c', scoped)).toBeNull();
  });
  it('filters scope before decrypting inaccessible corrupted rows', () => {
    const d = v4(); const r = repository(d);
    d.prepare('UPDATE accounts SET balance_encrypted=? WHERE id=?').run('invalid', 'b');
    expect(r.getAccountMoneyInScope('b', scoped)).toBeNull();
    expect(r.listAccountMoneyInScope(scoped).map(x => x.accountId)).toEqual(['a']);
    expect(r.applyBalanceDeltasInScope([delta('a', 20n)], scoped)[0]!.balance).toEqual(amount(30n));
    exactFailure(() => repository(d));
  });
  it('coalesces exact deltas and uses one batch timestamp', () => {
    const d = v4(); const r = repository(d);
    const before = d.prepare('SELECT * FROM accounts ORDER BY id').all() as any[];
    const result = r.applyBalanceDeltasInScope([delta('c', -1n, 'CCC'), delta('a', 20n), delta('b', 2n, 'BBB'), delta('a', -5n), delta('a', 5n)], all);
    expect(result.map(x => x.accountId)).toEqual(['a', 'b', 'c']);
    expect(result.map(x => x.balance)).toEqual([amount(30n), amount(0n, 'BBB'), amount(0n, 'CCC')]);
    expect(new Set(result.map(x => x.updatedAt)).size).toBe(1);
    expect(new Date(result[0]!.updatedAt).toISOString()).toBe(result[0]!.updatedAt);
    const after = d.prepare('SELECT * FROM accounts ORDER BY id').all() as any[];
    for (let i = 0; i < before.length; i++) {
      const { balance_encrypted: _b, updated_at: _t, ...oldRest } = before[i];
      const { balance_encrypted: _c, updated_at: _u, ...newRest } = after[i];
      expect(newRest).toEqual(oldRest);
    }
  });
  it('distinguishes empty, zero, cancellation and 1000 supplied deltas', () => {
    const d = v4(); const r = repository(d); const before = snapshot(d);
    expect(r.applyBalanceDeltasInScope([], all)).toEqual([]); expect(snapshot(d)).toBe(before);
    const first = r.applyBalanceDeltasInScope([delta('a', 1n), delta('a', -1n)], scoped);
    expect(first).toHaveLength(1); expect(first[0]!.balance).toEqual(amount(10n));
    const encrypted = (d.prepare('SELECT balance_encrypted FROM accounts WHERE id=?').get('a') as any).balance_encrypted;
    expect(r.applyBalanceDeltasInScope([delta('a', 0n)], scoped)).toHaveLength(1);
    expect((d.prepare('SELECT balance_encrypted FROM accounts WHERE id=?').get('a') as any).balance_encrypted).not.toBe(encrypted);
    expect(r.applyBalanceDeltasInScope(Array.from({ length: 1000 }, () => delta('a', 0n)), scoped)[0]!.balance).toEqual(amount(10n));
  });
  it('rewrites a net-zero target once with a canonical persisted timestamp', () => {
    const d = v4(); const seam = updateSeam(d);
    try {
      const r = repository(d);
      const before = d.prepare('SELECT balance_encrypted FROM accounts WHERE id=?').get('a') as any;
      seam.arm((_n, result) => result);
      const result = r.applyBalanceDeltasInScope([delta('a', 7n), delta('a', -7n)], scoped);
      expect(seam.count()).toBe(1);
      expect(result).toHaveLength(1);
      expect(result[0]!.accountId).toBe('a');
      expect(result[0]!.balance).toEqual(amount(10n));
      expect(result[0]!.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      const after = d.prepare('SELECT balance_encrypted,updated_at FROM accounts WHERE id=?').get('a') as any;
      expect(after.balance_encrypted).not.toBe(before.balance_encrypted);
      expect(after.updated_at).toBe(result[0]!.updatedAt);
    } finally { seam.restore(); }
  });
  it('validates all targets and cancelling missing targets before writes', () => {
    const d = v4(); const r = repository(d); const before = snapshot(d);
    exactFailure(() => r.applyBalanceDeltasInScope([delta('a', 1n), delta('missing', 1n), delta('missing', -1n)], all));
    expect(snapshot(d)).toBe(before);
    exactFailure(() => r.applyBalanceDeltasInScope([delta('a', 1n)], none)); expect(snapshot(d)).toBe(before);
  });
  it('rejects malformed money, wrong currency and oversized batches without writes', () => {
    const d = v4(); const r = repository(d); const before = snapshot(d);
    for (const bad of [{ ...amount(1n), minor: '01' }, { ...amount(1n), exponent: 0 }, { ...amount(1n), policyVersion: 'wrong' }, { ...amount(1n), minor: '1'.repeat(101) }]) {
      exactFailure(() => r.applyBalanceDeltasInScope([{ accountId: 'a', delta: bad }], all));
    }
    exactFailure(() => r.applyBalanceDeltasInScope([delta('a', 1n, 'BBB')], all));
    exactFailure(() => r.applyBalanceDeltasInScope(Array.from({ length: 1001 }, () => delta('a', 0n)), all));
    expect(snapshot(d)).toBe(before);
  });
  it.each([1, 2, 3])('rolls back a controlled post-update failure at position %i', target => {
    const d = v4(); const before = snapshot(d); const seam = updateSeam(d);
    try {
      const r = repository(d);
      seam.arm((n, result) => { if (n === target) throw new Error('private fixture failure'); return result; });
      exactFailure(() => r.applyBalanceDeltasInScope([delta('a', 1n), delta('b', 1n, 'BBB'), delta('c', 1n, 'CCC')], all));
      expect(seam.count()).toBe(target);
      expect(snapshot(d)).toBe(before);
    } finally { seam.restore(); }
  });
  it.each([0, 2])('rolls back when a real update reports changes=%i', changes => {
    const d = v4(); const before = snapshot(d); const seam = updateSeam(d);
    try {
      const r = repository(d);
      let injected = false;
      seam.arm((n, result) => { if (n === 2) { injected = true; return { ...result, changes }; } return result; });
      exactFailure(() => r.applyBalanceDeltasInScope([delta('a', 1n), delta('b', 1n, 'BBB'), delta('c', 1n, 'CCC')], all));
      expect(injected).toBe(true);
      expect(seam.count()).toBeGreaterThanOrEqual(2);
      expect(seam.count()).toBeLessThanOrEqual(3);
      expect(snapshot(d)).toBe(before);
    } finally { seam.restore(); }
  });
  it('detects persisted first-row tampering and rolls back the whole batch', () => {
    const d = v4(); const before = snapshot(d);
    const tamper = d.prepare('UPDATE accounts SET balance_encrypted=? WHERE id=?');
    const seam = updateSeam(d);
    try {
      const r = repository(d);
      seam.arm((n, result) => { if (n === 3) tamper.run(encryptMoneyMinor(999n, 'AAA', policy, key), 'a'); return result; });
      exactFailure(() => r.applyBalanceDeltasInScope([delta('a', 1n), delta('b', 1n, 'BBB'), delta('c', 1n, 'CCC')], all));
      expect(seam.count()).toBe(3); expect(snapshot(d)).toBe(before);
    } finally { seam.restore(); }
  });
  it('recovers a postwrite failure inside the caller transaction', () => {
    const d = v4(); const before = snapshot(d); const seam = updateSeam(d);
    try {
      const r = repository(d);
      d.exec('BEGIN'); d.prepare('UPDATE accounts SET name=? WHERE id=?').run('sentinel', 'a');
      const callerState = snapshot(d);
      seam.arm((n, result) => { if (n === 2) throw new Error('private nested failure'); return result; });
      exactFailure(() => r.applyBalanceDeltasInScope([delta('a', 1n), delta('b', 1n, 'BBB'), delta('c', 1n, 'CCC')], all));
      expect(seam.count()).toBe(2);
      expect(d.inTransaction).toBe(true);
      expect(snapshot(d)).toBe(callerState);
      expect((d.prepare('SELECT name FROM accounts WHERE id=?').get('a') as any).name).toBe('sentinel');
      d.exec('ROLLBACK'); expect(snapshot(d)).toBe(before);
    } finally { seam.restore(); }
  });
  it('snapshots mutable key, policy and provenance inputs', () => {
    const d = db(); const k = Buffer.from('synthetic-buffer-key');
    const p = { version: 'test-v1', exponents: { AAA: 2, BBB: 0, CCC: 18 } }; const provenance: Record<string, string> = {};
    migrateMoneyOffline(d, k, p, provenance);
    d.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('a', 'A', 'idx', 'AAA', encryptMoneyMinor(10n, 'AAA', p, k), 'old', 'old');
    const r = openExactAccountMoneyRepository(d, k, p, provenance);
    k.fill(0); p.version = 'changed'; p.exponents.AAA = 0; provenance.extra = 'AAA';
    expect(r.getAccountMoneyInScope('a', all)!.balance).toEqual(amount(10n));
    expect(r.applyBalanceDeltasInScope([delta('a', 20n)], all)[0]!.balance).toEqual(amount(30n));
  });
  it('checks TEMP and foreign keys even for empty calls and resumes after restoration', () => {
    const d = v4(); const r = repository(d);
    d.exec('CREATE TEMP TABLE sentinel (id INTEGER)');
    exactFailure(() => r.applyBalanceDeltasInScope([], none));
    d.exec('DROP TABLE temp.sentinel');
    expect(r.applyBalanceDeltasInScope([], none)).toEqual([]);
    d.pragma('foreign_keys = OFF'); exactFailure(() => r.listAccountMoneyInScope(none));
    d.pragma('foreign_keys = ON'); expect(r.listAccountMoneyInScope(none)).toEqual([]);
  });
  it('supports recoverable nested failure and outer rollback of successful updates', () => {
    const d = v4(); const r = repository(d); const before = snapshot(d);
    d.exec('BEGIN'); d.prepare('UPDATE accounts SET name=? WHERE id=?').run('sentinel', 'a');
    exactFailure(() => r.applyBalanceDeltasInScope([delta('missing', 1n)], all));
    expect(d.inTransaction).toBe(true);
    expect((d.prepare('SELECT name FROM accounts WHERE id=?').get('a') as any).name).toBe('sentinel');
    expect(r.applyBalanceDeltasInScope([delta('a', 20n)], all)[0]!.balance).toEqual(amount(30n));
    d.exec('ROLLBACK'); expect(snapshot(d)).toBe(before);
  });
  it('refuses factory construction inside a caller transaction', () => {
    const d = v4(); d.exec('BEGIN');
    d.prepare('UPDATE accounts SET name=? WHERE id=?').run('sentinel', 'a');
    exactFailure(() => repository(d)); expect(d.inTransaction).toBe(true);
    expect((d.prepare('SELECT name FROM accounts WHERE id=?').get('a') as any).name).toBe('sentinel');
    d.exec('ROLLBACK');
  });
});

function financialCipherBytes(d: DB): number {
  const row = d.prepare(`SELECT
    (SELECT COALESCE(SUM(COALESCE(length(CAST(balance_encrypted AS BLOB)), 0) + COALESCE(length(CAST(credit_limit_encrypted AS BLOB)), 0)), 0) FROM main.accounts) +
    (SELECT COALESCE(SUM(COALESCE(length(CAST(amount_encrypted AS BLOB)), 0) + COALESCE(length(CAST(base_amount_encrypted AS BLOB)), 0)), 0) FROM main.transactions) AS bytes`).get() as { bytes: number };
  return row.bytes;
}

function fullMoneyDigest(d: DB): string {
  const hash = createHash('sha256');
  const queries = [
    'SELECT * FROM main.accounts ORDER BY rowid',
    'SELECT * FROM main.transactions ORDER BY rowid',
    'SELECT * FROM main.audit_logs ORDER BY rowid',
    'SELECT * FROM main.schema_migrations ORDER BY rowid',
    'SELECT * FROM main.money_format ORDER BY rowid',
    'SELECT * FROM main.transaction_base_currencies ORDER BY rowid',
    'SELECT type,name,tbl_name,rootpage,sql FROM main.sqlite_schema ORDER BY type,name',
  ];
  for (const sql of queries) {
    hash.update(JSON.stringify(sql) + '\n');
    for (const row of d.prepare(sql).iterate()) hash.update(JSON.stringify(row) + '\n');
  }
  return hash.digest('hex');
}

function nearLimitFixture() {
  const d = db();
  const sizePolicy = { version: 'P'.repeat(64), exponents: { AAA: 18 } };
  const huge = -BigInt('9'.repeat(100));
  migrateMoneyOffline(d, key, sizePolicy, {});
  const zeroCipher = encryptMoneyMinor(0n, 'AAA', sizePolicy, key);
  const maxCipher = encryptMoneyMinor(huge, 'AAA', sizePolicy, key);
  expect(Buffer.byteLength(zeroCipher)).toBe(343);
  expect(Buffer.byteLength(maxCipher)).toBe(543);
  const insert = d.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,iban_encrypted,project_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  d.transaction(() => {
    for (let i = 0; i < 61793; i++) {
      const id = `filler-${i}`;
      insert.run(id, id, `index-${id}`, 'AAA', maxCipher, maxCipher, null, null, 1, 'old', 'old');
    }
    insert.run('target', 'target', 'index-target', 'AAA', zeroCipher, maxCipher, null, null, 1, 'old', 'old');
    insert.run('pad', 'pad', 'index-pad', 'AAA', zeroCipher, zeroCipher, null, null, 1, 'old', 'old');
  })();
  expect((d.prepare('SELECT COUNT(*) AS n FROM main.accounts').get() as { n: number }).n).toBe(61795);
  expect((d.prepare('SELECT COUNT(*) AS n FROM main.transactions').get() as { n: number }).n).toBe(0);
  const bytes = financialCipherBytes(d);
  expect(bytes).toBe(67108770);
  expect(67108864 - bytes).toBe(94);
  expect(bytes + Buffer.byteLength(maxCipher) - Buffer.byteLength(zeroCipher)).toBe(67108970);
  return { d, sizePolicy, huge, zeroCipher, maxCipher };
}

describe('real financial ciphertext aggregate boundary', () => {
  it('rejects projected growth before attempting an account update', () => {
    const { d, sizePolicy, huge } = nearLimitFixture();
    const seam = updateSeam(d);
    const r = openExactAccountMoneyRepository(d, key, sizePolicy, {});
    seam.arm((_n, result) => result);
    const before = fullMoneyDigest(d);
    exactFailure(() => r.applyBalanceDeltasInScope([
      { accountId: 'target', delta: moneyFromMinor(huge, 'AAA', sizePolicy) },
    ], all));
    expect(seam.attempts()).toBe(0);
    expect(seam.count()).toBe(0);
    expect(fullMoneyDigest(d)).toBe(before);
    expect(financialCipherBytes(d)).toBe(67108770);
  }, 30000);

  it('rolls back when the actual aggregate grows beyond the limit after an update', () => {
    const { d, sizePolicy, maxCipher } = nearLimitFixture();
    const padUpdate = d.prepare('UPDATE main.accounts SET credit_limit_encrypted = ? WHERE id = ?');
    const seam = updateSeam(d);
    const r = openExactAccountMoneyRepository(d, key, sizePolicy, {});
    let reached = 0;
    let injected = false;
    let observed = 0;
    seam.arm((n, result) => {
      reached = n;
      if (n === 1) {
        const padResult = padUpdate.run(maxCipher, 'pad');
        injected = padResult.changes === 1;
        observed = financialCipherBytes(d);
      }
      return result;
    });
    const before = fullMoneyDigest(d);
    exactFailure(() => r.applyBalanceDeltasInScope([
      { accountId: 'target', delta: moneyFromMinor(0n, 'AAA', sizePolicy) },
    ], all));
    expect(seam.attempts()).toBe(1);
    expect(seam.count()).toBe(1);
    expect(reached).toBe(1);
    expect(injected).toBe(true);
    expect(observed).toBe(67108970);
    expect(fullMoneyDigest(d)).toBe(before);
    expect(financialCipherBytes(d)).toBe(67108770);
  }, 30000);
});

function historyFixture(migrate = true) {
  const d = db();
  const k = Buffer.alloc(32, 0x61);
  expect(k.length).toBe(32);
  const p = { version: 'test-v1', exponents: { AAA: 2, BBB: 0, CCC: 18 } };
  const provenance = { t: 'BBB' };
  d.prepare('INSERT INTO users (id,username,email,full_name,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('u','user','u@example.invalid','user','hash','old','old');
  d.prepare('INSERT INTO categories (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('c','category','old','old');
  d.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,iban_encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('a','account','idx','AAA',encryptField(10,k),encryptField(0,k),encryptField('iban',k),'old','old');
  d.prepare('INSERT INTO transactions (id,date,amount_encrypted,currency,base_amount_encrypted,category_id,title_encrypted,title_blind_index,created_by_id,created_at,updated_at,status,deleted_at,oto_kasa_transaction_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('t','date',encryptField(2.5,k),'AAA',encryptField(7,k),'c',encryptField('title',k),'t-idx','u','old','old','draft',null,null);
  d.prepare('INSERT INTO audit_logs (id,user_id,action,entity,entity_id,timestamp,diff_encrypted,hash,previous_hash) VALUES (?,?,?,?,?,?,?,?,?)').run('audit','u','update','account','a','old',encryptField(JSON.stringify({ synthetic: true }),k),'synthetic-hash','synthetic-previous');
  expect(d.prepare('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 1 });
  expect(d.prepare('SELECT count(*) AS n FROM transactions').get()).toEqual({ n: 1 });
  expect(d.prepare('SELECT count(*) AS n FROM audit_logs').get()).toEqual({ n: 1 });
  expect(d.pragma('foreign_key_check')).toEqual([]);
  if (migrate) {
    expect(migrateMoneyOffline(d,k,p,provenance).status).toBe('migrated');
    expect(d.prepare('SELECT count(*) AS n FROM transaction_base_currencies').get()).toEqual({ n: 1 });
  } else {
    expect(d.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE type='table' AND name IN ('money_format','transaction_base_currencies')").get()).toEqual({ n: 0 });
  }
  return { d, k, p, provenance };
}

describe('persistent state drift with nonempty history', () => {
  const cases = (['schema', 'history', 'format', 'provenance'] as const).flatMap(kind =>
    (['get', 'list', 'empty', 'apply'] as const).map(operation => ({ kind, operation })));
  it.each(cases)('fails closed after $kind drift on first $operation', ({ kind, operation }) => {
    const { d, k, p, provenance } = historyFixture();
    const seam = updateSeam(d);
    try {
      const r = openExactAccountMoneyRepository(d,k,p,provenance);
      if (kind === 'schema') {
        expect(d.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE type='index' AND name='account_money_drift_idx'").get()).toEqual({ n: 0 });
        d.exec('CREATE INDEX main.account_money_drift_idx ON accounts(updated_at)');
        expect(d.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE type='index' AND name='account_money_drift_idx'").get()).toEqual({ n: 1 });
      } else if (kind === 'history') {
        const old = d.prepare('SELECT applied_at FROM main.schema_migrations WHERE version=?').get(1) as { applied_at: string };
        expect(old).toBeDefined();
        const next = old.applied_at === 'synthetic-drift' ? 'synthetic-drift-2' : 'synthetic-drift';
        expect(d.prepare('UPDATE main.schema_migrations SET applied_at=? WHERE version=?').run(next,1).changes).toBe(1);
        expect(d.prepare('SELECT applied_at FROM main.schema_migrations WHERE version=?').get(1)).toEqual({ applied_at: next });
        expect(next).not.toBe(old.applied_at);
      } else if (kind === 'format') {
        const old = d.prepare('SELECT key_check_encrypted FROM main.money_format WHERE id=1').get() as { key_check_encrypted: string };
        const next = encryptField('costcore:exact-money-v1:key-check',k);
        expect(next).not.toEqual(old.key_check_encrypted);
        expect(d.prepare('UPDATE main.money_format SET key_check_encrypted=? WHERE id=1').run(next).changes).toBe(1);
        expect(d.prepare('SELECT key_check_encrypted FROM main.money_format WHERE id=1').get()).toEqual({ key_check_encrypted: next });
      } else {
        expect(d.prepare('SELECT currency FROM main.transaction_base_currencies WHERE transaction_id=?').get('t')).toEqual({ currency: 'BBB' });
        expect(d.prepare('UPDATE main.transaction_base_currencies SET currency=? WHERE transaction_id=?').run('AAA','t').changes).toBe(1);
        expect(d.prepare('SELECT currency FROM main.transaction_base_currencies WHERE transaction_id=?').get('t')).toEqual({ currency: 'AAA' });
      }
      const afterTamper = snapshot(d);
      seam.arm((_n, result) => result);
      const call = {
        get: () => r.getAccountMoneyInScope('a',all),
        list: () => r.listAccountMoneyInScope(none),
        empty: () => r.applyBalanceDeltasInScope([],none),
        apply: () => r.applyBalanceDeltasInScope([delta('a',1n)],all),
      }[operation];
      exactFailure(call);
      expect(seam.attempts()).toBe(0);
      expect(seam.count()).toBe(0);
      expect(snapshot(d)).toBe(afterTamper);
    } finally { seam.restore(); }
  });
});

describe('nonempty history input preservation', () => {
  it('copies mutable key, policy and provenance without changing unrelated persisted bytes', () => {
    const { d, k, p, provenance } = historyFixture();
    const originalK = Buffer.from(k);
    const originalPolicy = { version: p.version, exponents: { ...p.exponents } };
    const originalProvenance = { ...provenance };
    const r = openExactAccountMoneyRepository(d,k,p,provenance);
    const before = JSON.parse(snapshot(d));
    expect(before.accounts).toHaveLength(1);
    expect(before.transactions).toHaveLength(1);
    expect(before.audit).toHaveLength(1);
    expect(before.provenance).toHaveLength(1);
    k.fill(0);
    p.version = 'mutated';
    p.exponents.AAA = 0;
    provenance.t = 'AAA';
    const initial = moneyFromMinor(1000n,'AAA',originalPolicy);
    const updated = moneyFromMinor(1020n,'AAA',originalPolicy);
    expect(r.getAccountMoneyInScope('a',all)).toEqual(expect.objectContaining({ balance: initial }));
    expect(r.listAccountMoneyInScope(all)).toEqual([expect.objectContaining({ balance: initial })]);
    expect(r.applyBalanceDeltasInScope([{ accountId: 'a', delta: moneyFromMinor(20n,'AAA',originalPolicy) }],all)).toEqual([expect.objectContaining({ balance: updated })]);
    expect(r.getAccountMoneyInScope('a',all)).toEqual(expect.objectContaining({ balance: updated, creditLimit: moneyFromMinor(0n,'AAA',originalPolicy) }));
    expect(r.listAccountMoneyInScope(all)).toEqual([expect.objectContaining({ balance: updated, creditLimit: moneyFromMinor(0n,'AAA',originalPolicy) })]);
    const after = JSON.parse(snapshot(d));
    expect(after.accounts).toHaveLength(1);
    expect(after.transactions).toHaveLength(1);
    expect(after.audit).toHaveLength(1);
    expect(after.provenance).toHaveLength(1);
    expect(after.accounts[0].credit_limit_encrypted).toEqual(before.accounts[0].credit_limit_encrypted);
    const { balance_encrypted: oldBalance, updated_at: oldUpdated, ...oldAccount } = before.accounts[0];
    const { balance_encrypted: newBalance, updated_at: newUpdated, ...newAccount } = after.accounts[0];
    expect(newBalance).not.toEqual(oldBalance);
    expect(newAccount).toEqual(oldAccount);
    expect({ ...after, accounts: undefined }).toEqual({ ...before, accounts: undefined });
    expect(migrateMoneyOffline(d,originalK,originalPolicy,originalProvenance).status).toBe('verified');
  });
});

function observeMoneyWrites(d: DB) {
  const writes: string[] = [];
  const originalExec = d.exec;
  const originalPrepare = d.prepare;
  (d as any).exec = function(sql: string) {
    if (/(?:^|;)\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|REINDEX|VACUUM)\b/i.test(sql)) writes.push('exec');
    return originalExec.call(d,sql);
  };
  (d as any).prepare = function(sql: string) {
    const statement = originalPrepare.call(d,sql);
    const proxy = new Proxy(statement, { get(target, prop) {
      if (prop === 'run' || prop === 'get' || prop === 'all' || prop === 'iterate') {
        return (...args: unknown[]) => {
          if (!target.readonly) writes.push('prepared');
          return Reflect.apply((target as any)[prop],target,args);
        };
      }
      const value = (target as any)[prop];
      return typeof value === 'function' ? (...args: unknown[]) => {
        const returned = value.apply(target,args);
        return returned === target ? proxy : returned;
      } : value;
    }});
    return proxy;
  };
  return { writes, restore() { (d as any).exec = originalExec; (d as any).prepare = originalPrepare; } };
}

describe('verify-only v3 forbidden attempts', () => {
  it('observes real migration writes and encryption but none during v3 verification', () => {
    const control = historyFixture(false);
    const fieldSpy = vi.spyOn(cryptoModule,'encryptField');
    let moneySpy: import('vitest').MockInstance<typeof moneyCodec.encryptMoneyMinor> | undefined;
    let controlObserver: ReturnType<typeof observeMoneyWrites> | undefined;
    let observer: ReturnType<typeof observeMoneyWrites> | undefined;
    try {
      moneySpy = vi.spyOn(moneyCodec,'encryptMoneyMinor');
      controlObserver = observeMoneyWrites(control.d);
      expect(migrateMoneyOffline(control.d,control.k,control.p,control.provenance).status).toBe('migrated');
      expect(controlObserver.writes.length).toBeGreaterThan(0);
      expect(fieldSpy.mock.calls.length).toBeGreaterThan(0);
      expect(moneySpy.mock.calls.length).toBeGreaterThan(0);
      controlObserver.restore();
      controlObserver = undefined;
      const fixture = historyFixture(false);
      observer = observeMoneyWrites(fixture.d);
      fieldSpy.mockClear();
      moneySpy.mockClear();
      const before = snapshot(fixture.d);
      let caught: unknown;
      try { verifyMoneyStore(fixture.d,fixture.k,fixture.p,fixture.provenance); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('Money migration failed');
      expect(Object.hasOwn(caught as object,'cause')).toBe(false);
      expect(observer.writes).toEqual([]);
      expect(moneySpy.mock.calls).toHaveLength(0);
      expect(fieldSpy.mock.calls).toHaveLength(0);
      expect(snapshot(fixture.d)).toBe(before);
      expect(fixture.d.inTransaction).toBe(false);
    } finally {
      observer?.restore();
      controlObserver?.restore();
      moneySpy?.mockRestore();
      fieldSpy.mockRestore();
    }
  });
});


describe('strict scope inputs on every entry point', () => {
  type Case = { label: string; make: (hit: () => void) => unknown };
  const cases: Case[] = [
    { label: 'missing all', make: () => ({}) },
    { label: 'extra own field', make: () => ({ all: true, extra: 1 }) },
    { label: 'inherited all', make: () => Object.create({ all: true }) },
    { label: 'nonplain prototype', make: () => Object.assign(Object.create({}), { all: true }) },
    { label: 'symbol', make: () => ({ all: true, [Symbol('extra')]: 1 }) },
    { label: 'accessor all', make: hit => Object.defineProperty({}, 'all', { enumerable: true, get() { hit(); return true; } }) },
    { label: 'accessor projectIds', make: hit => Object.defineProperty({ all: false }, 'projectIds', { enumerable: true, get() { hit(); return []; } }) },
    { label: 'nonboolean all', make: hit => ({ all: { valueOf() { hit(); return true; } } }) },
    { label: 'all true with projectIds', make: () => ({ all: true, projectIds: [] }) },
    { label: 'missing projectIds', make: () => ({ all: false }) },
    { label: 'nonarray projectIds', make: () => ({ all: false, projectIds: {} }) },
    { label: 'sparse projectIds', make: () => ({ all: false, projectIds: new Array(1) }) },
    { label: 'inherited project index', make: () => { const a = new Array(1); Object.setPrototypeOf(a, Object.assign(Object.create(Array.prototype), { 0: 'p' })); return { all: false, projectIds: a }; } },
    { label: 'accessor project index', make: hit => { const a = ['p']; Object.defineProperty(a, '0', { enumerable: true, get() { hit(); return 'p'; } }); return { all: false, projectIds: a }; } },
    { label: 'arraylike projectIds', make: () => ({ all: false, projectIds: { 0: 'p', length: 1 } }) },
    { label: 'project array extra', make: () => { const a = ['p'] as any; a.extra = 1; return { all: false, projectIds: a }; } },
    { label: 'project array symbol', make: () => { const a = ['p'] as any; a[Symbol('x')] = 1; return { all: false, projectIds: a }; } },
    { label: 'too many project IDs', make: () => ({ all: false, projectIds: Array(100001).fill('p') }) },
    { label: 'blank project ID', make: () => ({ all: false, projectIds: ['  '] }) },
    { label: 'long project ID', make: () => ({ all: false, projectIds: ['x'.repeat(129)] }) },
    { label: 'numeric project ID', make: () => ({ all: false, projectIds: [1] }) },
    { label: 'coercible project ID', make: hit => ({ all: false, projectIds: [{ toString() { hit(); return 'p'; } }] }) },
    { label: 'surrogate project ID', make: () => ({ all: false, projectIds: ['\ud800'] }) },
  ];
  const methods = ['get', 'list', 'empty batch', 'valid batch'] as const;
  it.each(cases.flatMap(c => methods.map(method => ({ ...c, method }))))('$label: $method', ({ make, method }) => {
    let hits = 0;
    const invalid = make(() => { hits++; });
    const batch = [delta('a', 1n)];
    const d = v4();
    const before = snapshot(d);
    const seam = updateSeam(d);
    try {
      const r = repository(d);
      seam.arm((_n, result) => result);
      exactFailure(() => {
        if (method === 'get') return r.getAccountMoneyInScope('a', invalid as any);
        if (method === 'list') return r.listAccountMoneyInScope(invalid as any);
        return r.applyBalanceDeltasInScope(method === 'empty batch' ? [] : batch, invalid as any);
      });
      expect(hits).toBe(0);
      expect(seam.attempts()).toBe(0);
      expect(seam.count()).toBe(0);
      expect(snapshot(d)).toBe(before);
    } finally { seam.restore(); }
  });
});

describe('strict delta, money and account ID inputs', () => {
  type Bad = { label: string; make: (hit: () => void) => unknown };
  const money = () => ({ version: 1, policyVersion: 'test-v1', currency: 'AAA', exponent: 2, minor: '1' });
  const cases: Bad[] = [
    { label: 'missing delta', make: () => [{ accountId: 'a' }] },
    { label: 'missing accountId', make: () => [{ delta: money() }] },
    { label: 'extra delta field', make: () => [{ accountId: 'a', delta: money(), extra: 1 }] },
    { label: 'inherited delta field', make: () => [Object.assign(Object.create({ accountId: 'a' }), { delta: money() })] },
    { label: 'delta symbol', make: () => [{ accountId: 'a', delta: money(), [Symbol('x')]: 1 }] },
    { label: 'delta accessor', make: hit => [Object.defineProperty({ delta: money() }, 'accountId', { enumerable: true, get() { hit(); return 'a'; } })] },
    { label: 'inherited money field', make: () => { const m: any = money(); delete m.minor; return [{ accountId: 'a', delta: Object.assign(Object.create({ minor: '1' }), m) }]; } },
    { label: 'extra money field', make: () => [{ accountId: 'a', delta: { ...money(), extra: 1 } }] },
    { label: 'money symbol', make: () => [{ accountId: 'a', delta: { ...money(), [Symbol('x')]: 1 } }] },
    { label: 'money accessor', make: hit => [{ accountId: 'a', delta: Object.defineProperty(money(), 'minor', { enumerable: true, get() { hit(); return '1'; } }) }] },
    { label: 'wrong version', make: () => [{ accountId: 'a', delta: { ...money(), version: 2 } }] },
    { label: 'wrong version type', make: () => [{ accountId: 'a', delta: { ...money(), version: '1' } }] },
    { label: 'wrong currency', make: () => [{ accountId: 'a', delta: { ...money(), currency: 'BBB' } }] },
    { label: 'wrong currency type', make: () => [{ accountId: 'a', delta: { ...money(), currency: 1 } }] },
    { label: 'wrong exponent', make: () => [{ accountId: 'a', delta: { ...money(), exponent: 0 } }] },
    { label: 'wrong exponent type', make: () => [{ accountId: 'a', delta: { ...money(), exponent: '2' } }] },
    { label: 'wrong policy', make: () => [{ accountId: 'a', delta: { ...money(), policyVersion: 'other' } }] },
    { label: 'wrong policy type', make: () => [{ accountId: 'a', delta: { ...money(), policyVersion: 1 } }] },
    { label: 'numeric minor', make: () => [{ accountId: 'a', delta: { ...money(), minor: 1 } }] },
    { label: 'negative zero', make: () => [{ accountId: 'a', delta: { ...money(), minor: '-0' } }] },
    { label: 'leading zero', make: () => [{ accountId: 'a', delta: { ...money(), minor: '01' } }] },
    { label: '101 digits', make: () => [{ accountId: 'a', delta: { ...money(), minor: '9'.repeat(101) } }] },
    { label: 'invalid zero cannot skip validation', make: () => [{ accountId: 'a', delta: { ...money(), minor: '0', extra: true } }] },
    { label: 'invalid cancelling entry cannot skip validation', make: () => [delta('a', 1n), { accountId: 'a', delta: { ...money(), minor: '-1', extra: true } }] },
    { label: 'sparse delta array', make: () => new Array(1) },
    { label: 'inherited delta index', make: () => { const a = new Array(1); Object.setPrototypeOf(a, Object.assign(Object.create(Array.prototype), { 0: delta('a', 1n) })); return a; } },
    { label: 'accessor delta index', make: hit => { const a = [delta('a', 1n)]; Object.defineProperty(a, '0', { enumerable: true, get() { hit(); return delta('a', 1n); } }); return a; } },
    { label: 'arraylike deltas', make: () => ({ 0: delta('a', 1n), length: 1 }) },
    { label: 'delta array extra', make: () => { const a = [delta('a', 1n)] as any; a.extra = 1; return a; } },
    { label: 'delta array symbol', make: () => { const a = [delta('a', 1n)] as any; a[Symbol('x')] = 1; return a; } },
    { label: 'blank account ID', make: () => [{ accountId: '  ', delta: money() }] },
    { label: 'long account ID', make: () => [{ accountId: 'x'.repeat(129), delta: money() }] },
    { label: 'numeric account ID', make: () => [{ accountId: 1, delta: money() }] },
    { label: 'coercible account ID', make: hit => [{ accountId: { toString() { hit(); return 'a'; } }, delta: money() }] },
    { label: 'surrogate account ID', make: () => [{ accountId: '\ud800', delta: money() }] },
  ];
  it.each(cases)('$label', ({ make }) => {
    let hits = 0;
    const input = make(() => { hits++; });
    const d = v4(); const before = snapshot(d); const seam = updateSeam(d);
    try {
      const r = repository(d); seam.arm((_n, result) => result);
      exactFailure(() => r.applyBalanceDeltasInScope(input as any, all));
      expect(hits).toBe(0); expect(seam.attempts()).toBe(0); expect(seam.count()).toBe(0);
      expect(snapshot(d)).toBe(before);
    } finally { seam.restore(); }
  });
  const ids: Bad[] = [
    { label: 'blank', make: () => '  ' },
    { label: '129 units', make: () => 'x'.repeat(129) },
    { label: 'number', make: () => 1 },
    { label: 'coercible', make: hit => ({ toString() { hit(); return 'a'; } }) },
    { label: 'lone surrogate', make: () => '\ud800' },
  ];
  it.each(ids)('get rejects $label account ID', ({ make }) => {
    let hits = 0; const id = make(() => { hits++; });
    const d = v4(); const before = snapshot(d); const seam = updateSeam(d);
    try {
      const r = repository(d); seam.arm((_n, result) => result);
      exactFailure(() => r.getAccountMoneyInScope(id as any, all));
      expect(hits).toBe(0); expect(seam.attempts()).toBe(0); expect(seam.count()).toBe(0);
      expect(snapshot(d)).toBe(before);
    } finally { seam.restore(); }
  });
});

describe('exact 100-digit boundaries', () => {
  const H = BigInt('9'.repeat(100));
  function seed(d: DB, id: string, n: bigint, currency = 'AAA') {
    d.prepare('UPDATE accounts SET balance_encrypted = ? WHERE id = ?').run(encryptMoneyMinor(n, currency, policy, key), id);
  }
  it.each([H, -H])('reads a real encrypted 100-digit balance %s', n => {
    const d = v4(); seed(d, 'a', n);
    const stored = d.prepare('SELECT balance_encrypted FROM accounts WHERE id = ?').get('a') as { balance_encrypted: string };
    expect(moneyCodec.decryptMoneyMinor(stored.balance_encrypted, 'AAA', policy, key)).toBe(n);
    const r = repository(d);
    expect(r.getAccountMoneyInScope('a', all)).toMatchObject({ balance: { minor: n.toString() } });
  });
  it('rejects final overflow before any update', () => {
    const d = v4(); seed(d, 'a', H);
    const batch = [delta('a', 1n)]; const before = snapshot(d); const seam = updateSeam(d);
    try {
      const r = repository(d); seam.arm((_n, result) => result);
      exactFailure(() => r.applyBalanceDeltasInScope(batch, all));
      expect(seam.attempts()).toBe(0); expect(seam.count()).toBe(0); expect(snapshot(d)).toBe(before);
    } finally { seam.restore(); }
  });
  it('allows an intermediate 101-digit sum when the final sum fits', () => {
    const d = v4(); seed(d, 'a', 0n);
    const batch = [delta('a', H), delta('a', H), delta('a', -H)]; const seam = updateSeam(d);
    try {
      const r = repository(d); seam.arm((_n, result) => result);
      const result = r.applyBalanceDeltasInScope(batch, all);
      expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ balance: { minor: H.toString() } });
      expect(seam.attempts()).toBe(1); expect(seam.count()).toBe(1);
      const stored = d.prepare('SELECT balance_encrypted FROM accounts WHERE id = ?').get('a') as { balance_encrypted: string };
      expect(moneyCodec.decryptMoneyMinor(stored.balance_encrypted, 'AAA', policy, key)).toBe(H);
    } finally { seam.restore(); }
  });
  it.each([
    { id: 'a', currency: 'AAA', changes: [10n, 20n], expected: '30' },
    { id: 'b', currency: 'BBB', changes: [1n, -1n, -1n], expected: '-1' },
    { id: 'c', currency: 'CCC', changes: [-1n, 1n, 1n], expected: '1' },
  ])('uses exact minor units for $currency', ({ id, currency, changes, expected }) => {
    const d = v4(); seed(d, id, 0n, currency);
    const batch = changes.map(n => delta(id, n, currency));
    const result = repository(d).applyBalanceDeltasInScope(batch, all);
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ balance: { minor: expected } });
    const stored = d.prepare('SELECT balance_encrypted FROM accounts WHERE id = ?').get(id) as { balance_encrypted: string };
    expect(moneyCodec.decryptMoneyMinor(stored.balance_encrypted, currency, policy, key)).toBe(BigInt(expected));
  });
});

describe('exact ID preservation and UTF-16 ordering', () => {
  it('preserves 128-unit and padded account and project IDs', () => {
    const d = v4();
    const long = 'x'.repeat(128); const padded = ' padded '; const plain = 'padded';
    const project = d.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)');
    const insert = d.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,iban_encrypted,project_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const [id, n] of [[long, 11n], [padded, 22n], [plain, 33n]] as const) {
      project.run(id, 'Synthetic', 'old', 'old');
      insert.run(id, 'Synthetic', `index-${id}`, 'AAA', encryptMoneyMinor(n, 'AAA', policy, key), null, null, id, 1, 'old', 'old');
    }
    const r = repository(d);
    for (const [id, n] of [[long, 11n], [padded, 22n], [plain, 33n]] as const) {
      const scope = { all: false as const, projectIds: [id] };
      expect(r.getAccountMoneyInScope(id, scope)).toMatchObject({ accountId: id, balance: { minor: n.toString() } });
      expect(r.listAccountMoneyInScope(scope)).toEqual([expect.objectContaining({ accountId: id, balance: expect.objectContaining({ minor: n.toString() }) })]);
      expect(r.applyBalanceDeltasInScope([delta(id, 1n)], scope)).toEqual([expect.objectContaining({ accountId: id, balance: expect.objectContaining({ minor: (n + 1n).toString() }) })]);
    }
  });
  it('orders astral before BMP in JS despite the opposite SQLite binary order', () => {
    const d = v4(); const astral = '\u{10000}'; const bmp = '\uE000';
    const insert = d.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,iban_encrypted,project_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    insert.run(astral, 'Astral', 'astral-index', 'AAA', encryptMoneyMinor(1n, 'AAA', policy, key), null, null, null, 1, 'old', 'old');
    insert.run(bmp, 'BMP', 'bmp-index', 'AAA', encryptMoneyMinor(2n, 'AAA', policy, key), null, null, null, 1, 'old', 'old');
    const sql = d.prepare('SELECT id FROM accounts WHERE id IN (?,?) ORDER BY id COLLATE BINARY').all(astral, bmp) as { id: string }[];
    expect(sql.map(row => row.id)).toEqual([bmp, astral]);
    const r = repository(d);
    const list = r.listAccountMoneyInScope(all).map(row => row.accountId).filter(id => id === astral || id === bmp);
    expect(list).toEqual([astral, bmp]);
    const batch = [delta(bmp, 1n), delta(astral, 1n)];
    expect(r.applyBalanceDeltasInScope(batch, all).map(row => row.accountId)).toEqual([astral, bmp]);
  });
});

function fileFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'costcore-exact-money-'));
  const filename = join(directory, 'synthetic.sqlite');
  let a: DB | undefined; let b: DB | undefined;
  const cleanup = () => {
    try {
      try { if (b?.open) b.close(); } finally { if (a?.open) a.close(); }
    } finally {
      try { if (existsSync(filename)) unlinkSync(filename); } finally { rmdirSync(directory); }
    }
  };
  try {
    expect(dirname(filename)).toBe(directory);
    expect(basename(filename)).toBe('synthetic.sqlite');
    a = new Database(filename, { timeout: 0 });
    a.pragma('foreign_keys = ON'); a.pragma('journal_mode = DELETE'); a.pragma('busy_timeout = 0');
    runMigrations(a); migrateMoneyOffline(a, key, policy, {});
    a.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,iban_encrypted,project_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('a', 'A', 'a-index', 'AAA', encryptMoneyMinor(10n, 'AAA', policy, key), null, null, null, 1, 'old', 'old');
    b = new Database(filename, { timeout: 0 });
    b.pragma('foreign_keys = ON'); b.pragma('journal_mode = DELETE'); b.pragma('busy_timeout = 0');
    return { a, b, filename, directory, cleanup };
  } catch (error) { cleanup(); throw error; }
}

describe('real separate writer contention', () => {
  it('sanitizes entry failures and permits retry after release', () => {
    const { a, b, filename, directory, cleanup } = fileFixture();
    let seam: ReturnType<typeof updateSeam> | undefined;
    try {
      expect(dirname(filename)).toBe(directory);
      expect(b.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(b.pragma('journal_mode', { simple: true })).toBe('delete');
      expect((b.prepare('SELECT count(*) AS n FROM accounts').get() as { n: number }).n).toBe(1);
      expect(b.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'money_format'").get()).toBeTruthy();
      const initial = b.prepare('SELECT balance_encrypted FROM accounts WHERE id = ?').get('a') as { balance_encrypted: string };
      expect(moneyCodec.decryptMoneyMinor(initial.balance_encrypted, 'AAA', policy, key)).toBe(10n);
      const batch = [delta('a', 1n)]; const before = snapshot(b);
      seam = updateSeam(b);
      const r = repository(b); seam.arm((_n, result) => result);
      a.exec('BEGIN IMMEDIATE'); expect(a.inTransaction).toBe(true);
      let busy: unknown;
      try { b.exec('BEGIN IMMEDIATE'); } catch (error) { busy = error; }
      expect(busy).toBeInstanceOf(Error);
      expect((busy as { code?: string }).code).toBe('SQLITE_BUSY');
      expect(b.inTransaction).toBe(false);
      const sanitized = (fn: () => unknown, message: string) => {
        let caught: unknown;
        try { fn(); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe(message);
        expect(Object.hasOwn(caught as object, 'cause')).toBe(false);
        if (Object.hasOwn(caught as object, 'code')) expect((caught as { code: unknown }).code).toBe('SQLITE_BUSY');
        expect(b.inTransaction).toBe(false);
        expect(snapshot(b)).toBe(before);
        expect(seam!.attempts()).toBe(0); expect(seam!.count()).toBe(0);
      };
      sanitized(() => verifyMoneyStore(b, key, policy, {}), 'Money migration failed');
      sanitized(() => repository(b), failure);
      sanitized(() => r.applyBalanceDeltasInScope(batch, all), failure);
      a.exec('ROLLBACK'); expect(a.inTransaction).toBe(false);
      expect(() => verifyMoneyStore(b, key, policy, {})).not.toThrow();
      expect(() => repository(b)).not.toThrow();
      expect(r.applyBalanceDeltasInScope(batch, all)).toEqual([expect.objectContaining({ accountId: 'a', balance: expect.objectContaining({ minor: '11' }) })]);
      expect(seam.attempts()).toBe(1); expect(seam.count()).toBe(1);
      const persisted = b.prepare('SELECT balance_encrypted FROM accounts WHERE id = ?').get('a') as { balance_encrypted: string };
      expect(moneyCodec.decryptMoneyMinor(persisted.balance_encrypted, 'AAA', policy, key)).toBe(11n);
    } finally { try { seam?.restore(); } finally { cleanup(); } }
  }, 30000);
});


describe('batch target prevalidation before any update', () => {
  it('rejects a missing cancelling target alongside a valid target', () => {
    const d = v4();
    const seam = updateSeam(d);
    try {
      const r = repository(d);
      seam.arm((_n, result) => result);
      const batch = [delta('a', 1n), delta('missing', 2n), delta('missing', -2n)];
      const before = snapshot(d);
      exactFailure(() => r.applyBalanceDeltasInScope(batch, all));
      expect(seam.attempts()).toBe(0);
      expect(seam.count()).toBe(0);
      expect(snapshot(d)).toBe(before);
    } finally {
      seam.restore();
    }
  });

  it('rejects an inaccessible target alongside a valid scoped target', () => {
    const d = v4();
    const seam = updateSeam(d);
    try {
      const r = repository(d);
      seam.arm((_n, result) => result);
      const batch = [delta('a', 1n), delta('b', 1n, 'BBB')];
      const before = snapshot(d);
      exactFailure(() => r.applyBalanceDeltasInScope(batch, scoped));
      expect(seam.attempts()).toBe(0);
      expect(seam.count()).toBe(0);
      expect(snapshot(d)).toBe(before);
    } finally {
      seam.restore();
    }
  });
});
