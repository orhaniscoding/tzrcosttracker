import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { moneyFromMinor, type MoneyPolicy, type MoneyV1 } from '@cost-core/types';
import { decryptMoneyMinor } from '../money-codec.js';
import { verifyMoneyStore } from '../money-migration.js';
import type { TransactionReadScope } from './transaction.repo.js';

export type ExactTransactionMoney = Readonly<{
  transactionId: string; projectId: string | null;
  type: 'expense' | 'income' | 'transfer';
  status: 'draft' | 'pending_approval' | 'pending' | 'approved' | 'paid' | 'rejected' | 'cancelled';
  paymentSource: 'company_account' | 'person_out_of_pocket';
  isPaid: boolean; currency: string; amount: MoneyV1; baseCurrency: string; baseAmount: MoneyV1;
  accountFromId: string | null; accountToId: string | null; otoKasaTransactionId: string | null;
  deletedAt: string | null; updatedAt: string;
}>;

type Row = Record<string, unknown>;
const bad = (): never => { throw new Error('invalid'); };
const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function safe<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    const error = new Error('Exact transaction money operation failed');
    try { if (e && typeof e === 'object') { const d = Object.getOwnPropertyDescriptor(e, 'code'); if (d && 'value' in d && d.value === 'SQLITE_BUSY') (error as Error & { code: string }).code = 'SQLITE_BUSY'; } } catch {}
    throw error;
  }
}
function fields(value: unknown, max: number, expected?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object') return bad();
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return bad();
  const keys = Reflect.ownKeys(value);
  if (keys.length > max || keys.some(k => typeof k !== 'string') || (expected && (keys.length !== expected.length || expected.some(k => !keys.includes(k))))) return bad();
  const out: Record<string, unknown> = Object.create(null);
  for (const k of keys as string[]) { const d = Object.getOwnPropertyDescriptor(value, k); if (!d || !('value' in d)) return bad(); out[k] = d.value; }
  return out;
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return bad();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 100000) return bad();
  const n = length.value as number; const keys = Reflect.ownKeys(value);
  if (keys.length !== n + 1) return bad();
  for (const k of keys) {
    if (typeof k !== 'string') return bad();
    if (k === 'length') continue;
    const i = Number(k), d = Object.getOwnPropertyDescriptor(value, k);
    if (!Number.isInteger(i) || i < 0 || i >= n || String(i) !== k || !d || !('value' in d)) return bad();
  }
  const out: string[] = [];
  for (let i = 0; i < n; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !('value' in d)) return bad(); out.push(id(d.value)); }
  return out;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || Buffer.from(value, 'utf8').toString('utf8') !== value) return bad();
  return value;
}
function nullableId(value: unknown): string | null { return value === null ? null : id(value); }
function context(key: string | Buffer, policy: MoneyPolicy, provenance: Readonly<Record<string, string>>) {
  if (!(typeof key === 'string' && key.length > 0) && !(Buffer.isBuffer(key) && key.length > 0)) return bad();
  const secret = Buffer.isBuffer(key) ? Buffer.from(key) : key;
  const p = fields(policy, 2, ['version', 'exponents']);
  if (typeof p.version !== 'string' || p.version.length > 64 || /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.exec(p.version)?.[0] !== p.version) return bad();
  const e = fields(p.exponents, 64), codes = Object.keys(e).sort(cmp);
  if (!codes.length) return bad();
  const exponents: Record<string, number> = Object.create(null);
  for (const code of codes) { const n = e[code]; if (!/^[A-Z]{3}$/.test(code) || typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 18) return bad(); exponents[code] = n; }
  const copy: MoneyPolicy = Object.freeze({ version: p.version, exponents: Object.freeze(exponents) });
  const raw = fields(provenance, 100000), prov: Record<string, string> = Object.create(null);
  for (const k of Object.keys(raw).sort(cmp)) { const c = raw[k]; id(k); if (typeof c !== 'string' || !Object.hasOwn(exponents, c)) return bad(); prov[k] = c; }
  return { secret, policy: copy, provenance: Object.freeze(prov) };
}
function scopeValue(scope: TransactionReadScope): { all: boolean; projects: string } {
  const s = fields(scope, 2);
  if (s.all === true && Object.keys(s).length === 1 && Object.hasOwn(s, 'all')) return { all: true, projects: '[]' };
  if (s.all !== false || Object.keys(s).length !== 2 || !Object.hasOwn(s, 'all') || !Object.hasOwn(s, 'projectIds')) return bad();
  return { all: false, projects: JSON.stringify([...new Set(ids(s.projectIds))].sort(cmp)) };
}
function fence(d: BetterSqliteDatabase): string {
  if (d.prepare('SELECT name FROM temp.sqlite_schema LIMIT 1').all().length || (d.prepare('PRAGMA main.foreign_keys').get() as Row).foreign_keys !== 1) return bad();
  return JSON.stringify([
    d.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name,sql').all(),
    d.prepare('SELECT version,name,checksum,applied_at FROM main.schema_migrations ORDER BY version').all(),
    d.prepare('SELECT * FROM main.money_format ORDER BY id').all(),
    d.prepare('SELECT transaction_id,currency FROM main.transaction_base_currencies ORDER BY transaction_id').all(),
  ]);
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return bad();
  return value as T;
}
function text(value: unknown): string { if (typeof value !== 'string' || !value.length) return bad(); return value; }

