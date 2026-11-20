import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { initDatabase } from '../src/index.js';
import { MIGRATIONS } from '../src/migrations.js';

const PREFIX = `costcore-ap-`;
const V1_CHECKSUM = `e74319f5516c71f568958eaa081e737dd671711e8823c1bbe8fea7e6d9dcf927`;
const V2_CHECKSUM = `a6e28ed95246964c3f7466a26e7ec3519e8b024559bbabb24152ad4c46337b33`;
const dirs: string[] = [];
const openDbs: Array<{ close: () => void }> = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  dirs.push(dir);
  return join(dir, `test.db`);
}
function raw(path: string): InstanceType<typeof Database> {
  const db = new Database(path);
  openDbs.push(db);
  return db;
}
function track<T extends { sqlite: { close: () => void } }>(v: T): T {
  openDbs.push(v.sqlite);
  return v;
}
function drop(db: { close: () => void }): void {
  db.close();
  openDbs.pop();
}
afterEach(() => {
  while (openDbs.length) { try { openDbs.pop()?.close(); } catch {} }
  while (dirs.length) {
    const d = dirs.pop();
    if (!d) continue;
    const target = realpathSync(resolve(d));
    const root = realpathSync(resolve(tmpdir()));
    if (target.startsWith(root + sep) && basename(target).startsWith(PREFIX)) rmSync(target, { recursive: true, force: true });
  }
});

