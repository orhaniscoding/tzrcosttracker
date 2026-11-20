import { AuditLogRepository, openExactAccountMoneyRepository, openExactTransactionMoneyRepository, type CostCoreDatabase, type ExactTransactionMoney, type ExactAccountMoney } from '@cost-core/database';
import { computeAuditHash, decryptField } from '@cost-core/crypto';
import { moneyFromMinor, moneyToMinor, type MoneyPolicy, type MoneyV1 } from '@cost-core/types';
import { exactAccountEffect } from '../exact-financial-effects.js';
import { ProjectAccessService, SessionInvalidError } from './project-access.service.js';

type Reason = 'INVALID_INPUT' | 'INVALID_SESSION' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'FAILED';
export class ExactExpensePaidError extends Error {
  readonly reason: Reason;
  readonly code?: 'SQLITE_BUSY';
  constructor(reason: Reason, busy = false) {
    super('Exact expense payment operation failed');
    this.name = 'ExactExpensePaidError';
    this.reason = reason;
    if (reason === 'FAILED' && busy) this.code = 'SQLITE_BUSY';
  }
}
class Signal { constructor(readonly reason: Reason) {} }
const stop = (reason: Reason): never => { throw new Signal(reason); };
function fields(value: unknown, max: number, expected?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object') return stop('INVALID_INPUT');
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return stop('INVALID_INPUT');
  const keys = Reflect.ownKeys(value);
  if (keys.length > max || keys.some(k => typeof k !== 'string') || (expected && (keys.length !== expected.length || expected.some(k => !keys.includes(k))))) return stop('INVALID_INPUT');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d)) return stop('INVALID_INPUT');
    result[key] = d.value;
  }
  return result;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || Buffer.from(value, 'utf8').toString('utf8') !== value) return stop('INVALID_INPUT');
  return value;
}
function snapshotContext(value: unknown) {
  const c = fields(value, 3, ['key', 'policy', 'provenance']);
  if (!(typeof c.key === 'string' && c.key.length > 0) && !(Buffer.isBuffer(c.key) && c.key.length > 0)) return stop('INVALID_INPUT');
  const key = Buffer.isBuffer(c.key) ? Buffer.from(c.key) : c.key as string;
  const p = fields(c.policy, 2, ['version', 'exponents']);
  if (typeof p.version !== 'string' || p.version.length > 64 || /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.exec(p.version)?.[0] !== p.version) return stop('INVALID_INPUT');
  const raw = fields(p.exponents, 64), exponents: Record<string, number> = Object.create(null);
  const codes = Object.keys(raw).sort();
  if (!codes.length) return stop('INVALID_INPUT');
  for (const code of codes) {
    const n = raw[code];
    if (!/^[A-Z]{3}$/.test(code) || typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 18) return stop('INVALID_INPUT');
    exponents[code] = n;
  }
  const policy: MoneyPolicy = Object.freeze({ version: p.version, exponents: Object.freeze(exponents) });
  const source = fields(c.provenance, 100000), provenance: Record<string, string> = Object.create(null);
  for (const k of Object.keys(source).sort()) {
    id(k); const currency = source[k];
    if (typeof currency !== 'string' || !Object.hasOwn(exponents, currency)) return stop('INVALID_INPUT');
    provenance[k] = currency;
  }
  return { key, policy, provenance: Object.freeze(provenance) };
}
function snapshotInput(value: unknown) {
  const v = fields(value, 2, ['transactionId', 'actor']);
  const a = fields(v.actor, 3, ['userId', 'sessionId', 'originalExpiresAt']);
  if (typeof a.originalExpiresAt !== 'number' || !Number.isFinite(a.originalExpiresAt)) return stop('INVALID_INPUT');
  return { transactionId: id(v.transactionId), userId: id(a.userId), sessionId: id(a.sessionId), originalExpiresAt: a.originalExpiresAt };
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function money(m: MoneyV1): MoneyV1 { return { version: m.version, policyVersion: m.policyVersion, currency: m.currency, exponent: m.exponent, minor: m.minor }; }
function transaction(t: ExactTransactionMoney): ExactTransactionMoney {
  return { transactionId: t.transactionId, projectId: t.projectId, type: t.type, status: t.status, paymentSource: t.paymentSource, isPaid: t.isPaid, currency: t.currency, amount: money(t.amount), baseCurrency: t.baseCurrency, baseAmount: money(t.baseAmount), accountFromId: t.accountFromId, accountToId: t.accountToId, otoKasaTransactionId: t.otoKasaTransactionId, deletedAt: t.deletedAt, updatedAt: t.updatedAt };
}
function auditState(t: ExactTransactionMoney, a: ExactAccountMoney) {
  return { snapshotVersion: 1, command: 'mark-paid', transactions: [transaction(t)], accounts: [{ accountId: a.accountId, currency: a.currency, balance: money(a.balance) }] };
}

export function markExactExpensePaid(db: CostCoreDatabase, context: Readonly<{ key: string | Buffer; policy: MoneyPolicy; provenance: Readonly<Record<string, string>> }>, input: Readonly<{ transactionId: string; actor: Readonly<{ userId: string; sessionId: string; originalExpiresAt: number }> }>): Readonly<{ changed: boolean; transaction: ExactTransactionMoney }> {
  try {
    let ctx: ReturnType<typeof snapshotContext>, req: ReturnType<typeof snapshotInput>;
    try { ctx = snapshotContext(context); req = snapshotInput(input); }
    catch { return stop('INVALID_INPUT'); }
    const raw = db.$client;
    if (raw.inTransaction) return stop('CONFLICT');
    const transactions = openExactTransactionMoneyRepository(raw, ctx.key, ctx.policy, ctx.provenance);
    const accounts = openExactAccountMoneyRepository(raw, ctx.key, ctx.policy, ctx.provenance);
    return db.transaction(tx => {
      const access = new ProjectAccessService();
      let role: string;
      try { role = access.requireFreshActor(tx, req.userId, req.sessionId, req.originalExpiresAt); }
      catch (e) { if (e instanceof SessionInvalidError) return stop('INVALID_SESSION'); throw e; }
      if (!['admin', 'manager', 'accountant'].includes(role)) return stop('FORBIDDEN');
      const resolved = access.resolveScopeInTx(tx, req.userId);
      const scope = resolved.all ? { all: true as const } : { all: false as const, projectIds: [...resolved.projectIds] };
      const before = transactions.getTransactionMoneyInScope(req.transactionId, scope);
      if (!before) return stop('NOT_FOUND');
      if (before.type !== 'expense' || before.paymentSource !== 'company_account' || !before.accountFromId || before.accountToId !== null || before.otoKasaTransactionId !== null) return stop('CONFLICT');
      if (raw.prepare('SELECT 1 FROM main.transactions WHERE oto_kasa_transaction_id=? LIMIT 1').get(req.transactionId)) return stop('CONFLICT');
      if (!['pending', 'approved', 'paid'].includes(before.status) || (before.status === 'paid' && !before.isPaid)) return stop('CONFLICT');
      if (moneyToMinor(before.amount, before.currency, ctx.policy) <= 0n) return stop('CONFLICT');
      if (!resolved.all && before.projectId === null) return stop('CONFLICT');
      const metadata = raw.prepare('SELECT id,project_id,currency,is_active FROM main.accounts WHERE id=? AND (?=1 OR project_id=?)').get(before.accountFromId, resolved.all ? 1 : 0, before.projectId) as { id: string; project_id: string | null; currency: string; is_active: number } | undefined;
      if (!metadata || metadata.is_active !== 1 || metadata.currency !== before.currency) return stop('CONFLICT');
      const walletScope = resolved.all ? { all: true as const } : { all: false as const, projectIds: [before.projectId!] };
      const oldAccount = accounts.getAccountMoneyInScope(before.accountFromId, walletScope);
      if (!oldAccount) return stop('CONFLICT');
      if (before.isPaid) return { changed: false, transaction: before };
      const oldRaw = raw.prepare('SELECT amount_encrypted,base_amount_encrypted FROM main.transactions WHERE id=?').get(req.transactionId);
      const oldWalletRaw = raw.prepare('SELECT credit_limit_encrypted FROM main.accounts WHERE id=?').get(before.accountFromId);
      const expected: ExactTransactionMoney = { ...before, status: 'approved', isPaid: true, updatedAt: new Date().toISOString() };
      const oldEffect = exactAccountEffect(before, ctx.policy), newEffect = exactAccountEffect(expected, ctx.policy);
      if (!newEffect || newEffect.accountId !== before.accountFromId || (oldEffect && oldEffect.accountId !== before.accountFromId)) return stop('FAILED');
      const delta = moneyToMinor(newEffect.delta, before.currency, ctx.policy) - (oldEffect ? moneyToMinor(oldEffect.delta, before.currency, ctx.policy) : 0n);
      const result = accounts.applyBalanceDeltasInScope([{ accountId: before.accountFromId, delta: moneyFromMinor(delta, before.currency, ctx.policy) }], walletScope);
      if (result.length !== 1) return stop('FAILED');
      const changed = raw.prepare("UPDATE main.transactions SET is_paid=1,status='approved',updated_at=? WHERE id=? AND is_paid=0 AND status IN ('pending','approved')").run(expected.updatedAt, req.transactionId);
      if (changed.changes !== 1) return stop('FAILED');
      const actual = transactions.getTransactionMoneyInScope(req.transactionId, scope);
      const actualAccount = accounts.getAccountMoneyInScope(before.accountFromId, walletScope);
      if (!actual || !actualAccount || !same(transaction(actual), transaction(expected)) || !same(actualAccount, result[0])) return stop('FAILED');
      if (moneyToMinor(actualAccount.balance, before.currency, ctx.policy) !== moneyToMinor(oldAccount.balance, before.currency, ctx.policy) + delta) return stop('FAILED');
      if (!same(oldRaw, raw.prepare('SELECT amount_encrypted,base_amount_encrypted FROM main.transactions WHERE id=?').get(req.transactionId))) return stop('FAILED');
      const postWalletRaw = raw.prepare('SELECT balance_encrypted,credit_limit_encrypted,updated_at FROM main.accounts WHERE id=?').get(before.accountFromId) as { balance_encrypted: string; credit_limit_encrypted: string | null; updated_at: string };
      if (!same(oldWalletRaw, { credit_limit_encrypted: postWalletRaw.credit_limit_encrypted })) return stop('FAILED');
      const previousState = auditState(before, oldAccount), newState = auditState(actual, actualAccount);
      const tail = raw.prepare('SELECT CAST(rowid AS TEXT) AS auditRowid,id,hash FROM main.audit_logs ORDER BY rowid DESC LIMIT 1').get() as { auditRowid: string; id: string; hash: string } | undefined;
      const appended = new AuditLogRepository(tx as unknown as CostCoreDatabase).logAction({ userId: req.userId, action: 'UPDATE', entity: 'transaction', entityId: req.transactionId, previousState, newState }, ctx.key);
      const row = raw.prepare('SELECT CAST(rowid AS TEXT) AS auditRowid,* FROM main.audit_logs WHERE id=?').get(appended.id) as { auditRowid: string; id: string; user_id: string; action: string; entity: string; entity_id: string; timestamp: string; previous_hash: string; hash: string; diff_encrypted: string } | undefined;
      const newTail = raw.prepare('SELECT id FROM main.audit_logs ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined;
      if (!row || newTail?.id !== appended.id || row.user_id !== req.userId || row.action !== 'UPDATE' || row.entity !== 'transaction' || row.entity_id !== req.transactionId || row.timestamp !== appended.timestamp || row.previous_hash !== (tail?.hash ?? 'GENESIS') || row.hash !== appended.hash || row.previous_hash !== appended.previousHash) return stop('FAILED');
      const diff = decryptField<{ previousState: unknown; newState: unknown }>(row.diff_encrypted, ctx.key);
      if (!same(diff, { previousState, newState })) return stop('FAILED');
      const hash = computeAuditHash({ previousHash: row.previous_hash, action: 'UPDATE', entity: 'transaction', entityId: req.transactionId, userId: req.userId, timestamp: row.timestamp, previousState, newState });
      if (hash !== row.hash) return stop('FAILED');
      const predecessor = raw.prepare('SELECT CAST(rowid AS TEXT) AS auditRowid,id,hash FROM main.audit_logs WHERE rowid < (SELECT rowid FROM main.audit_logs WHERE id=?) ORDER BY rowid DESC LIMIT 1').get(appended.id) as { auditRowid: string; id: string; hash: string } | undefined;
      if (tail ? !predecessor || predecessor.auditRowid !== tail.auditRowid || predecessor.id !== tail.id || predecessor.hash !== tail.hash : !!predecessor) return stop('FAILED');
      if (!same(metadata, raw.prepare('SELECT id,project_id,currency,is_active FROM main.accounts WHERE id=?').get(before.accountFromId))) return stop('FAILED');
      const finalTx = transactions.getTransactionMoneyInScope(req.transactionId, scope);
      const finalAccount = accounts.getAccountMoneyInScope(before.accountFromId, walletScope);
      if (!finalTx || !finalAccount || !same(transaction(finalTx), transaction(actual)) || !same(finalAccount, actualAccount) || !same(oldRaw, raw.prepare('SELECT amount_encrypted,base_amount_encrypted FROM main.transactions WHERE id=?').get(req.transactionId)) || !same(postWalletRaw, raw.prepare('SELECT balance_encrypted,credit_limit_encrypted,updated_at FROM main.accounts WHERE id=?').get(before.accountFromId))) return stop('FAILED');
      return { changed: true, transaction: finalTx };
    }, { behavior: 'immediate' });
  } catch (error) {
    let reason: Reason = 'FAILED', busy = false;
    try {
      if (error instanceof Signal) reason = error.reason;
      else if (error && typeof error === 'object') {
        const d = Object.getOwnPropertyDescriptor(error, 'code');
        busy = !!d && 'value' in d && d.value === 'SQLITE_BUSY';
      }
    } catch { reason = 'FAILED'; busy = false; }
    throw new ExactExpensePaidError(reason, busy);
  }
}
