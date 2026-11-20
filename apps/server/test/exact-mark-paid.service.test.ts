import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogRepository, decryptMoneyMinor, encryptMoneyMinor, initDatabase } from '@cost-core/database';
import { decryptField, encryptField } from '@cost-core/crypto';
import { moneyFromMinor } from '@cost-core/types';
import { migrateMoneyOffline } from '@cost-core/database/dist/money-migration.js';
import { ExactExpensePaidError, markExactExpensePaid } from '../src/services/exact-mark-paid.service.js';

const key = 'synthetic-test-key';
const policy = { version: 'test-v1', exponents: { AAA: 2, BBB: 0 } };
const provenance = { tx: 'BBB' };
const context = { key, policy, provenance };
const expiry = 4000000000;
const input = { transactionId: 'tx', actor: { userId: 'user', sessionId: 'session', originalExpiresAt: expiry } };
const opened: ReturnType<typeof initDatabase>[] = [];
afterEach(() => { while (opened.length) opened.pop()!.sqlite.close(); });

function fixture(trigger?: string, options: { path?: string; key?: typeof key | Buffer; policy?: typeof policy; provenance?: Record<string, string>; preMigration?: (s: ReturnType<typeof initDatabase>['sqlite'], legacy: string) => void } = {}) {
  const key = options.key ?? context.key;
  const policy = options.policy ?? context.policy;
  const provenance = options.provenance ?? context.provenance;
  const instance = initDatabase({ path: options.path ?? ':memory:' }); opened.push(instance);
  const { db, sqlite: s } = instance;
  s.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('p', 'P', 'old', 'old');
  s.prepare('INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('q', 'Q', 'old', 'old');
  s.prepare('INSERT INTO users (id,username,email,full_name,password_hash,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('user', 'user', 'user@example.test', 'Synthetic', 'synthetic', 'manager', 1, 'old', 'old');
  s.prepare('INSERT INTO auth_sessions (id,user_id,created_at,expires_at) VALUES (?,?,?,?)').run('session', 'user', 1, expiry);
  s.prepare('INSERT INTO project_memberships (user_id,project_id,created_at) VALUES (?,?,?)').run('user', 'p', 'old');
  s.prepare('INSERT INTO project_memberships (user_id,project_id,created_at) VALUES (?,?,?)').run('user', 'q', 'old');
  const legacy = encryptField(1, key);
  s.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,project_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('wallet', 'Wallet', 'index', 'AAA', legacy, legacy, 'p', 1, 'old', 'old');
  s.prepare('INSERT INTO transactions (id,project_id,type,date,amount_encrypted,currency,base_amount_encrypted,category_id,title_encrypted,title_blind_index,account_from_id,account_to_id,payment_source,oto_kasa_transaction_id,is_paid,status,created_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('tx', 'p', 'expense', 'date', legacy, 'AAA', legacy, 'category', 'title', 'index', 'wallet', null, 'company_account', null, 0, 'pending', 'user', 'old', 'old');
  options.preMigration?.(s, legacy);
  migrateMoneyOffline(s, key, policy, provenance);
  s.prepare('UPDATE accounts SET balance_encrypted=?,credit_limit_encrypted=? WHERE id=?').run(encryptMoneyMinor(1000000000000000000000n, 'AAA', policy, key), encryptMoneyMinor(17n, 'AAA', policy, key), 'wallet');
  s.prepare('UPDATE transactions SET amount_encrypted=?,base_amount_encrypted=? WHERE id=?').run(encryptMoneyMinor(900719925474099312345n, 'AAA', policy, key), encryptMoneyMinor(42n, 'BBB', policy, key), 'tx');
  if (trigger) s.exec(trigger);
  const snapshot = () => JSON.stringify({ schema: s.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all(), accounts: s.prepare('SELECT * FROM main.accounts ORDER BY rowid').all(), transactions: s.prepare('SELECT * FROM main.transactions ORDER BY rowid').all(), audit: s.prepare('SELECT * FROM main.audit_logs ORDER BY rowid').all(), format: s.prepare('SELECT * FROM main.money_format ORDER BY rowid').all(), provenance: s.prepare('SELECT * FROM main.transaction_base_currencies ORDER BY rowid').all(), history: s.prepare('SELECT * FROM main.schema_migrations ORDER BY rowid').all(), users: s.prepare('SELECT * FROM main.users ORDER BY rowid').all(), sessions: s.prepare('SELECT * FROM main.auth_sessions ORDER BY rowid').all(), memberships: s.prepare('SELECT * FROM main.project_memberships ORDER BY rowid').all(), projects: s.prepare('SELECT * FROM main.projects ORDER BY rowid').all() });
  return { db, s, snapshot, fixtureContext: { key, policy, provenance } };
}
function fails(fn: () => unknown, reason: string) {
  let caught: unknown;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(ExactExpensePaidError);
  expect(caught).toMatchObject({ reason, message: 'Exact expense payment operation failed' });
  expect(Object.hasOwn(caught as object, 'cause')).toBe(false);
}

describe('atomic exact expense mark-paid', () => {
  it('debits exact native minor units and records a compatible encrypted audit, then makes a byte-identical no-op', () => {
    const { db, s, snapshot } = fixture();
    const audit = new AuditLogRepository(db);
    audit.logAction({ userId: 'user', action: 'UPDATE', entity: 'legacy', entityId: 'old', previousState: { value: 1 }, newState: { value: 2 } }, key);
    const beforeBytes = JSON.parse(snapshot());
    const prior = s.prepare('SELECT * FROM transactions WHERE id=?').get('tx') as any;
    const oldAccount = s.prepare('SELECT * FROM accounts WHERE id=?').get('wallet') as any;
    const result = markExactExpensePaid(db, context, input);
    expect(result.changed).toBe(true);
    expect(result.transaction).toMatchObject({ transactionId: 'tx', status: 'approved', isPaid: true, amount: moneyFromMinor(900719925474099312345n, 'AAA', policy), baseCurrency: 'BBB', baseAmount: moneyFromMinor(42n, 'BBB', policy) });
    const transaction = s.prepare('SELECT * FROM transactions WHERE id=?').get('tx') as any;
    const account = s.prepare('SELECT * FROM accounts WHERE id=?').get('wallet') as any;
    expect(transaction.amount_encrypted).toBe(prior.amount_encrypted);
    expect(transaction.base_amount_encrypted).toBe(prior.base_amount_encrypted);
    expect(transaction.currency).toBe(prior.currency);
    expect(transaction.exchange_rate).toBe(prior.exchange_rate);
    expect(account.credit_limit_encrypted).toBe(oldAccount.credit_limit_encrypted);
    expect(decryptMoneyMinor(account.balance_encrypted, 'AAA', policy, key)).toBe(99280074525900687655n);
    const row = s.prepare('SELECT * FROM audit_logs ORDER BY rowid DESC LIMIT 1').get() as any;
    expect(row).toMatchObject({ user_id: 'user', action: 'UPDATE', entity: 'transaction', entity_id: 'tx' });
    const diff = decryptField<any>(row.diff_encrypted, key);
    const expectedBefore = { transactionId: 'tx', projectId: 'p', type: 'expense', status: 'pending', paymentSource: 'company_account', isPaid: false, currency: 'AAA', amount: moneyFromMinor(900719925474099312345n, 'AAA', policy), baseCurrency: 'BBB', baseAmount: moneyFromMinor(42n, 'BBB', policy), accountFromId: 'wallet', accountToId: null, otoKasaTransactionId: null, deletedAt: null, updatedAt: 'old' };
    expect(diff.previousState).toEqual({ snapshotVersion: 1, command: 'mark-paid', transactions: [expectedBefore], accounts: [{ accountId: 'wallet', currency: 'AAA', balance: moneyFromMinor(1000000000000000000000n, 'AAA', policy) }] });
    expect(diff.newState).toEqual({ snapshotVersion: 1, command: 'mark-paid', transactions: [{ ...expectedBefore, status: 'approved', isPaid: true, updatedAt: transaction.updated_at }], accounts: [{ accountId: 'wallet', currency: 'AAA', balance: moneyFromMinor(99280074525900687655n, 'AAA', policy) }] });
    expect(diff.previousState).toMatchObject({ snapshotVersion: 1, command: 'mark-paid', transactions: [{ transactionId: 'tx', isPaid: false }], accounts: [{ accountId: 'wallet', currency: 'AAA', balance: moneyFromMinor(1000000000000000000000n, 'AAA', policy) }] });
    expect(diff.newState).toMatchObject({ snapshotVersion: 1, command: 'mark-paid', transactions: [{ transactionId: 'tx', isPaid: true }], accounts: [{ accountId: 'wallet', currency: 'AAA', balance: moneyFromMinor(99280074525900687655n, 'AAA', policy) }] });
    expect(audit.verifyChainIntegrity(key)).toEqual({ valid: true, count: 2 });
    const afterBytes = JSON.parse(snapshot());
    expect(afterBytes).toEqual({ ...beforeBytes, accounts: [{ ...beforeBytes.accounts[0], balance_encrypted: account.balance_encrypted, updated_at: account.updated_at }], transactions: [{ ...beforeBytes.transactions[0], is_paid: 1, status: 'approved', updated_at: transaction.updated_at }], audit: [...beforeBytes.audit, row] });
    const paid = snapshot();
    expect(markExactExpensePaid(db, context, input).changed).toBe(false);
    expect(snapshot()).toBe(paid);
  });
  it.each(['draft', 'pending_approval', 'rejected', 'cancelled', 'paid'])('rejects unsupported unpaid status %s without writes', status => {
    const { db, s, snapshot } = fixture();
    s.prepare('UPDATE transactions SET status=? WHERE id=?').run(status, 'tx');
    const before = snapshot(); fails(() => markExactExpensePaid(db, context, input), 'CONFLICT'); expect(snapshot()).toBe(before);
  });
  it('requires the current wallet to belong to the transaction project despite two memberships', () => {
    const { db, s, snapshot } = fixture();
    s.prepare('UPDATE accounts SET project_id=? WHERE id=?').run('q', 'wallet');
    const before = snapshot(); fails(() => markExactExpensePaid(db, context, input), 'CONFLICT'); expect(snapshot()).toBe(before);
  });
  it.each(["RAISE(ABORT, 'synthetic')", 'RAISE(IGNORE)'])('rolls back account and transaction writes when audit insert uses %s', failure => {
    const { db, s, snapshot } = fixture(`CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT observe_audit(); SELECT ${failure}; END`);
    let triggerCalls = 0;
    s.function('observe_audit', () => { triggerCalls++; return 0; });
    const before = snapshot();
    const calls = observeWrites(s);
    fails(() => markExactExpensePaid(db, context, input), 'FAILED');
    expect(calls.account).toBe(1); expect(calls.transaction).toBe(1); expect(calls.auditAttempt).toBe(1);
    expect(triggerCalls).toBe(1); expect(snapshot()).toBe(before);
  });
  it.each([
    "UPDATE accounts SET balance_encrypted=(SELECT amount_encrypted FROM transactions WHERE id='tx') WHERE id='wallet';",
    "UPDATE transactions SET is_paid=0 WHERE id='tx';",
  ])('rolls back a valid audit insert followed by financial target mutation', mutation => {
    const { db, s, snapshot } = fixture(`CREATE TRIGGER synthetic_audit_mutation AFTER INSERT ON audit_logs BEGIN SELECT observe_audit(); ${mutation} END`);
    let triggerCalls = 0;
    s.function('observe_audit', () => { triggerCalls++; return 0; });
    const before = snapshot();
    const calls = observeWrites(s);
    fails(() => markExactExpensePaid(db, context, input), 'FAILED');
    expect(calls.account).toBe(1); expect(calls.transaction).toBe(1); expect(calls.auditAttempt).toBe(1); expect(calls.auditSuccess).toBe(1);
    expect(triggerCalls).toBe(1); expect(snapshot()).toBe(before);
  });
});

describe('exact payment regression gates', () => {
  it('rejects a currency policy key with a trailing line feed without changing bytes', () => {
    const { db, snapshot } = fixture();
    const before = snapshot();
    const badContext = { key, policy: { version: 'test-v1', exponents: { AAA: 2, BBB: 0, 'CCC\n': 2 } }, provenance };
    fails(() => markExactExpensePaid(db, badContext, input), 'INVALID_INPUT');
    expect(snapshot()).toBe(before);
  });

  it.each([false, true])('rolls back an intervening persisted predecessor with high rowid=%s', highRowid => {
    const { db, s, snapshot } = fixture(`CREATE TRIGGER synthetic_intervening BEFORE INSERT ON audit_logs WHEN NEW.id != 'synthetic-intervening' BEGIN SELECT observe_intervening(); INSERT INTO audit_logs (id,user_id,action,entity,entity_id,diff_encrypted,previous_hash,hash,timestamp,ip_address,user_agent) SELECT 'synthetic-intervening', user_id, action, entity, entity_id, diff_encrypted, previous_hash, hash, timestamp, ip_address, user_agent FROM audit_logs ORDER BY rowid DESC LIMIT 1; END`);
    let triggerCalls = 0;
    s.function('observe_intervening', () => { triggerCalls++; return 0; });
    // The seed append sees an empty audit table; its trigger inserts no row.
    new AuditLogRepository(db).logAction({ userId: 'user', action: 'UPDATE', entity: 'legacy', entityId: 'old', previousState: { value: 1 }, newState: { value: 2 } }, key);
    if (highRowid) s.prepare('UPDATE audit_logs SET rowid=?').run(9007199254740991n);
    triggerCalls = 0;
    const before = snapshot();
    const reached: string[] = [];
    const originalPrepare = s.prepare.bind(s);
    (s as any).prepare = (sql: string) => {
      const statement = originalPrepare(sql);
      return new Proxy(statement, { get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'run') return (...args: unknown[]) => { reached.push(sql); return value.apply(target, args); };
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    fails(() => markExactExpensePaid(db, context, input), 'FAILED');
    expect(reached.some(sql => /UPDATE\s+(?:main\.)?["`\[]?accounts/i.test(sql))).toBe(true);
    expect(reached.some(sql => /UPDATE\s+(?:main\.)?["`\[]?transactions/i.test(sql))).toBe(true);
    expect(reached.some(sql => /INSERT\s+INTO\s+(?:main\.)?["`\[]?audit_logs/i.test(sql))).toBe(true);
    expect(triggerCalls).toBe(1);
    expect(snapshot()).toBe(before);
  });
});

describe('fresh authorization on both payment paths', () => {
  const cases: Array<{ name: string; sql: string; reason: string; boundary?: boolean }> = [
    { name: 'role downgraded', sql: "UPDATE users SET role='viewer' WHERE id='user'", reason: 'FORBIDDEN' },
    { name: 'inactive user', sql: "UPDATE users SET is_active=0 WHERE id='user'", reason: 'INVALID_SESSION' },
    { name: 'deleted user', sql: "DELETE FROM users WHERE id='user'", reason: 'INVALID_SESSION' },
    { name: 'wrong session owner', sql: "UPDATE auth_sessions SET user_id='other' WHERE id='session'", reason: 'INVALID_SESSION' },
    { name: 'revoked session', sql: "UPDATE auth_sessions SET revoked_at=1 WHERE id='session'", reason: 'INVALID_SESSION' },
    { name: 'deleted session', sql: "DELETE FROM auth_sessions WHERE id='session'", reason: 'INVALID_SESSION' },
    { name: 'expiry mismatch', sql: "UPDATE auth_sessions SET expires_at=3999999999 WHERE id='session'", reason: 'INVALID_SESSION' },
    { name: 'expiry boundary', sql: "UPDATE auth_sessions SET expires_at=? WHERE id='session'", reason: 'INVALID_SESSION', boundary: true },
    { name: 'membership removed', sql: "DELETE FROM project_memberships WHERE user_id='user' AND project_id='p'", reason: 'NOT_FOUND' },
  ];
  for (const paid of [false, true]) {
    for (const scenario of cases) {
      it(`rejects ${scenario.name} for ${paid ? 'already-paid' : 'unpaid'} transaction`, () => {
        const { db, s, snapshot } = fixture();
        if (paid) s.prepare("UPDATE transactions SET is_paid=1,status='approved' WHERE id='tx'").run();
        if (scenario.name === 'wrong session owner') s.prepare('INSERT INTO users (id,username,email,full_name,password_hash,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('other', 'other', 'other@example.test', 'Other', 'synthetic', 'manager', 1, 'old', 'old');
        if (scenario.name === 'deleted user') {
          s.prepare('INSERT INTO users (id,username,email,full_name,password_hash,role,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('other', 'other', 'other@example.test', 'Other', 'synthetic', 'manager', 1, 'old', 'old');
          s.prepare("UPDATE transactions SET created_by_id='other' WHERE created_by_id='user'").run();
          s.prepare("DELETE FROM project_memberships WHERE user_id='user'").run();
          s.prepare("DELETE FROM auth_sessions WHERE user_id='user'").run();
        }
        const boundary = 1900000000;
        if (scenario.boundary) { vi.useFakeTimers(); vi.setSystemTime(boundary * 1000); }
        try {
          if (scenario.boundary) s.prepare(scenario.sql).run(boundary); else s.prepare(scenario.sql).run();
          const request = scenario.boundary ? { ...input, actor: { ...input.actor, originalExpiresAt: boundary } } : input;
          const before = snapshot();
          fails(() => markExactExpensePaid(db, context, request), scenario.reason);
          expect(snapshot()).toBe(before);
        } finally { if (scenario.boundary) vi.useRealTimers(); }
      });
    }
  }
});

function observeWrites(s: ReturnType<typeof initDatabase>['sqlite']) {
  const calls = { account: 0, transaction: 0, auditAttempt: 0, auditSuccess: 0 };
  const prepare = s.prepare.bind(s);
  (s as any).prepare = (sql: string) => {
    const statement = prepare(sql);
    return new Proxy(statement, { get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === 'run') return (...args: unknown[]) => {
        const account = /UPDATE\s+(?:main\.)?["`\[]?accounts/i.test(sql);
        const transaction = /UPDATE\s+(?:main\.)?["`\[]?transactions/i.test(sql);
        const audit = /INSERT\s+INTO\s+(?:main\.)?["`\[]?audit_logs/i.test(sql);
        if (audit) calls.auditAttempt++;
        const result = value.apply(target, args);
        if (account && result.changes === 1) calls.account++;
        if (transaction && result.changes === 1) calls.transaction++;
        if (audit && result.changes === 1) calls.auditSuccess++;
        return result;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  return calls;
}

describe('domain preservation on both payment paths', () => {
  const cases = [
    { name: 'income', sql: "UPDATE transactions SET type='income' WHERE id='tx'" },
    { name: 'transfer', sql: "UPDATE transactions SET type='transfer' WHERE id='tx'" },
    { name: 'person payment', sql: "UPDATE transactions SET payment_source='person_out_of_pocket' WHERE id='tx'" },
    { name: 'walletless', sql: "UPDATE transactions SET account_from_id=NULL WHERE id='tx'" },
    { name: 'destination account present', sql: "UPDATE transactions SET account_to_id='wallet' WHERE id='tx'" },
    { name: 'inactive wallet', sql: "UPDATE accounts SET is_active=0 WHERE id='wallet'" },
    { name: 'wallet in another project', sql: "UPDATE accounts SET project_id='q' WHERE id='wallet'" },
    { name: 'unsupported status', sql: "UPDATE transactions SET status='rejected' WHERE id='tx'" },
  ];
  for (const paid of [false, true]) for (const scenario of cases) {
    it(`rejects ${scenario.name} for ${paid ? 'paid' : 'unpaid'} without writes`, () => {
      const { db, s, snapshot } = fixture();
      if (paid) s.prepare("UPDATE transactions SET is_paid=1,status='approved' WHERE id='tx'").run();
      s.prepare(scenario.sql).run();
      const before = snapshot();
      fails(() => markExactExpensePaid(db, context, input), 'CONFLICT');
      expect(snapshot()).toBe(before);
    });
  }
  it.each(['pending', 'approved', 'paid'])('leaves an already-paid %s transaction byte-identical', status => {
    const { db, s, snapshot } = fixture();
    s.prepare('UPDATE transactions SET is_paid=1,status=? WHERE id=?').run(status, 'tx');
    const before = snapshot();
    expect(markExactExpensePaid(db, context, input).changed).toBe(false);
    expect(snapshot()).toBe(before);
  });
  it('accepts null-prototype input and actor records', () => {
    const { db } = fixture();
    const actor = Object.assign(Object.create(null), input.actor);
    const request = Object.assign(Object.create(null), { transactionId: 'tx', actor });
    expect(markExactExpensePaid(db, context, request).changed).toBe(true);
  });
});

describe('strict input boundaries', () => {
  it('rejects an accessor without executing it', () => {
    const { db, snapshot } = fixture();
    let invoked = false;
    const request = { ...input };
    Object.defineProperty(request, 'transactionId', { enumerable: true, get() { invoked = true; throw new Error('private synthetic value'); } });
    const before = snapshot();
    fails(() => markExactExpensePaid(db, context, request), 'INVALID_INPUT');
    expect(invoked).toBe(false);
    expect(snapshot()).toBe(before);
  });
  it.each([
    { name: 'extra field', request: { ...input, extra: 'private synthetic value' } },
    { name: 'missing field', request: { transactionId: 'tx' } },
    { name: 'symbol field', request: { ...input, [Symbol('synthetic')]: 1 } },
    { name: 'custom prototype', request: Object.assign(Object.create({ inherited: true }), input) },
    { name: 'string expiry', request: { ...input, actor: { ...input.actor, originalExpiresAt: '4000000000' } } },
    { name: 'NaN expiry', request: { ...input, actor: { ...input.actor, originalExpiresAt: NaN } } },
    { name: 'empty identifier', request: { ...input, transactionId: ' ' } },
    { name: 'oversized identifier', request: { ...input, transactionId: 'x'.repeat(129) } },
    { name: 'hostile proxy', request: new Proxy({}, { ownKeys() { throw new Error('private synthetic value'); } }) },
  ])('rejects $name without writes', ({ request }) => {
    const { db, snapshot } = fixture();
    const before = snapshot();
    fails(() => markExactExpensePaid(db, context, request as typeof input), 'INVALID_INPUT');
    expect(snapshot()).toBe(before);
  });
});

describe('authorized positive payment variants', () => {
  it.each([
    { name: 'approved unpaid', role: 'manager', status: 'approved', walletProject: 'p' },
    { name: 'accountant', role: 'accountant', status: 'pending', walletProject: 'p' },
    { name: 'admin with foreign wallet', role: 'admin', status: 'pending', walletProject: 'q' },
    { name: 'admin with global wallet', role: 'admin', status: 'pending', walletProject: null },
  ])('pays an eligible expense as $name', ({ role, status, walletProject }) => {
    const { db, s } = fixture();
    s.prepare('UPDATE users SET role=? WHERE id=?').run(role, 'user');
    s.prepare('UPDATE transactions SET status=? WHERE id=?').run(status, 'tx');
    s.prepare('UPDATE accounts SET project_id=? WHERE id=?').run(walletProject, 'wallet');
    expect(markExactExpensePaid(db, context, input).changed).toBe(true);
    const account = s.prepare('SELECT balance_encrypted FROM accounts WHERE id=?').get('wallet') as any;
    expect(decryptMoneyMinor(account.balance_encrypted, 'AAA', policy, key)).toBe(99280074525900687655n);
    expect(new AuditLogRepository(db).verifyChainIntegrity(key)).toEqual({ valid: true, count: 1 });
  });
});

describe('native amount domain boundaries', () => {
  for (const paid of [false, true]) for (const amount of [0n, -1n]) {
    it(`rejects native amount ${amount} for ${paid ? 'paid' : 'unpaid'} without writes`, () => {
      const { db, s, snapshot } = fixture();
      s.prepare('UPDATE transactions SET amount_encrypted=?,is_paid=?,status=? WHERE id=?').run(encryptMoneyMinor(amount, 'AAA', policy, key), paid ? 1 : 0, paid ? 'approved' : 'pending', 'tx');
      const before = snapshot();
      fails(() => markExactExpensePaid(db, context, input), 'CONFLICT');
      expect(snapshot()).toBe(before);
    });
  }
});

describe('wallet currency and target visibility', () => {
  for (const paid of [false, true]) {
    it(`rejects a wrong-currency wallet for ${paid ? 'paid' : 'unpaid'} without writes`, () => {
      const { db, s, snapshot } = fixture();
      if (paid) s.prepare("UPDATE transactions SET is_paid=1,status='approved' WHERE id='tx'").run();
      s.prepare('UPDATE accounts SET currency=?,balance_encrypted=?,credit_limit_encrypted=? WHERE id=?').run('BBB', encryptMoneyMinor(100n, 'BBB', policy, key), encryptMoneyMinor(17n, 'BBB', policy, key), 'wallet');
      const before = snapshot();
      fails(() => markExactExpensePaid(db, context, input), 'CONFLICT');
      expect(snapshot()).toBe(before);
    });
  }
  it('does not expose a transaction outside the actor scope', () => {
    const { db, s, snapshot } = fixture();
    s.prepare("DELETE FROM project_memberships WHERE user_id='user' AND project_id='p'").run();
    const before = snapshot();
    fails(() => markExactExpensePaid(db, context, input), 'NOT_FOUND');
    expect(snapshot()).toBe(before);
  });
  it('does not write when the target is missing', () => {
    const { db, snapshot } = fixture();
    const before = snapshot();
    fails(() => markExactExpensePaid(db, context, { ...input, transactionId: 'missing' }), 'NOT_FOUND');
    expect(snapshot()).toBe(before);
  });
});

describe('caller transaction boundary', () => {
  it('rejects without disturbing the caller transaction or its prior write', () => {
    const { db, s, snapshot } = fixture();
    s.exec('BEGIN IMMEDIATE');
    try {
      s.prepare("UPDATE projects SET name='caller pending' WHERE id='p'").run();
      const before = snapshot();
      fails(() => markExactExpensePaid(db, context, input), 'CONFLICT');
      expect(s.inTransaction).toBe(true);
      expect(snapshot()).toBe(before);
      expect(s.prepare("SELECT name FROM projects WHERE id='p'").get()).toEqual({ name: 'caller pending' });
    } finally { s.exec('ROLLBACK'); }
    expect(s.prepare("SELECT name FROM projects WHERE id='p'").get()).toEqual({ name: 'P' });
  });
});

describe('mutation write failures', () => {
  it.each(['account', 'transaction'])('rolls back an injected %s write failure', fault => {
    const { db, s, snapshot } = fixture();
    const before = snapshot();
    let accountSuccess = 0, transactionSuccess = 0, faultReached = 0, auditAttempt = 0;
    const prepare = s.prepare.bind(s);
    (s as any).prepare = (sql: string) => {
      const statement = prepare(sql);
      return new Proxy(statement, { get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'run') return (...args: unknown[]) => {
          const account = /UPDATE\s+(?:main\.)?["`\[]?accounts/i.test(sql);
          const transaction = /UPDATE\s+(?:main\.)?["`\[]?transactions/i.test(sql);
          if (/INSERT\s+INTO\s+(?:main\.)?["`\[]?audit_logs/i.test(sql)) auditAttempt++;
          if (account && fault === 'account') { faultReached++; throw new Error('private synthetic fault'); }
          const result = value.apply(target, args);
          if (account && result.changes === 1) accountSuccess++;
          if (transaction && result.changes === 1) transactionSuccess++;
          if (transaction && fault === 'transaction') { faultReached++; return { ...result, changes: 0 }; }
          return result;
        };
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    fails(() => markExactExpensePaid(db, context, input), 'FAILED');
    expect(faultReached).toBe(1);
    expect(accountSuccess).toBe(fault === 'transaction' ? 1 : 0);
    expect(transactionSuccess).toBe(fault === 'transaction' ? 1 : 0);
    expect(auditAttempt).toBe(0);
    expect(snapshot()).toBe(before);
    expect(s.inTransaction).toBe(false);
  });
});

describe('audit-trigger account metadata interference', () => {
  it('rolls back when the audit insertion deactivates the selected wallet', () => {
    const { db, s, snapshot } = fixture("CREATE TRIGGER synthetic_audit_deactivate AFTER INSERT ON audit_logs BEGIN SELECT observe_deactivation(); UPDATE accounts SET is_active=0 WHERE id='wallet'; END");
    let triggerCalls = 0;
    s.function('observe_deactivation', () => { triggerCalls++; return 0; });
    const before = snapshot();
    const calls = observeWrites(s);
    let caught: unknown;
    try { markExactExpensePaid(db, context, input); } catch (error) { caught = error; }
    expect(calls.account).toBe(1);
    expect(calls.transaction).toBe(1);
    expect(calls.auditAttempt).toBe(1);
    expect(calls.auditSuccess).toBe(1);
    expect(triggerCalls).toBe(1);
    expect(caught).toBeInstanceOf(ExactExpensePaidError);
    expect(caught).toMatchObject({ reason: 'FAILED', message: 'Exact expense payment operation failed' });
    expect(Object.hasOwn(caught as object, 'cause')).toBe(false);
    expect(snapshot()).toBe(before);
    expect(s.inTransaction).toBe(false);
  });
});

describe('pre-migration unrelated rows and OTO references', () => {
  const options = {
    provenance: { tx: 'BBB', 'other-tx': 'BBB' },
    preMigration: (s: ReturnType<typeof initDatabase>['sqlite'], legacy: string) => {
      s.prepare('INSERT INTO accounts (id,name,name_blind_index,currency,balance_encrypted,credit_limit_encrypted,project_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('other-wallet', 'Other', 'other-index', 'AAA', legacy, legacy, 'q', 1, 'old', 'old');
      s.prepare('INSERT INTO transactions (id,project_id,type,date,amount_encrypted,currency,base_amount_encrypted,category_id,title_encrypted,title_blind_index,account_from_id,account_to_id,payment_source,oto_kasa_transaction_id,is_paid,status,created_by_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('other-tx', 'q', 'expense', 'date', legacy, 'AAA', legacy, 'category', 'title', 'other-index', 'other-wallet', null, 'company_account', null, 0, 'pending', 'user', 'old', 'old');
    },
  };
  it('preserves every raw column of unrelated rows on success', () => {
    const { db, s, fixtureContext } = fixture(undefined, options);
    const account = s.prepare('SELECT * FROM accounts WHERE id=?').get('other-wallet');
    const transaction = s.prepare('SELECT * FROM transactions WHERE id=?').get('other-tx');
    expect(markExactExpensePaid(db, fixtureContext, input).changed).toBe(true);
    expect(s.prepare('SELECT * FROM accounts WHERE id=?').get('other-wallet')).toEqual(account);
    expect(s.prepare('SELECT * FROM transactions WHERE id=?').get('other-tx')).toEqual(transaction);
  });
  for (const paid of [false, true]) for (const deleted of [false, true]) {
    it(`rejects reverse OTO even outside scope (paid=${paid}, deleted=${deleted})`, () => {
      const { db, s, snapshot, fixtureContext } = fixture(undefined, options);
      s.prepare("DELETE FROM project_memberships WHERE user_id='user' AND project_id='q'").run();
      s.prepare('UPDATE transactions SET oto_kasa_transaction_id=?,deleted_at=? WHERE id=?').run('tx', deleted ? 'old' : null, 'other-tx');
      if (paid) s.prepare("UPDATE transactions SET is_paid=1,status='approved' WHERE id='tx'").run();
      const before = snapshot();
      fails(() => markExactExpensePaid(db, fixtureContext, input), 'CONFLICT');
      expect(snapshot()).toBe(before);
    });
  }
  it.each([false, true])('rejects outgoing OTO for paid=%s', paid => {
    const { db, s, snapshot, fixtureContext } = fixture(undefined, options);
    s.prepare("UPDATE transactions SET oto_kasa_transaction_id='other-tx' WHERE id='tx'").run();
    if (paid) s.prepare("UPDATE transactions SET is_paid=1,status='approved' WHERE id='tx'").run();
    const before = snapshot();
    fails(() => markExactExpensePaid(db, fixtureContext, input), 'CONFLICT');
    expect(snapshot()).toBe(before);
  });
});

describe('remaining target and wallet visibility', () => {
  it('does not expose a deleted target', () => {
    const { db, s, snapshot } = fixture();
    s.prepare("UPDATE transactions SET deleted_at='old' WHERE id='tx'").run();
    const before = snapshot();
    fails(() => markExactExpensePaid(db, context, input), 'NOT_FOUND');
    expect(snapshot()).toBe(before);
  });
  it('does not expose a null-project target to a nonadmin', () => {
    const { db, s, snapshot } = fixture();
    s.prepare("UPDATE transactions SET project_id=NULL WHERE id='tx'").run();
    const before = snapshot();
    fails(() => markExactExpensePaid(db, context, input), 'NOT_FOUND');
    expect(snapshot()).toBe(before);
  });
  it('rejects a missing wallet without foreign key violations', () => {
    const { db, s, snapshot } = fixture();
    s.prepare("UPDATE transactions SET account_from_id='missing-wallet' WHERE id='tx'").run();
    expect(s.pragma('foreign_key_check')).toEqual([]);
    const before = snapshot();
    fails(() => markExactExpensePaid(db, context, input), 'CONFLICT');
    expect(snapshot()).toBe(before);
    expect(s.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('strict payment context', () => {
  it('rejects context, policy and provenance accessors without executing them', () => {
    for (const location of ['context', 'policy', 'provenance']) {
      const { db, snapshot } = fixture();
      let calls = 0;
      const getter = () => { calls++; throw new Error('private synthetic getter'); };
      const candidate: any = { key, policy: { version: policy.version, exponents: { ...policy.exponents } }, provenance: { ...provenance } };
      if (location === 'context') Object.defineProperty(candidate, 'key', { enumerable: true, get: getter });
      if (location === 'policy') Object.defineProperty(candidate.policy, 'version', { enumerable: true, get: getter });
      if (location === 'provenance') Object.defineProperty(candidate.provenance, 'tx', { enumerable: true, get: getter });
      const before = snapshot();
      fails(() => markExactExpensePaid(db, candidate, input), 'INVALID_INPUT');
      expect(calls).toBe(0);
      expect(snapshot()).toBe(before);
    }
  });
  it.each([
    { name: 'empty string key', value: { ...context, key: '' } },
    { name: 'empty buffer key', value: { ...context, key: Buffer.alloc(0) } },
    { name: 'extra context field', value: { ...context, extra: true } },
    { name: 'symbol context field', value: { ...context, [Symbol('extra')]: true } },
    { name: 'custom context prototype', value: Object.assign(Object.create({ inherited: true }), context) },
    { name: 'extra policy field', value: { ...context, policy: { ...policy, extra: true } } },
    { name: 'invalid version', value: { ...context, policy: { ...policy, version: '' } } },
    { name: 'oversized version', value: { ...context, policy: { ...policy, version: 'x'.repeat(65) } } },
    { name: 'invalid exponent', value: { ...context, policy: { ...policy, exponents: { AAA: 19, BBB: 0 } } } },
    { name: 'fractional exponent', value: { ...context, policy: { ...policy, exponents: { AAA: 1.5, BBB: 0 } } } },
    { name: 'invalid currency', value: { ...context, policy: { ...policy, exponents: { aaa: 2 } } } },
    { name: 'unknown provenance currency', value: { ...context, provenance: { tx: 'CCC' } } },
    { name: 'oversized provenance id', value: { ...context, provenance: { ['x'.repeat(129)]: 'BBB' } } },
    { name: 'symbol provenance field', value: { ...context, provenance: { tx: 'BBB', [Symbol('extra')]: 'BBB' } } },
    { name: 'custom policy prototype', value: { ...context, policy: Object.assign(Object.create({ inherited: true }), policy) } },
    { name: 'custom provenance prototype', value: { ...context, provenance: Object.assign(Object.create({ inherited: true }), provenance) } },
  ])('rejects $name without writes', ({ value }) => {
    const { db, snapshot } = fixture();
    const before = snapshot();
    fails(() => markExactExpensePaid(db, value as typeof context, input), 'INVALID_INPUT');
    expect(snapshot()).toBe(before);
  });
  it('rejects a revoked context proxy without leaking its error', () => {
    const { db, snapshot } = fixture();
    const candidate = Proxy.revocable({ ...context }, {});
    candidate.revoke();
    const before = snapshot();
    fails(() => markExactExpensePaid(db, candidate.proxy, input), 'INVALID_INPUT');
    expect(snapshot()).toBe(before);
  });
});

describe('caller-owned payment context', () => {
  it('uses private copies when the caller mutates context at the first transaction entry', () => {
    const callerKey = Buffer.alloc(32, 7);
    const originalKey = Buffer.from(callerKey);
    const callerPolicy = { version: 'test-v1', exponents: { AAA: 2, BBB: 0 } };
    const originalPolicy = { version: 'test-v1', exponents: { AAA: 2, BBB: 0 } };
    const callerProvenance = { tx: 'BBB' };
    const { db, s, fixtureContext } = fixture(undefined, { key: callerKey, policy: callerPolicy, provenance: callerProvenance });
    const originalTransaction = s.transaction.bind(s);
    let entries = 0;
    (s as any).transaction = (...args: any[]) => {
      const transaction = (originalTransaction as any)(...args);
      const facade: any = (...callArgs: unknown[]) => transaction(...callArgs);
      facade.immediate = (...callArgs: unknown[]) => {
        entries++;
        if (entries === 1) { callerKey.fill(9); callerPolicy.version = 'changed'; callerPolicy.exponents.AAA = 3; callerProvenance.tx = 'AAA'; }
        return transaction.immediate(...callArgs);
      };
      facade.deferred = (...callArgs: unknown[]) => transaction.deferred(...callArgs);
      facade.exclusive = (...callArgs: unknown[]) => transaction.exclusive(...callArgs);
      return facade;
    };
    const result = markExactExpensePaid(db, fixtureContext, input);
    expect(result.changed).toBe(true);
    expect(entries).toBeGreaterThanOrEqual(3);
    const account = s.prepare("SELECT balance_encrypted FROM accounts WHERE id='wallet'").get() as any;
    expect(decryptMoneyMinor(account.balance_encrypted, 'AAA', originalPolicy, originalKey)).toBe(99280074525900687655n);
    const row = s.prepare('SELECT diff_encrypted FROM audit_logs').get() as any;
    const diff = decryptField<any>(row.diff_encrypted, originalKey);
    expect(diff.newState.accounts[0].balance).toEqual(moneyFromMinor(99280074525900687655n, 'AAA', originalPolicy));
    expect(new AuditLogRepository(db).verifyChainIntegrity(originalKey)).toEqual({ valid: true, count: 1 });
  });
  it('leaves caller input and context descriptors, values, and frozen states unchanged', () => {
    const { db } = fixture();
    const callerContext = { key, policy: { version: policy.version, exponents: { ...policy.exponents } }, provenance: { ...provenance } };
    const request = { transactionId: input.transactionId, actor: { ...input.actor } };
    const objects = [callerContext, callerContext.policy, callerContext.policy.exponents, callerContext.provenance, request, request.actor];
    const descriptors = objects.map(o => Object.getOwnPropertyDescriptors(o));
    const frozen = objects.map(o => Object.isFrozen(o));
    const values = JSON.stringify({ callerContext, request });
    expect(markExactExpensePaid(db, callerContext, request).changed).toBe(true);
    expect(objects.map(o => Object.getOwnPropertyDescriptors(o))).toEqual(descriptors);
    expect(objects.map(o => Object.isFrozen(o))).toEqual(frozen);
    expect(JSON.stringify({ callerContext, request })).toBe(values);
  });
});

describe('outer transaction callback and error sanitation', () => {
  it.each(['ordinary', 'own busy', 'inherited busy', 'accessor busy', 'descriptor proxy'])('rolls back and sanitizes %s after the real callback', kind => {
    const { db, s, snapshot } = fixture();
    const before = snapshot();
    const calls = observeWrites(s);
    let entries = 0, completed = 0, getterCalls = 0;
    const originalTransaction = db.transaction.bind(db);
    (db as any).transaction = (callback: (...args: any[]) => unknown, ...options: any[]) => {
      entries++;
      return (originalTransaction as any)((...args: any[]) => {
        const result = callback(...args);
        completed++;
        if (kind === 'own busy') throw { code: 'SQLITE_BUSY', secret: 'private synthetic detail' };
        if (kind === 'inherited busy') throw Object.create({ code: 'SQLITE_BUSY' });
        if (kind === 'accessor busy') throw Object.defineProperty({}, 'code', { get() { getterCalls++; return 'SQLITE_BUSY'; } });
        if (kind === 'descriptor proxy') throw new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private synthetic detail'); } });
        throw new Error('private synthetic detail');
      }, ...options);
    };
    let caught: any;
    try { markExactExpensePaid(db, context, input); } catch (error) { caught = error; }
    expect(entries).toBe(1);
    expect(completed).toBe(1);
    expect(calls.account).toBe(1);
    expect(calls.transaction).toBe(1);
    expect(calls.auditSuccess).toBe(1);
    expect(getterCalls).toBe(0);
    expect(caught).toBeInstanceOf(ExactExpensePaidError);
    expect(caught.reason).toBe('FAILED');
    expect(caught.message).toBe('Exact expense payment operation failed');
    expect(Object.hasOwn(caught, 'cause')).toBe(false);
    expect(caught.code).toBe(kind === 'own busy' ? 'SQLITE_BUSY' : undefined);
    expect(JSON.stringify(caught)).not.toContain('private synthetic detail');
    expect(snapshot()).toBe(before);
    expect(s.inTransaction).toBe(false);
  });
});


describe('native transaction boundary regressions', () => {
  it('rolls back a native deferred foreign key COMMIT failure after the full service callback', () => {
    const { db, s, snapshot } = fixture();
    expect(s.pragma('foreign_key_check')).toEqual([]);
    const before = snapshot();
    const calls = observeWrites(s);
    const original = db.transaction.bind(db);
    let completed = 0, inserted = 0, violationCount = 0, returned = 0;
    (db as any).transaction = (callback: (...args: any[]) => unknown, ...options: any[]) =>
      (original as any)((...args: any[]) => {
        const result = callback(...args);
        completed++;
        s.pragma('defer_foreign_keys = ON');
        inserted = s.prepare("INSERT INTO project_memberships(user_id,project_id,created_at) VALUES('user','missing-project','synthetic')").run().changes;
        expect(inserted).toBe(1);
        violationCount = (s.pragma('foreign_key_check') as unknown[]).length;
        expect(violationCount).toBeGreaterThan(0);
        returned++;
        return result;
      }, ...options);
    let caught: any;
    try { markExactExpensePaid(db, context, input); } catch (error) { caught = error; }
    expect(completed).toBe(1);
    expect(inserted).toBe(1);
    expect(violationCount).toBeGreaterThan(0);
    expect(returned).toBe(1);
    expect(calls).toEqual({ account: 1, transaction: 1, auditAttempt: 1, auditSuccess: 1 });
    expect(caught).toBeInstanceOf(ExactExpensePaidError);
    expect(caught).toMatchObject({ reason: 'FAILED', message: 'Exact expense payment operation failed' });
    expect(Object.hasOwn(caught, 'cause')).toBe(false);
    expect(snapshot()).toBe(before);
    expect(s.pragma('foreign_key_check')).toEqual([]);
    expect(s.inTransaction).toBe(false);
  });

  it('rolls back money format fence drift inside the owned transaction before the real callback', () => {
    const { db, s, snapshot } = fixture();
    const before = snapshot();
    const calls = observeWrites(s);
    const original = db.transaction.bind(db);
    let changed = 0, entered = 0;
    (db as any).transaction = (callback: (...args: any[]) => unknown, ...options: any[]) =>
      (original as any)((...args: any[]) => {
        entered++;
        changed = s.prepare("UPDATE main.money_format SET policy_version='synthetic-drift' WHERE id=1").run().changes;
        expect(changed).toBe(1);
        return callback(...args);
      }, ...options);
    fails(() => markExactExpensePaid(db, context, input), 'FAILED');
    expect(entered).toBe(1);
    expect(changed).toBe(1);
    expect(calls).toEqual({ account: 0, transaction: 0, auditAttempt: 0, auditSuccess: 0 });
    expect(snapshot()).toBe(before);
    expect(s.inTransaction).toBe(false);
  });

  it('rolls back when the real target readback differs after the conditional update', () => {
    const { db, s, snapshot } = fixture();
    const before = snapshot();
    const directPrepare = s.prepare.bind(s);
    const calls = observeWrites(s);
    const observedPrepare = s.prepare.bind(s);
    let injected = 0;
    (s as any).prepare = (sql: string) => {
      const statement = observedPrepare(sql);
      if (!/UPDATE\s+(?:main\.)?["`\[]?transactions/i.test(sql)) return statement;
      return new Proxy(statement, { get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === 'run') return (...args: unknown[]) => {
          const result = value.apply(target, args);
          expect(result.changes).toBe(1);
          injected += directPrepare("UPDATE main.transactions SET status='pending' WHERE id='tx'").run().changes;
          return result;
        };
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    fails(() => markExactExpensePaid(db, context, input), 'FAILED');
    expect(injected).toBe(1);
    expect(calls).toEqual({ account: 1, transaction: 1, auditAttempt: 0, auditSuccess: 0 });
    expect(snapshot()).toBe(before);
    expect(s.inTransaction).toBe(false);
  });
});

describe('second connection BEGIN contention', () => {
  it.each(['factory', 'owned'] as const)('reports real %s BEGIN BUSY and succeeds on retry', async boundary => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const Database = (await import('better-sqlite3')).default;
    const parent = fs.realpathSync(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(parent, 'costcore-payment-MINI486-'));
    const actualDirectory = fs.realpathSync(directory);
    let primary: ReturnType<typeof fixture> | undefined;
    let second: InstanceType<typeof Database> | undefined;
    try {
      primary = fixture(undefined, { path: path.join(directory, 'payment.sqlite') });
      const { db, s, snapshot } = primary;
      second = new Database(path.join(directory, 'payment.sqlite'));
      const writer = second;
      s.pragma('busy_timeout = 0');
      const before = snapshot();
      const calls = observeWrites(s);
      const original = db.transaction.bind(db);
      let armed = true, entries = 0, callbackEntries = 0;
      if (boundary === 'owned') {
        (db as any).transaction = (callback: (...args: any[]) => unknown, ...options: any[]) => {
          entries++;
          if (armed) { armed = false; writer.exec('BEGIN IMMEDIATE'); }
          return (original as any)((...args: any[]) => { callbackEntries++; return callback(...args); }, ...options);
        };
      } else {
        writer.exec('BEGIN IMMEDIATE');
      }
      let caught: any;
      try { markExactExpensePaid(db, context, input); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(ExactExpensePaidError);
      expect(caught).toMatchObject({ reason: 'FAILED', message: 'Exact expense payment operation failed' });
      expect(Object.getOwnPropertyDescriptor(caught, 'code')?.value).toBe('SQLITE_BUSY');
      expect(Object.hasOwn(caught, 'cause')).toBe(false);
      expect(entries).toBe(boundary === 'owned' ? 1 : 0);
      expect(callbackEntries).toBe(0);
      expect(calls).toEqual({ account: 0, transaction: 0, auditAttempt: 0, auditSuccess: 0 });
      expect(snapshot()).toBe(before);
      expect(s.inTransaction).toBe(false);
      expect(writer.inTransaction).toBe(true);
      writer.exec('ROLLBACK');
      expect(markExactExpensePaid(db, context, input).changed).toBe(true);
      const account = s.prepare("SELECT balance_encrypted FROM accounts WHERE id='wallet'").get() as any;
      expect(decryptMoneyMinor(account.balance_encrypted, 'AAA', policy, key)).toBe(99280074525900687655n);
      expect(calls).toEqual({ account: 1, transaction: 1, auditAttempt: 1, auditSuccess: 1 });
      expect(new AuditLogRepository(db).verifyChainIntegrity(key)).toEqual({ valid: true, count: 1 });
      expect(s.inTransaction).toBe(false);
    } finally {
      if (second) { if (second.inTransaction) second.exec('ROLLBACK'); second.close(); }
      if (primary) {
        const index = opened.findIndex(instance => instance.sqlite === primary!.s);
        if (index !== -1) opened.splice(index, 1);
        primary.s.close();
      }
      expect(fs.lstatSync(directory).isSymbolicLink()).toBe(false);
      expect(fs.realpathSync(directory)).toBe(actualDirectory);
      expect(path.dirname(actualDirectory)).toBe(parent);
      expect(path.basename(actualDirectory).startsWith('costcore-payment-MINI486-')).toBe(true);
      fs.rmSync(actualDirectory, { recursive: true });
    }
  });
});