function seedUser(db: any, id: string, username: string): void {
  db.prepare(`INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`).run(id, username, username + `@test`, username, `h`, `2024-01-01`, `2024-01-01`);
}
function seedProject(db: any, id: string): void {
  db.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)`).run(id, `Site ` + id, `2024-01-01`, `2024-01-01`);
}
function seedAccount(db: any, id: string, cipher: string): void {
  db.prepare(`INSERT INTO accounts (id, name, name_blind_index, type, currency, balance_encrypted, iban_encrypted, bank_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, `Acc ` + id, `bidx-` + id, `cash`, `TRY`, cipher, `CIPHER-IBAN-` + id, `Bank`, `2024-01-01`, `2024-01-01`);
}
function stripV3(db: any): void {
  db.exec(`DROP INDEX idx_accounts_project`);
  db.exec(`ALTER TABLE accounts DROP COLUMN project_id`);
  db.prepare(`DELETE FROM schema_migrations WHERE version = 3`).run();
}
function v2Fixture(): string {
  const path = tempPath();
  const inst = track(initDatabase({ path }));
  stripV3(inst.sqlite);
  drop(inst.sqlite);
  return path;
}
describe(`accounts project scope v3`, () => {
  it(`fresh database applies v3 nullable account project scope with exact FK and index`, () => {
    const inst = track(initDatabase({ path: tempPath() }));
    const db = inst.sqlite;
    const hist = db.prepare(`SELECT version, name, checksum FROM schema_migrations ORDER BY version`).all() as any[];
    expect(hist.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(hist[0].checksum).toBe(V1_CHECKSUM);
    expect(hist[1].checksum).toBe(V2_CHECKSUM);
    expect(hist[0].checksum).toBe(MIGRATIONS[0].checksum);
    expect(hist[1].checksum).toBe(MIGRATIONS[1].checksum);
    expect(hist[2].name).toBe(`account-project-scope`);
    expect(hist[2].name).toBe(MIGRATIONS[2].name);
    expect(hist[2].checksum).toBe(MIGRATIONS[2].checksum);
    const cols = db.pragma('table_info(accounts)') as any[];
    const projectCol = cols.find((c) => c.name === `project_id`);
    expect(projectCol).toBeTruthy();
    expect(Number(projectCol.notnull)).toBe(0);
    const fks = (db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(`accounts`) as any[]).map((f) => [f.from, f.table, f.to, f.on_delete]);
    expect(fks).toHaveLength(1);
    expect(fks[0]).toEqual([`project_id`, `projects`, `id`, `RESTRICT`]);
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ?`).all(`index`, `accounts`) as any[]).map((r) => r.name);
    expect(idx).toContain(`idx_accounts_project`);
    const idxCols = (db.prepare(`SELECT name FROM pragma_index_info(?)`).all(`idx_accounts_project`) as any[]).map((r) => r.name);
    expect(idxCols).toEqual([`project_id`]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM accounts`).get()).toEqual({ n: 0 });
  });
  it(`upgrades a real v2 wallet database preserving ciphertext, history and memberships`, () => {
    const path = v2Fixture();
    const seed = raw(path);
    seedUser(seed, `u1`, `alice`);
    seedProject(seed, `p1`);
    seedAccount(seed, `a1`, `CIPHER-BALANCE-OLD-1`);
    seedAccount(seed, `a2`, `CIPHER-BALANCE-OLD-2`);
    seed.prepare(`INSERT INTO project_memberships (user_id, project_id, created_at) VALUES (?,?,?)`).run(`u1`, `p1`, `2024-03-01`);
    const histBefore = seed.prepare(`SELECT * FROM schema_migrations ORDER BY version`).all() as any[];
    const accountsBefore = seed.prepare(`SELECT rowid,* FROM accounts ORDER BY id`).all() as any[];
    const membersBefore = seed.prepare(`SELECT rowid,* FROM project_memberships ORDER BY user_id, project_id`).all();
    expect(histBefore.map((r) => r.version)).toEqual([1, 2]);
    drop(seed);
    const inst = track(initDatabase({ path }));
    const histAfter = inst.sqlite.prepare(`SELECT * FROM schema_migrations ORDER BY version`).all() as any[];
    expect(histAfter.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(histAfter[0]).toEqual(histBefore[0]);
    expect(histAfter[1]).toEqual(histBefore[1]);
    expect(inst.sqlite.prepare(`SELECT rowid,* FROM project_memberships ORDER BY user_id, project_id`).all()).toEqual(membersBefore);
    const accountsAfter = inst.sqlite.prepare(`SELECT rowid,* FROM accounts ORDER BY id`).all() as any[];
    expect(accountsAfter.length).toBe(2);
    for (let i = 0; i < accountsAfter.length; i++) {
      const row = accountsAfter[i];
      expect(row.project_id).toBeNull();
      const copy: any = { ...row };
      delete copy.project_id;
      expect(copy).toEqual(accountsBefore[i]);
    }
  });
  it(`assigns valid projects, rejects unknown projects and restricts parent deletion`, () => {
    const inst = track(initDatabase({ path: tempPath() }));
    const db = inst.sqlite;
    seedUser(db, `u1`, `alice`);
    seedProject(db, `p1`);
    seedAccount(db, `a1`, `CIPHER-BALANCE`);
    db.prepare(`UPDATE accounts SET project_id = ? WHERE id = ?`).run(`p1`, `a1`);
    expect(db.prepare(`SELECT project_id FROM accounts WHERE id = ?`).get(`a1`)).toEqual({ project_id: `p1` });
    expect(() => db.prepare(`UPDATE accounts SET project_id = ? WHERE id = ?`).run(`ghost`, `a1`)).toThrow(/FOREIGN KEY/);
    db.prepare(`UPDATE accounts SET project_id = NULL WHERE id = ?`).run(`a1`);
    db.prepare(`UPDATE accounts SET project_id = ? WHERE id = ?`).run(`p1`, `a1`);
    expect(() => db.prepare(`DELETE FROM projects WHERE id = ?`).run(`p1`)).toThrow(/FOREIGN KEY/);
    expect(db.prepare(`SELECT id FROM projects ORDER BY id`).all()).toEqual([{ id: `p1` }]);
    db.prepare(`UPDATE accounts SET project_id = NULL WHERE id = ?`).run(`a1`);
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(`p1`);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM projects`).get()).toEqual({ n: 0 });
  });
  it(`reopen after v3 is a no-op for history, schema, wallet rows and memberships`, () => {
    const path = tempPath();
    const first = track(initDatabase({ path }));
    seedUser(first.sqlite, `u1`, `alice`);
    seedProject(first.sqlite, `p1`);
    seedAccount(first.sqlite, `a1`, `CIPHER-REOPEN`);
    first.sqlite.prepare(`UPDATE accounts SET project_id = ? WHERE id = ?`).run(`p1`, `a1`);
    first.sqlite.prepare(`INSERT INTO project_memberships (user_id, project_id, created_at) VALUES (?,?,?)`).run(`u1`, `p1`, `2024-05-01`);
    const read = (db: any) => ({
      hist: db.prepare(`SELECT * FROM schema_migrations ORDER BY version`).all(),
      schema: db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`).all(),
      accounts: db.prepare(`SELECT rowid,* FROM accounts ORDER BY id`).all(),
      members: db.prepare(`SELECT rowid,* FROM project_memberships ORDER BY user_id, project_id`).all(),
    });
    const before = read(first.sqlite);
    drop(first.sqlite);
    const second = track(initDatabase({ path }));
    expect(read(second.sqlite)).toEqual(before);
  });
  it(`real v3 late failure rolls back column, index and ledger, then retry succeeds`, () => {
    const path = v2Fixture();
    const seed = raw(path);
    seedUser(seed, `u1`, `alice`);
    seedProject(seed, `p1`);
    seedAccount(seed, `a1`, `CIPHER-V3-ROLLBACK`);
    seed.exec(`CREATE TRIGGER fail_v3 BEFORE INSERT ON schema_migrations WHEN NEW.version = 3 BEGIN SELECT RAISE(ABORT, 'v3 failure'); END`);
    const schemaBefore = seed.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`).all();
    const accountsBefore = seed.prepare(`SELECT rowid,* FROM accounts ORDER BY id`).all();
    const histBefore = seed.prepare(`SELECT * FROM schema_migrations ORDER BY version`).all();
    drop(seed);
    expect(() => initDatabase({ path })).toThrow(/v3 failure/);
    const check = raw(path);
    expect(check.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`).all()).toEqual(schemaBefore);
    expect(check.prepare(`SELECT rowid,* FROM accounts ORDER BY id`).all()).toEqual(accountsBefore);
    expect(check.prepare(`SELECT * FROM schema_migrations ORDER BY version`).all()).toEqual(histBefore);
    const cols = (check.prepare(`SELECT name FROM pragma_table_info(?)`).all(`accounts`) as any[]).map((r) => r.name);
    expect(cols).not.toContain(`project_id`);
    const idxs = (check.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(`index`) as any[]).map((r) => r.name);
    expect(idxs).not.toContain(`idx_accounts_project`);
    check.exec(`DROP TRIGGER fail_v3`);
    drop(check);
    const inst = track(initDatabase({ path }));
    expect(inst.sqlite.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    const cols2 = (inst.sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(`accounts`) as any[]).map((r) => r.name);
    expect(cols2).toContain(`project_id`);
    const idxs2 = (inst.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(`index`) as any[]).map((r) => r.name);
    expect(idxs2).toContain(`idx_accounts_project`);
    expect(inst.sqlite.prepare(`SELECT COUNT(*) AS n FROM accounts`).get()).toEqual({ n: 1 });
    expect(inst.sqlite.prepare(`SELECT balance_encrypted FROM accounts WHERE id = ?`).get(`a1`)).toEqual({ balance_encrypted: `CIPHER-V3-ROLLBACK` });
  });
  it.each([
    { label: `missing project column`, setup: (db: any) => { db.exec(`DROP INDEX idx_accounts_project`); db.exec(`ALTER TABLE accounts DROP COLUMN project_id`); } },
    { label: `missing project index`, setup: (db: any) => { db.exec(`DROP INDEX idx_accounts_project`); } },
  ])(`recorded v3 with $label is rejected without repair`, ({ setup }) => {
    const path = tempPath();
    const first = track(initDatabase({ path }));
    seedUser(first.sqlite, `u1`, `alice`);
    seedProject(first.sqlite, `p1`);
    seedAccount(first.sqlite, `a1`, `CIPHER-TAMPER`);
    first.sqlite.prepare(`UPDATE accounts SET project_id = ? WHERE id = ?`).run(`p1`, `a1`);
    setup(first.sqlite);
    const snapshot = (db: any) => ({
      hist: db.prepare(`SELECT * FROM schema_migrations ORDER BY version`).all(),
      schema: db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`).all(),
      accounts: db.prepare(`SELECT rowid,* FROM accounts ORDER BY id`).all(),
    });
    const before = snapshot(first.sqlite);
    drop(first.sqlite);
    expect(() => initDatabase({ path })).toThrow(/schema validation failed/);
    const check = raw(path);
    expect(snapshot(check)).toEqual(before);
    const idxs = (check.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(`index`) as any[]).map((r) => r.name);
    expect(idxs).not.toContain(`idx_accounts_project`);
    drop(check);
  });
  it(`recorded v3 with project index on currency is rejected without repair`, () => {
    const path = tempPath();
    const first = track(initDatabase({ path }));
    seedUser(first.sqlite, `u1`, `alice`);
    seedProject(first.sqlite, `p1`);
    seedAccount(first.sqlite, `a1`, `CIPHER-TAMPER-IDX`);
    first.sqlite.prepare(`UPDATE accounts SET project_id = ? WHERE id = ?`).run(`p1`, `a1`);
    first.sqlite.exec(`DROP INDEX idx_accounts_project`);
    first.sqlite.exec(`CREATE INDEX idx_accounts_project ON accounts(currency)`);
    const snapshot = (db: any) => ({
      hist: db.prepare(`SELECT * FROM schema_migrations ORDER BY version`).all(),
      schema: db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name`).all(),
      accounts: db.prepare(`SELECT rowid,* FROM accounts ORDER BY id`).all(),
    });
    const before = snapshot(first.sqlite);
    drop(first.sqlite);
    expect(() => initDatabase({ path })).toThrow(/schema validation failed/);
    const check = raw(path);
    expect(snapshot(check)).toEqual(before);
    const idxCols = (check.prepare(`SELECT name FROM pragma_index_info(?)`).all(`idx_accounts_project`) as any[]).map((r) => r.name);
    expect(idxCols).toEqual([`currency`]);
    drop(check);
  });
});