export class ExactTransactionMoneyRepository {
  private constructor(private readonly d: BetterSqliteDatabase, private readonly ctx: ReturnType<typeof context>, private readonly stamp: string) {}
  static open(d: BetterSqliteDatabase, key: string | Buffer, policy: MoneyPolicy, provenance: Readonly<Record<string, string>>): ExactTransactionMoneyRepository {
    return safe(() => {
      const ctx = context(key, policy, provenance);
      if (d.inTransaction) return bad();
      return d.transaction(() => { verifyMoneyStore(d, ctx.secret, ctx.policy, ctx.provenance); return new ExactTransactionMoneyRepository(d, ctx, fence(d)); }).immediate();
    });
  }
  getTransactionMoneyInScope(transactionId: string, scope: TransactionReadScope, includeDeleted?: boolean): ExactTransactionMoney | null {
    return safe(() => this.d.transaction(() => {
      const target = id(transactionId), s = scopeValue(scope);
      if (includeDeleted !== undefined && typeof includeDeleted !== 'boolean') return bad();
      if (fence(this.d) !== this.stamp) return bad();
      const r = this.d.prepare('SELECT t.id,t.project_id,t.type,t.status,t.payment_source,t.is_paid,t.currency,t.amount_encrypted,p.currency AS base_currency,t.base_amount_encrypted,t.account_from_id,t.account_to_id,t.oto_kasa_transaction_id,t.deleted_at,t.updated_at FROM main.transactions AS t LEFT JOIN main.transaction_base_currencies AS p ON p.transaction_id=t.id WHERE t.id=? AND (?=1 OR t.project_id IN (SELECT value FROM json_each(?))) AND (?=1 OR t.deleted_at IS NULL)').get(target, s.all ? 1 : 0, s.projects, includeDeleted === true ? 1 : 0) as Row | undefined;
      if (!r) return null;
      const resultId = id(r.id), projectId = nullableId(r.project_id);
      const type = enumeration(r.type, ['expense', 'income', 'transfer'] as const);
      const status = enumeration(r.status, ['draft', 'pending_approval', 'pending', 'approved', 'paid', 'rejected', 'cancelled'] as const);
      const paymentSource = enumeration(r.payment_source, ['company_account', 'person_out_of_pocket'] as const);
      if (r.is_paid !== 0 && r.is_paid !== 1) return bad();
      const currency = r.currency, baseCurrency = r.base_currency;
      if (typeof currency !== 'string' || !Object.hasOwn(this.ctx.policy.exponents, currency) || typeof baseCurrency !== 'string' || !Object.hasOwn(this.ctx.policy.exponents, baseCurrency)) return bad();
      const accountFromId = nullableId(r.account_from_id), accountToId = nullableId(r.account_to_id), otoKasaTransactionId = nullableId(r.oto_kasa_transaction_id);
      const deletedAt = r.deleted_at === null ? null : text(r.deleted_at), updatedAt = text(r.updated_at);
      const amount = moneyFromMinor(decryptMoneyMinor(r.amount_encrypted as string, currency, this.ctx.policy, this.ctx.secret), currency, this.ctx.policy);
      const baseAmount = moneyFromMinor(decryptMoneyMinor(r.base_amount_encrypted as string, baseCurrency, this.ctx.policy, this.ctx.secret), baseCurrency, this.ctx.policy);
      return { transactionId: resultId, projectId, type, status, paymentSource, isPaid: r.is_paid === 1, currency, amount, baseCurrency, baseAmount, accountFromId, accountToId, otoKasaTransactionId, deletedAt, updatedAt };
    }).deferred());
  }
}
export function openExactTransactionMoneyRepository(sqlite: BetterSqliteDatabase, key: string | Buffer, policy: MoneyPolicy, provenance: Readonly<Record<string, string>>): ExactTransactionMoneyRepository {
  return ExactTransactionMoneyRepository.open(sqlite, key, policy, provenance);
}
