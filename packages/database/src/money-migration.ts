import { createHash } from 'node:crypto';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { encryptField, decryptField } from '@cost-core/crypto';
import { moneyFromMajorNumber, moneyToMinor, type MoneyPolicy } from '@cost-core/types';
import { encryptMoneyMinor, decryptMoneyMinor } from './money-codec.js';
import { MIGRATIONS, validateCurrentSchema } from './migrations.js';

const FORMAT = 'CREATE TABLE money_format (id INTEGER PRIMARY KEY CHECK (id = 1), format_version INTEGER NOT NULL CHECK (format_version = 1), transform_version TEXT NOT NULL, policy_version TEXT NOT NULL, policy_json TEXT NOT NULL, policy_hash TEXT NOT NULL, provenance_hash TEXT NOT NULL, key_check_encrypted TEXT NOT NULL, migrated_at TEXT NOT NULL)';
const PROVENANCE = 'CREATE TABLE transaction_base_currencies (transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, currency TEXT NOT NULL)';
const hash = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
export const MONEY_MIGRATION_V4 = Object.freeze({ version: 4 as const, name: 'exact-money-v1' as const, checksum: hash(JSON.stringify(['costcore-money-migration-v4', 'exact-money-v1', 'money-v1', 'legacy-finite-json-number-exact', 'sql-null-credit-limit-preserved', 'explicit-exhaustive-base-currency', 'key-check-v1', 'post-write-db-readback', 'limits-100000-67108864-4096', FORMAT, PROVENANCE])) });
const fail = (): never => { throw new Error('Money migration failed'); };
const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const LIMIT = 67108864;
type Row = Record<string, any>;
function fields(value: unknown, limit: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > limit || keys.some(k => typeof k !== 'string')) return fail();
  const out: Record<string, unknown> = Object.create(null);
  for (const k of keys as string[]) { const d = Object.getOwnPropertyDescriptor(value, k); if (!d || !('value' in d)) return fail(); out[k] = d.value; }
  return out;
}
function validId(id: string): boolean { return id.length > 0 && id.length <= 128 && id.trim().length > 0 && Buffer.from(id, 'utf8').toString('utf8') === id; }
function snapshotInputs(key: string | Buffer, input: MoneyPolicy, provenance: Readonly<Record<string, string>>) {
  if (!(typeof key === 'string' && key.length > 0) && !(Buffer.isBuffer(key) && key.length > 0)) return fail();
  const secret = Buffer.isBuffer(key) ? Buffer.from(key) : key;
  const raw = fields(input, 2);
  if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, 'version') || !Object.hasOwn(raw, 'exponents')) return fail();
  if (typeof raw.version !== 'string' || raw.version.length > 64 || /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.exec(raw.version)?.[0] !== raw.version) return fail();
  const ex = fields(raw.exponents, 64), codes = Object.keys(ex).sort(cmp);
  if (!codes.length) return fail();
  const exponents: Record<string, number> = Object.create(null);
  for (const code of codes) { const n = ex[code]; if (code.length !== 3 || !/^[A-Z]{3}$/.test(code) || typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 18) return fail(); exponents[code] = n; }
  const policy: MoneyPolicy = { version: raw.version, exponents };
  const src = fields(provenance, 100000), pairs: [string, string][] = [];
  for (const id of Object.keys(src).sort(cmp)) { const currency = src[id]; if (!validId(id) || typeof currency !== 'string' || !Object.hasOwn(exponents, currency)) return fail(); pairs.push([id, currency]); }
  return { secret, policy, pairs, policyJson: JSON.stringify(policy), provenanceHash: hash(JSON.stringify(pairs)) };
}
function envelope(value: unknown): value is string { if (typeof value !== 'string' || value.length > 4096) return false; const match = /^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:(?:[0-9a-f]{2})+$/.exec(value); return !!match && match[0] === value; }
function schema(d: BetterSqliteDatabase): boolean {
  if ((d.prepare('SELECT name FROM temp.sqlite_master LIMIT 1').all() as Row[]).length) return fail();
  const objects = d.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name COLLATE NOCASE IN ('accounts','transactions','schema_migrations','money_format','transaction_base_currencies') OR (type='trigger' AND tbl_name COLLATE NOCASE IN ('accounts','transactions','schema_migrations','money_format','transaction_base_currencies'))").all() as Row[];
  if (objects.some(x => x.type === 'trigger')) return fail();
  for (const name of ['accounts', 'transactions', 'schema_migrations']) {
    const matches = objects.filter(x => x.name.toLowerCase() === name);
    if (matches.length !== 1 || matches[0].name !== name || matches[0].type !== 'table' || /^CREATE[^A-Za-z]+VIRTUAL/i.test(matches[0].sql || '')) return fail();
  }
  const format = objects.filter(x => x.name.toLowerCase() === 'money_format');
  const prov = objects.filter(x => x.name.toLowerCase() === 'transaction_base_currencies');
  if (format.length > 1 || prov.length > 1 || format.length !== prov.length) return fail();
  const present = format.length === 1;
  if (present && (format[0].name !== 'money_format' || format[0].type !== 'table' || format[0].sql !== FORMAT || prov[0].name !== 'transaction_base_currencies' || prov[0].type !== 'table' || prov[0].sql !== PROVENANCE)) return fail();
  const cols = (table: string): Row[] => d.prepare("SELECT * FROM pragma_table_xinfo(?, 'main')").all(table) as Row[];
  for (const table of ['accounts', 'transactions', 'schema_migrations', ...(present ? ['money_format', 'transaction_base_currencies'] : [])]) {
    const rows = cols(table); if (!rows.length || rows.some(x => x.hidden !== 0)) return fail();
  }
  const check = (table: string, expected: Record<string, [string, number, number]>, exact = false): void => {
    const rows = cols(table); if (exact && rows.length !== Object.keys(expected).length) return fail();
    for (const [name, spec] of Object.entries(expected)) { const c = rows.find(x => x.name === name); if (!c || c.type.toUpperCase() !== spec[0] || c.notnull !== spec[1] || c.pk !== spec[2]) return fail(); }
  };
  check('accounts', { id: ['TEXT', 0, 1], currency: ['TEXT', 1, 0], balance_encrypted: ['TEXT', 1, 0], credit_limit_encrypted: ['TEXT', 0, 0] });
  check('transactions', { id: ['TEXT', 0, 1], currency: ['TEXT', 1, 0], amount_encrypted: ['TEXT', 1, 0], base_amount_encrypted: ['TEXT', 1, 0] });
  check('schema_migrations', { version: ['INTEGER', 0, 1], name: ['TEXT', 1, 0], checksum: ['TEXT', 1, 0], applied_at: ['TEXT', 1, 0] }, true);
  if (present) {
    check('money_format', { id: ['INTEGER', 0, 1], format_version: ['INTEGER', 1, 0], transform_version: ['TEXT', 1, 0], policy_version: ['TEXT', 1, 0], policy_json: ['TEXT', 1, 0], policy_hash: ['TEXT', 1, 0], provenance_hash: ['TEXT', 1, 0], key_check_encrypted: ['TEXT', 1, 0], migrated_at: ['TEXT', 1, 0] }, true);
    check('transaction_base_currencies', { transaction_id: ['TEXT', 1, 1], currency: ['TEXT', 1, 0] }, true);
    const indexes = d.prepare('PRAGMA main.index_list(transaction_base_currencies)').all() as Row[];
    if (indexes.length !== 1 || indexes[0].unique !== 1 || indexes[0].origin !== 'pk' || indexes[0].partial !== 0) return fail();
    const indexCols = d.prepare("SELECT name FROM pragma_index_info(?, 'main') ORDER BY seqno").all(indexes[0].name) as Row[];
    if (indexCols.length !== 1 || indexCols[0].name !== 'transaction_id') return fail();
    if ((d.prepare('PRAGMA main.index_list(money_format)').all() as Row[]).length !== 0) return fail();
    const fk = d.prepare('PRAGMA main.foreign_key_list(transaction_base_currencies)').all() as Row[];
    if (fk.length !== 1 || fk[0].table !== 'transactions' || fk[0].from !== 'transaction_id' || fk[0].to !== 'id' || fk[0].on_delete !== 'CASCADE') return fail();
    if ((d.prepare('PRAGMA main.foreign_key_list(money_format)').all() as Row[]).length) return fail();
  }
  validateCurrentSchema(d);
  return present;
}
function history(d: BetterSqliteDatabase, present: boolean): Row[] {
  const rows = d.prepare('SELECT version,name,checksum,applied_at FROM main.schema_migrations ORDER BY version').all() as Row[];
  const expected = present ? [...MIGRATIONS, MONEY_MIGRATION_V4] : MIGRATIONS;
  if (rows.length !== expected.length) return fail();
  for (let i = 0; i < rows.length; i++) { const a = rows[i], b = expected[i]; if (a.version !== b.version || a.name !== b.name || a.checksum !== b.checksum || typeof a.applied_at !== 'string' || !a.applied_at.length) return fail(); }
  return rows;
}
function moneyCore(d: BetterSqliteDatabase, input: ReturnType<typeof snapshotInputs>, verifyOnly: boolean): { status: 'migrated' | 'verified'; accounts: number; transactions: number; encryptedFields: number } {
    if (!d.inTransaction) return fail();
    if ((d.prepare('PRAGMA main.foreign_keys').get() as Row).foreign_keys !== 1) return fail();
    const present = schema(d), initialHistory = history(d, present);
    if (verifyOnly && !present) return fail();
    const counts = d.prepare('SELECT (SELECT count(*) FROM main.accounts) AS a, (SELECT count(*) FROM main.transactions) AS t, (SELECT coalesce(sum(length(CAST(balance_encrypted AS BLOB))+coalesce(length(CAST(credit_limit_encrypted AS BLOB)),0)),0) FROM main.accounts)+(SELECT coalesce(sum(length(CAST(amount_encrypted AS BLOB))+length(CAST(base_amount_encrypted AS BLOB))),0) FROM main.transactions) AS bytes').get() as Row;
    if (counts.a + counts.t > 100000 || counts.bytes > LIMIT) return fail();
    const invalid = d.prepare("SELECT (SELECT count(*) FROM main.accounts WHERE typeof(balance_encrypted) != 'text' OR length(balance_encrypted) > 4096 OR (credit_limit_encrypted IS NOT NULL AND (typeof(credit_limit_encrypted) != 'text' OR length(credit_limit_encrypted) > 4096))) + (SELECT count(*) FROM main.transactions WHERE typeof(amount_encrypted) != 'text' OR length(amount_encrypted) > 4096 OR typeof(base_amount_encrypted) != 'text' OR length(base_amount_encrypted) > 4096) AS n").get() as Row;
    if (invalid.n) return fail();
    const accounts = d.prepare('SELECT id,currency,balance_encrypted,credit_limit_encrypted FROM main.accounts ORDER BY id').all() as Row[];
    const transactions = d.prepare('SELECT id,currency,amount_encrypted,base_amount_encrypted FROM main.transactions ORDER BY id').all() as Row[];
    const map = new Map(input.pairs);
    if (map.size !== transactions.length) return fail();
    for (const r of [...accounts, ...transactions]) if (typeof r.id !== 'string' || !validId(r.id) || typeof r.currency !== 'string' || !Object.hasOwn(input.policy.exponents, r.currency)) return fail();
    for (const r of transactions) if (!map.has(r.id)) return fail();
    const verifyMetadata = (expectedTime?: string, expectedCanary?: string): void => {
      const h = history(d, true), rows = d.prepare('SELECT * FROM main.money_format').all() as Row[];
      if (rows.length !== 1) return fail();
      const m = rows[0];
      if (typeof m.migrated_at !== 'string') return fail();
      const timestamp = new Date(m.migrated_at);
      if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== m.migrated_at) return fail();
      if (m.id !== 1 || m.format_version !== 1 || m.transform_version !== MONEY_MIGRATION_V4.name || m.policy_version !== input.policy.version || m.policy_json !== input.policyJson || m.policy_hash !== hash(input.policyJson) || m.provenance_hash !== input.provenanceHash || m.migrated_at !== h[3].applied_at || (expectedTime !== undefined && m.migrated_at !== expectedTime) || (expectedCanary !== undefined && m.key_check_encrypted !== expectedCanary) || !envelope(m.key_check_encrypted) || decryptField(m.key_check_encrypted, input.secret) !== 'costcore:exact-money-v1:key-check') return fail();
      const pairs = (d.prepare('SELECT transaction_id,currency FROM main.transaction_base_currencies').all() as Row[]).map(r => [r.transaction_id, r.currency]).sort((a, b) => cmp(a[0], b[0]));
      if (JSON.stringify(pairs) !== JSON.stringify(input.pairs)) return fail();
      for (let i = 0; i < 3; i++) if (JSON.stringify(h[i]) !== JSON.stringify(initialHistory[i])) return fail();
      if (present && JSON.stringify(h[3]) !== JSON.stringify(initialHistory[3])) return fail();
    };
    if (present) verifyMetadata();
    const expected: Array<{ id: string; currency: string; fields: Array<[string | null, bigint | null]> }> = [];
    let encryptedFields = 0, outputBytes = 0;
    const convert = (value: unknown, currency: string): [string, bigint] => {
      if (!envelope(value)) return fail();
      let minor: bigint;
      if (present) minor = decryptMoneyMinor(value, currency, input.policy, input.secret);
      else { const n = decryptField<unknown>(value, input.secret); if (typeof n !== 'number' || !Number.isFinite(n)) return fail(); minor = moneyToMinor(moneyFromMajorNumber(n, currency, input.policy), currency, input.policy); }
      const encrypted = present ? value : encryptMoneyMinor(minor, currency, input.policy, input.secret);
      outputBytes += Buffer.byteLength(encrypted); if (outputBytes > LIMIT || !envelope(encrypted)) return fail();
      encryptedFields++; return [encrypted, minor];
    };
    for (const r of accounts) {
      const b = convert(r.balance_encrypted, r.currency), c = r.credit_limit_encrypted === null ? [null, null] as [null, null] : convert(r.credit_limit_encrypted, r.currency);
      expected.push({ id: r.id, currency: r.currency, fields: [b, c] });
      if (!present && d.prepare('UPDATE main.accounts SET balance_encrypted=?,credit_limit_encrypted=? WHERE id=?').run(b[0], c[0], r.id).changes !== 1) return fail();
    }
    for (const r of transactions) {
      const a = convert(r.amount_encrypted, r.currency), b = convert(r.base_amount_encrypted, map.get(r.id)!);
      expected.push({ id: r.id, currency: r.currency, fields: [a, b] });
      if (!present && d.prepare('UPDATE main.transactions SET amount_encrypted=?,base_amount_encrypted=? WHERE id=?').run(a[0], b[0], r.id).changes !== 1) return fail();
    }
    let now: string | undefined, canary: string | undefined;
    if (!present) {
      d.exec('CREATE TABLE main.money_format (id INTEGER PRIMARY KEY CHECK (id = 1), format_version INTEGER NOT NULL CHECK (format_version = 1), transform_version TEXT NOT NULL, policy_version TEXT NOT NULL, policy_json TEXT NOT NULL, policy_hash TEXT NOT NULL, provenance_hash TEXT NOT NULL, key_check_encrypted TEXT NOT NULL, migrated_at TEXT NOT NULL)');
      d.exec('CREATE TABLE main.transaction_base_currencies (transaction_id TEXT PRIMARY KEY NOT NULL REFERENCES transactions(id) ON DELETE CASCADE, currency TEXT NOT NULL)');
      for (const [id, currency] of input.pairs) d.prepare('INSERT INTO main.transaction_base_currencies (transaction_id,currency) VALUES (?,?)').run(id, currency);
      now = new Date().toISOString(); canary = encryptField('costcore:exact-money-v1:key-check', input.secret);
      d.prepare('INSERT INTO main.money_format (id,format_version,transform_version,policy_version,policy_json,policy_hash,provenance_hash,key_check_encrypted,migrated_at) VALUES (1,1,?,?,?,?,?,?,?)').run(MONEY_MIGRATION_V4.name, input.policy.version, input.policyJson, hash(input.policyJson), input.provenanceHash, canary, now);
      d.prepare('INSERT INTO main.schema_migrations (version,name,checksum,applied_at) VALUES (?,?,?,?)').run(4, MONEY_MIGRATION_V4.name, MONEY_MIGRATION_V4.checksum, now);
    }
    const rereadA = d.prepare('SELECT id,currency,balance_encrypted,credit_limit_encrypted FROM main.accounts ORDER BY id').all() as Row[];
    const rereadT = d.prepare('SELECT id,currency,amount_encrypted,base_amount_encrypted FROM main.transactions ORDER BY id').all() as Row[];
    if (rereadA.length !== accounts.length || rereadT.length !== transactions.length) return fail();
    for (let i = 0; i < expected.length; i++) {
      const e = expected[i], isAccount = i < accounts.length, r = isAccount ? rereadA[i] : rereadT[i - accounts.length];
      const vals = isAccount ? [r.balance_encrypted, r.credit_limit_encrypted] : [r.amount_encrypted, r.base_amount_encrypted];
      if (r.id !== e.id || r.currency !== e.currency) return fail();
      for (let j = 0; j < 2; j++) { const [cipher, minor] = e.fields[j]; if (minor === null) { if (vals[j] !== null) return fail(); } else if (vals[j] !== cipher || decryptMoneyMinor(vals[j], isAccount || j === 0 ? r.currency : map.get(r.id)!, input.policy, input.secret) !== minor) return fail(); }
    }
    if (!schema(d)) return fail();
    verifyMetadata(now, canary);
    if ((d.prepare('PRAGMA main.foreign_key_check').all() as Row[]).length) return fail();
    return { status: present ? 'verified' : 'migrated', accounts: accounts.length, transactions: transactions.length, encryptedFields };
}
function sanitized(e: unknown): Error {
  const safe = new Error('Money migration failed');
  try {
    if (e && typeof e === 'object') {
      const descriptor = Object.getOwnPropertyDescriptor(e, 'code');
      if (descriptor && 'value' in descriptor && descriptor.value === 'SQLITE_BUSY') (safe as Error & { code: string }).code = 'SQLITE_BUSY';
    }
  } catch {}
  return safe;
}
export function migrateMoneyOffline(d: BetterSqliteDatabase, key: string | Buffer, policy: MoneyPolicy, provenance: Readonly<Record<string, string>>): { status: 'migrated' | 'verified'; accounts: number; transactions: number; encryptedFields: number } {
  let started = false;
  try {
    const input = snapshotInputs(key, policy, provenance);
    if (d.inTransaction) return fail();
    d.exec('BEGIN IMMEDIATE'); started = true;
    const result = moneyCore(d, input, false);
    d.exec('COMMIT'); started = false;
    return result;
  } catch (e) {
    if (started) { try { d.exec('ROLLBACK'); } catch {} }
    throw sanitized(e);
  }
}
export function verifyMoneyStore(d: BetterSqliteDatabase, key: string | Buffer, policy: MoneyPolicy, provenance: Readonly<Record<string, string>>): { status: 'verified'; accounts: number; transactions: number; encryptedFields: number } {
  try {
    const input = snapshotInputs(key, policy, provenance);
    const result = d.transaction(() => moneyCore(d, input, true)).immediate();
    if (result.status !== 'verified') return fail();
    return { ...result, status: 'verified' };
  } catch (e) { throw sanitized(e); }
}
