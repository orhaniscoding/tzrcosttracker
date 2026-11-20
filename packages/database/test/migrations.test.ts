import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { initDatabase } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.js";
import { encryptField, decryptField } from "@cost-core/crypto";

const dirs: string[] = [];
const openDbs: Array<{ close: () => void }> = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "costcore-mig-"));
  dirs.push(dir);
  return join(dir, "test.db");
}
function track<T extends { sqlite: { close: () => void } }>(v: T): T {
  openDbs.push(v.sqlite);
  return v;
}
afterEach(() => {
  while (openDbs.length) { try { openDbs.pop()?.close(); } catch {} }
  while (dirs.length) {
    const d = dirs.pop();
    if (!d) continue;
    const target = realpathSync(resolve(d));
    const tmpRoot = realpathSync(resolve(tmpdir()));
    if (target.startsWith(tmpRoot + sep) && basename(target).startsWith('costcore-mig-')) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});
function raw(path: string): InstanceType<typeof Database> {
  const db = new Database(path);
  openDbs.push(db);
  return db;
}

const LEGACY_DDL = [
  "CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', is_active INTEGER NOT NULL DEFAULT 1, two_factor_enabled INTEGER NOT NULL DEFAULT 0, two_factor_secret TEXT, two_factor_backup_codes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, description TEXT, budget REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'TRY', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE parties (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_blind_index TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'supplier', phone TEXT, email TEXT, iban TEXT, tax_no TEXT, tax_office TEXT, notes TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_blind_index TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'cash', currency TEXT NOT NULL DEFAULT 'TRY', balance_encrypted TEXT NOT NULL, iban_encrypted TEXT, bank_name TEXT, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, parent_id TEXT, description TEXT, color TEXT NOT NULL DEFAULT '#3B82F6', icon TEXT NOT NULL DEFAULT 'folder', order_index INTEGER NOT NULL DEFAULT 0, custom_field_ids TEXT NOT NULL DEFAULT '[]', is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE custom_fields (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, label TEXT NOT NULL, type TEXT NOT NULL, options_json TEXT, unit TEXT, required INTEGER NOT NULL DEFAULT 0, placeholder TEXT, default_value TEXT, created_at TEXT NOT NULL)",
  "CREATE TABLE transactions (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'expense', date TEXT NOT NULL, amount_encrypted TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'TRY', exchange_rate REAL NOT NULL DEFAULT 1.0, base_amount_encrypted TEXT NOT NULL, category_id TEXT NOT NULL, subcategory_id TEXT, title_encrypted TEXT NOT NULL, title_blind_index TEXT NOT NULL, description_encrypted TEXT, party_encrypted TEXT, party_blind_index TEXT, account_from_id TEXT, account_to_id TEXT, custom_values_encrypted TEXT NOT NULL DEFAULT '', attachments_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'approved', created_by_id TEXT NOT NULL, approved_by_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, timestamp TEXT NOT NULL, ip_address TEXT, user_agent TEXT, diff_encrypted TEXT, hash TEXT NOT NULL, previous_hash TEXT)",
  "CREATE TABLE white_label_settings (id TEXT PRIMARY KEY DEFAULT 'global', company_name TEXT NOT NULL DEFAULT 'TZRCoster Finance', app_title TEXT NOT NULL DEFAULT 'TZRCoster', logo_url TEXT, favicon_url TEXT, background_url TEXT, primary_color TEXT NOT NULL DEFAULT '#2563EB', secondary_color TEXT NOT NULL DEFAULT '#1E40AF', default_theme TEXT NOT NULL DEFAULT 'dark', base_currency TEXT NOT NULL DEFAULT 'TRY', date_format TEXT NOT NULL DEFAULT 'DD.MM.YYYY', updated_at TEXT NOT NULL)",
  "CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)",
];

function snap(db: InstanceType<typeof Database>) {
  return {
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    hist: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
    users: db.prepare('SELECT * FROM users ORDER BY id').all(),
  };
}
describe("schema migrations v1", () => {
  it("fresh DB creates history v1 and core schema", () => {
    const path = tempPath();
    const inst = track(initDatabase({ path }));
    const hist = inst.sqlite.prepare("SELECT version, name, checksum, applied_at FROM schema_migrations").all() as any[];
    expect(hist).toHaveLength(3);
    expect(hist[0].version).toBe(1);
    expect(hist[0].name).toBe("initial-schema");
    expect(hist[0].checksum).toBe(MIGRATIONS[0].checksum);
    expect(typeof hist[0].applied_at).toBe("string");
    expect(hist[1].version).toBe(2);
    expect(hist[1].name).toBe('project-memberships');
    expect(hist[1].checksum).toBe(MIGRATIONS[1].checksum);
    expect(hist[2].version).toBe(3);
    expect(hist[2].name).toBe('account-project-scope');
    expect(hist[2].checksum).toBe(MIGRATIONS[2].checksum);
    const tables = (inst.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    expect(tables).toContain("users");
    expect(tables).toContain("transactions");
    expect(tables).toContain("auth_sessions");
    const fk = inst.sqlite.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
    inst.sqlite.close(); openDbs.pop();
  });
  it("reopen is no-op: history, applied_at and rows unchanged", () => {
    const path = tempPath();
    const first = track(initDatabase({ path }));
    first.sqlite.prepare("INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES ('u1','alice','a@test','Alice','hash','2024-01-01','2024-01-01')").run();
    const before = first.sqlite.prepare("SELECT * FROM schema_migrations").all();
    first.sqlite.close(); openDbs.pop();
    const second = track(initDatabase({ path }));
    const after = second.sqlite.prepare("SELECT * FROM schema_migrations").all();
    expect(after).toEqual(before);
    const user = second.sqlite.prepare("SELECT username FROM users WHERE id='u1'").get() as any;
    expect(user.username).toBe("alice");
    second.sqlite.close(); openDbs.pop();
  });
  it("legacy unversioned DB upgrades, preserves rows, ciphertext, audit rowids", () => {
    const path = tempPath();
    const seed = raw(path);
    for (const ddl of LEGACY_DDL) seed.exec(ddl);
    seed.prepare("INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES ('u1','bob','b@test','Bob','ph','2024-01-01','2024-01-01')").run();
    seed.prepare("INSERT INTO categories (id, name, created_at, updated_at) VALUES ('c1','Cat','2024-01-01','2024-01-01')").run();
    seed.prepare("INSERT INTO transactions (id, date, amount_encrypted, base_amount_encrypted, category_id, title_encrypted, title_blind_index, created_by_id, created_at, updated_at) VALUES ('t1','2024-02-01','CIPHER-AMOUNT-XYZ','CIPHER-BASE-XYZ','c1','CIPHER-TITLE','bidx1','u1','2024-02-01','2024-02-01')").run();
    seed.prepare("INSERT INTO audit_logs (id, user_id, action, entity, timestamp, hash) VALUES ('a1','u1','create','tx','2024-02-01T00:00:00Z','h1')").run();
    seed.prepare("INSERT INTO audit_logs (id, user_id, action, entity, timestamp, hash) VALUES ('a2','u1','update','tx','2024-02-02T00:00:00Z','h2')").run();
    const auditBefore = seed.prepare("SELECT rowid, id FROM audit_logs ORDER BY rowid").all();
    seed.prepare("INSERT INTO auth_sessions (id, user_id, created_at, expires_at) VALUES ('s1','u1',100,999999)").run();
    seed.close(); openDbs.pop();
    const inst = track(initDatabase({ path }));
    const tx = inst.sqlite.prepare("SELECT amount_encrypted, payment_source, payment_method, is_paid FROM transactions WHERE id='t1'").get() as any;
    expect(tx.amount_encrypted).toBe("CIPHER-AMOUNT-XYZ");
    expect(tx.payment_source).toBe("company_account");
    expect(tx.payment_method).toBe("Banka");
    expect(tx.is_paid).toBe(1);
    const u = inst.sqlite.prepare("SELECT pin_hash FROM users WHERE id='u1'").get() as any;
    expect(u.pin_hash).toBeNull();
    const auditAfter = inst.sqlite.prepare("SELECT rowid, id FROM audit_logs ORDER BY rowid").all();
    expect(auditAfter).toEqual(auditBefore);
    const sess = inst.sqlite.prepare("SELECT user_id FROM auth_sessions WHERE id='s1'").get() as any;
    expect(sess.user_id).toBe("u1");
    const hist = inst.sqlite.prepare("SELECT version FROM schema_migrations").all() as any[];
    expect(hist).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    inst.sqlite.close(); openDbs.pop();
  });
  it('mid-migration failure rolls back and repair retry succeeds', () => {
    const path = tempPath();
    const seed = raw(path);
    seed.exec(LEGACY_DDL[0]);
    seed.exec('CREATE TABLE transactions (id TEXT PRIMARY KEY)');
    seed.prepare("INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES ('u1','carol','c@test','Carol','hash','2024-01-01','2024-01-01')").run();
    const schemaBefore = seed.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all();
    const userBefore = seed.prepare("SELECT * FROM users WHERE id='u1'").get() as any;
    seed.close(); openDbs.pop();
    expect(() => initDatabase({ path })).toThrow();
    const check = raw(path);
    expect(check.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all()).toEqual(schemaBefore);
    expect(check.prepare("SELECT * FROM users WHERE id='u1'").get()).toEqual(userBefore);
    const cols = (check.prepare("SELECT name FROM pragma_table_info('users')").all() as any[]).map((r) => r.name);
    expect(cols).not.toContain('pin_hash');
    const names = (check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    expect(names).not.toContain('schema_migrations');
    expect(names).not.toContain('projects');
    check.exec('DROP TABLE transactions');
    check.exec(LEGACY_DDL[6]);
    check.close(); openDbs.pop();
    const inst = track(initDatabase({ path }));
    expect(inst.sqlite.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(inst.sqlite.prepare("SELECT * FROM users WHERE id='u1'").get()).toEqual({ ...userBefore, pin_hash: null });
    inst.sqlite.close(); openDbs.pop();
  });
  it('empty schema_migrations table migrates to v1 and reopen is no-op', () => {
    const path = tempPath();
    const seed = raw(path);
    seed.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    expect(seed.prepare('SELECT * FROM schema_migrations').all()).toEqual([]);
    seed.close(); openDbs.pop();
    const first = track(initDatabase({ path }));
    const hist1 = first.sqlite.prepare('SELECT * FROM schema_migrations').all() as any[];
    expect(hist1).toHaveLength(3);
    expect(hist1[0].version).toBe(1);
    expect(hist1[0].name).toBe('initial-schema');
    expect(hist1[0].checksum).toBe(MIGRATIONS[0].checksum);
    expect(hist1[1].version).toBe(2);
    expect(hist1[1].name).toBe('project-memberships');
    expect(hist1[1].checksum).toBe(MIGRATIONS[1].checksum);
    expect(hist1[2].version).toBe(3);
    expect(hist1[2].name).toBe('account-project-scope');
    expect(hist1[2].checksum).toBe(MIGRATIONS[2].checksum);
    const schema1 = first.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    first.sqlite.close(); openDbs.pop();
    const second = track(initDatabase({ path }));
    expect(second.sqlite.prepare('SELECT * FROM schema_migrations').all()).toEqual(hist1);
    expect(second.sqlite.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(schema1);
    second.sqlite.close(); openDbs.pop();
  });
  it('tampered checksum is rejected and DB is unchanged', () => {
    const path = tempPath();
    const seed = track(initDatabase({ path }));
    seed.sqlite.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('u1','dave','d@test','Dave','hash','2024-01-01','2024-01-01');
    seed.sqlite.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run('tampered-checksum', 1);
    const before = snap(seed.sqlite);
    seed.sqlite.close(); openDbs.pop();
    expect(() => initDatabase({ path })).toThrow(/checksum/);
    const check = raw(path);
    expect(snap(check)).toEqual(before);
    check.close(); openDbs.pop();
  });
  it('unsupported future version 999 is rejected and DB is unchanged', () => {
    const path = tempPath();
    const seed = track(initDatabase({ path }));
    seed.sqlite.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('u1','erin','e@test','Erin','hash','2024-01-01','2024-01-01');
    seed.sqlite.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(999,'future','future-checksum','2999-01-01T00:00:00.000Z');
    const before = snap(seed.sqlite);
    seed.sqlite.close(); openDbs.pop();
    expect(() => initDatabase({ path })).toThrow(/out of sequence|unsupported/);
    const check = raw(path);
    expect(snap(check)).toEqual(before);
    check.close(); openDbs.pop();
  });
  it.each([
    { table: 'projects', drop: 'DROP TABLE projects' },
    { table: 'parties', drop: 'DROP TABLE parties' },
    { table: 'custom_fields', drop: 'DROP TABLE custom_fields' },
    { table: 'white_label_settings', drop: 'DROP TABLE white_label_settings' },
  ])('valid v1 missing table is rejected without repair', ({ table, drop }) => {
    const path = tempPath();
    const seed = track(initDatabase({ path }));
    seed.sqlite.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('u1', 'fred', 'f@test', 'Fred', 'hash', '2024-01-01', '2024-01-01');
    seed.sqlite.exec(drop);
    const before = snap(seed.sqlite);
    seed.sqlite.close(); openDbs.pop();
    expect(() => initDatabase({ path })).toThrow(new RegExp('missing required table ' + table));
    const check = raw(path);
    expect(snap(check)).toEqual(before);
    const names = (check.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table') as any[]).map((r) => r.name);
    expect(names).not.toContain(table);
    check.close(); openDbs.pop();
  });
  it('valid v1 with missing required column is rejected without repair', () => {
    const path = tempPath();
    const seed = track(initDatabase({ path }));
    seed.sqlite.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('u1', 'gina', 'g@test', 'Gina', 'hash', '2024-01-01', '2024-01-01');
    try { seed.sqlite.exec('ALTER TABLE auth_sessions DROP COLUMN created_at'); } catch (err: any) { throw new Error('DROP COLUMN unsupported: ' + String(err && err.message ? err.message : err)); }
    const before = snap(seed.sqlite);
    seed.sqlite.close(); openDbs.pop();
    expect(() => initDatabase({ path })).toThrow(/missing required column auth_sessions.created_at/);
    const check = raw(path);
    expect(snap(check)).toEqual(before);
    check.close(); openDbs.pop();
  });
  it('valid v1 with real FK violation row is rejected and row survives', () => {
    const path = tempPath();
    const seed = track(initDatabase({ path }));
    seed.sqlite.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('u1', 'hank', 'h@test', 'Hank', 'hash', '2024-01-01', '2024-01-01');
    seed.sqlite.close(); openDbs.pop();
    const own = raw(path);
    own.pragma('foreign_keys = OFF');
    own.prepare('INSERT INTO auth_sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run('sBad', 'ghost-user', 100, 999999);
    const before = snap(own);
    const rowsBefore = own.prepare('SELECT * FROM auth_sessions ORDER BY id').all();
    own.close(); openDbs.pop();
    let caught: unknown = null;
    try { initDatabase({ path }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/foreign key check failed: 1 violation/);
    const check = raw(path);
    expect(snap(check)).toEqual(before);
    expect(check.prepare('SELECT * FROM auth_sessions ORDER BY id').all()).toEqual(rowsBefore);
    check.close(); openDbs.pop();
  });
  it('legacy AES-encrypted amount survives upgrade and decrypts', () => {
    const path = tempPath();
    const key = 'synthetic-test-key-32-characters!!'; const amount = 12345;
    const seed = raw(path);
    for (const ddl of LEGACY_DDL) seed.exec(ddl);
    seed.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('u1', 'ivan', 'i@test', 'Ivan', 'hash', '2024-01-01', '2024-01-01');
    seed.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('c1', 'Cat', '2024-01-01', '2024-01-01');
    const cipher = encryptField(amount, key);
    seed.prepare('INSERT INTO transactions (id, date, amount_encrypted, base_amount_encrypted, category_id, title_encrypted, title_blind_index, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('tAes', '2024-03-01', cipher, cipher, 'c1', 'CIPHER-TITLE', 'bidxAes', 'u1', '2024-03-01', '2024-03-01');
    seed.close(); openDbs.pop();
    const inst = track(initDatabase({ path }));
    const row = inst.sqlite.prepare('SELECT amount_encrypted FROM transactions WHERE id = ?').get('tAes') as any;
    expect(row.amount_encrypted).toBe(cipher);
    expect(String(decryptField(row.amount_encrypted, key))).toBe(String(amount));
    inst.sqlite.close(); openDbs.pop();
  });
});
