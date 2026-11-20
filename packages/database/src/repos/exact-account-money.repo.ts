import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { moneyFromMinor, moneyToMinor, type MoneyPolicy, type MoneyV1 } from '@cost-core/types';
import { decryptMoneyMinor, encryptMoneyMinor } from '../money-codec.js';
import { verifyMoneyStore } from '../money-migration.js';
import type { AccountReadScope } from './account.repo.js';

export interface ExactAccountMoney { readonly accountId: string; readonly currency: string; readonly balance: MoneyV1; readonly creditLimit: MoneyV1 | null; readonly updatedAt: string }
export interface ExactAccountBalanceDelta { readonly accountId: string; readonly delta: MoneyV1 }
type Row = Record<string, any>;
const limit = 67108864;
const bad = (): never => { throw new Error('invalid'); };
const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function safe<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    const error = new Error('Exact account money operation failed');
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
  const result: Record<string, unknown> = Object.create(null);
  for (const k of keys as string[]) { const d = Object.getOwnPropertyDescriptor(value, k); if (!d || !('value' in d)) return bad(); result[k] = d.value; }
  return result;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) return bad();
  const ld = Object.getOwnPropertyDescriptor(value, 'length');
  if (!ld || !('value' in ld) || !Number.isInteger(ld.value) || ld.value < 0 || ld.value > max) return bad();
  const n = ld.value as number, keys = Reflect.ownKeys(value);
  for (const k of keys) {
    if (typeof k !== 'string') return bad();
    if (k === 'length') continue;
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d || !('value' in d)) return bad();
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= n || String(i) !== k) { if (d.enumerable) return bad(); }
  }
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d || !('value' in d)) return bad(); out.push(d.value); }
  return out;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || Buffer.from(value, 'utf8').toString('utf8') !== value) return bad();
  return value;
}
function context(key: string | Buffer, policy: MoneyPolicy, provenance: Readonly<Record<string, string>>) {
  if (!(typeof key === 'string' && key.length) && !(Buffer.isBuffer(key) && key.length)) return bad();
  const secret = Buffer.isBuffer(key) ? Buffer.from(key) : key;
  const p = fields(policy, 2, ['version', 'exponents']);
  if (typeof p.version !== 'string' || p.version.length > 64 || /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.exec(p.version)?.[0] !== p.version) return bad();
  const e = fields(p.exponents, 64), codes = Object.keys(e).sort(cmp);
  if (!codes.length) return bad();
  const exponents: Record<string, number> = Object.create(null);
  for (const code of codes) { const n = e[code]; if (!/^[A-Z]{3}$/.test(code) || code.length !== 3 || typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 18) return bad(); exponents[code] = n; }
  const copy: MoneyPolicy = Object.freeze({ version: p.version, exponents: Object.freeze(exponents) });
  const raw = fields(provenance, 100000), prov: Record<string, string> = Object.create(null);
  for (const k of Object.keys(raw).sort(cmp)) { const c = raw[k]; id(k); if (typeof c !== 'string' || !Object.hasOwn(exponents, c)) return bad(); prov[k] = c; }
  return { secret, policy: copy, provenance: Object.freeze(prov) };
}
function scopeValue(scope: AccountReadScope): { all: boolean; projects: string } {
  const s = fields(scope, 2);
  if (s.all === true && Object.keys(s).length === 1 && Object.hasOwn(s, 'all')) return { all: true, projects: '[]' };
  if (s.all !== false || Object.keys(s).length !== 2 || !Object.hasOwn(s, 'projectIds')) return bad();
  const projects = [...new Set(array(s.projectIds, 100000).map(id))].sort(cmp);
  return { all: false, projects: JSON.stringify(projects) };
}
function fence(d: BetterSqliteDatabase): string {
  if ((d.prepare('SELECT name FROM temp.sqlite_schema LIMIT 1').all() as Row[]).length || (d.prepare('PRAGMA main.foreign_keys').get() as Row).foreign_keys !== 1) return bad();
  return JSON.stringify([
    d.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name,tbl_name,sql').all(),
    d.prepare('SELECT version,name,checksum,applied_at FROM main.schema_migrations ORDER BY version').all(),
    d.prepare('SELECT * FROM main.money_format ORDER BY id').all(),
    d.prepare('SELECT transaction_id,currency FROM main.transaction_base_currencies ORDER BY transaction_id').all(),
  ]);
}
function totals(d: BetterSqliteDatabase): Row {
  const t = d.prepare('SELECT (SELECT count(*) FROM main.accounts)+(SELECT count(*) FROM main.transactions) AS n, (SELECT coalesce(sum(length(CAST(balance_encrypted AS BLOB))+coalesce(length(CAST(credit_limit_encrypted AS BLOB)),0)),0) FROM main.accounts)+(SELECT coalesce(sum(length(CAST(amount_encrypted AS BLOB))+length(CAST(base_amount_encrypted AS BLOB))),0) FROM main.transactions) AS bytes').get() as Row;
  if (t.n > 100000 || t.bytes > limit) return bad();
  return t;
}
export class ExactAccountMoneyRepository {
  private constructor(private readonly d: BetterSqliteDatabase, private readonly ctx: ReturnType<typeof context>, private readonly stamp: string) {}
  static open(d: BetterSqliteDatabase, key: string | Buffer, policy: MoneyPolicy, provenance: Readonly<Record<string, string>>): ExactAccountMoneyRepository {
    return safe(() => {
      const ctx = context(key, policy, provenance);
      if (d.inTransaction) return bad();
      return d.transaction(() => { verifyMoneyStore(d, ctx.secret, ctx.policy, ctx.provenance); return new ExactAccountMoneyRepository(d, ctx, fence(d)); }).immediate();
    });
  }
  private guard(): void { if (fence(this.d) !== this.stamp) bad(); }
  private rows(s: { all: boolean; projects: string }, targets: string | null): Row[] {
    return this.d.prepare('SELECT id,currency,balance_encrypted,credit_limit_encrypted,updated_at FROM main.accounts WHERE (? = 1 OR project_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR id IN (SELECT value FROM json_each(?)))').all(s.all ? 1 : 0, s.projects, targets, targets) as Row[];
  }
  private projection(r: Row): ExactAccountMoney {
    const accountId = id(r.id);
    if (typeof r.currency !== 'string' || !Object.hasOwn(this.ctx.policy.exponents, r.currency) || typeof r.updated_at !== 'string' || !r.updated_at.length) return bad();
    const balance = moneyFromMinor(decryptMoneyMinor(r.balance_encrypted, r.currency, this.ctx.policy, this.ctx.secret), r.currency, this.ctx.policy);
    const creditLimit = r.credit_limit_encrypted === null ? null : moneyFromMinor(decryptMoneyMinor(r.credit_limit_encrypted, r.currency, this.ctx.policy, this.ctx.secret), r.currency, this.ctx.policy);
    return { accountId, currency: r.currency, balance, creditLimit, updatedAt: r.updated_at };
  }
  getAccountMoneyInScope(accountId: string, scope: AccountReadScope): ExactAccountMoney | null {
    return safe(() => this.d.transaction(() => { const target = id(accountId), s = scopeValue(scope); this.guard(); const rows = this.rows(s, JSON.stringify([target])); if (rows.length > 1) return bad(); return rows.length ? this.projection(rows[0]!) : null; }).deferred());
  }
  listAccountMoneyInScope(scope: AccountReadScope): readonly ExactAccountMoney[] {
    return safe(() => this.d.transaction(() => { const s = scopeValue(scope); this.guard(); return this.rows(s, null).map(r => this.projection(r)).sort((a, b) => cmp(a.accountId, b.accountId)); }).deferred());
  }
  applyBalanceDeltasInScope(deltas: readonly ExactAccountBalanceDelta[], scope: AccountReadScope): readonly ExactAccountMoney[] {
    return safe(() => this.d.transaction(() => {
      const s = scopeValue(scope), sums = new Map<string, { currency: string; amount: bigint }>();
      for (const entry of array(deltas, 1000)) {
        const item = fields(entry, 2, ['accountId', 'delta']), accountId = id(item.accountId);
        const money = fields(item.delta, 5, ['version', 'policyVersion', 'currency', 'exponent', 'minor']);
        if (typeof money.currency !== 'string') return bad();
        const amount = moneyToMinor(money as unknown as MoneyV1, money.currency, this.ctx.policy), old = sums.get(accountId);
        if (old && old.currency !== money.currency) return bad();
        sums.set(accountId, { currency: money.currency, amount: (old?.amount ?? 0n) + amount });
      }
      this.guard();
      const ids = [...sums.keys()].sort(cmp), selected = this.rows(s, JSON.stringify(ids));
      if (selected.length !== ids.length) return bad();
      const byId = new Map(selected.map(r => [r.id as string, r]));
      const current = totals(this.d); let projected = current.bytes as number;
      const pending = ids.map(accountId => {
        const row = byId.get(accountId); if (!row) return bad();
        const original = this.projection(row), change = sums.get(accountId)!;
        if (original.currency !== change.currency) return bad();
        const final = moneyToMinor(original.balance, original.currency, this.ctx.policy) + change.amount;
        moneyFromMinor(final, original.currency, this.ctx.policy);
        const cipher = encryptMoneyMinor(final, original.currency, this.ctx.policy, this.ctx.secret);
        projected += Buffer.byteLength(cipher) - Buffer.byteLength(row.balance_encrypted);
        return { accountId, row, original, final, cipher };
      });
      if (projected > limit) return bad();
      const now = new Date().toISOString();
      for (const p of pending) if (this.d.prepare('UPDATE main.accounts SET balance_encrypted=?,updated_at=? WHERE id=?').run(p.cipher, now, p.accountId).changes !== 1) return bad();
      const reread = this.rows(s, JSON.stringify(ids));
      if (reread.length !== pending.length) return bad();
      const after = new Map(reread.map(r => [r.id as string, r]));
      const result = pending.map(p => {
        const row = after.get(p.accountId); if (!row || row.currency !== p.original.currency || row.updated_at !== now || row.balance_encrypted !== p.cipher || row.credit_limit_encrypted !== p.row.credit_limit_encrypted) return bad();
        const value = this.projection(row);
        if (moneyToMinor(value.balance, value.currency, this.ctx.policy) !== p.final || JSON.stringify(value.creditLimit) !== JSON.stringify(p.original.creditLimit)) return bad();
        return value;
      });
      totals(this.d);
      return result;
    }).immediate());
  }
}
export function openExactAccountMoneyRepository(d: BetterSqliteDatabase, key: string | Buffer, policy: MoneyPolicy, provenance: Readonly<Record<string, string>>): ExactAccountMoneyRepository {
  return ExactAccountMoneyRepository.open(d, key, policy, provenance);
}
