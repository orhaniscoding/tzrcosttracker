import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { initDatabase } from '../src/index.js';
import { MIGRATIONS } from '../src/migrations.js';

const PREFIX = 'costcore-pm-';
const V1_CHECKSUM = 'e74319f5516c71f568958eaa081e737dd671711e8823c1bbe8fea7e6d9dcf927';
const dirs: string[] = [];
const openDbs: Array<{ close: () => void }> = [];
function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  dirs.push(dir);
  return join(dir, 'test.db');
}
function track<T extends { sqlite: { close: () => void } }>(v: T): T {
  openDbs.push(v.sqlite);
  return v;
}
function raw(path: string): InstanceType<typeof Database> {
  const db = new Database(path);
  openDbs.push(db);
  return db;
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
function v1Fixture(): string {
  const path = tempPath();
  const inst = track(initDatabase({ path }));
  inst.sqlite.prepare('DELETE FROM schema_migrations WHERE version >= ?').run(2);
  inst.sqlite.exec('DROP INDEX idx_accounts_project');
  inst.sqlite.exec('ALTER TABLE accounts DROP COLUMN project_id');
  inst.sqlite.exec('DROP TABLE project_memberships');
  drop(inst.sqlite);
  return path;
}
function v1State(db: any) {
  return {
    hist: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
    users: db.prepare('SELECT rowid,* FROM users ORDER BY id').all(),
    projects: db.prepare('SELECT rowid,* FROM projects ORDER BY id').all(),
    tx: db.prepare('SELECT rowid,* FROM transactions ORDER BY id').all(),
    audit: db.prepare('SELECT rowid,* FROM audit_logs ORDER BY rowid').all(),
    sessions: db.prepare('SELECT * FROM auth_sessions ORDER BY id').all(),
  };
}
describe('project memberships v2', () => {
  it('fresh DB applies v2 with composite PK, cascading FKs and index', () => {
    const inst = track(initDatabase({ path: tempPath() }));
    const hist = inst.sqlite.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as any[];
    expect(hist.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(hist[0].checksum).toBe(V1_CHECKSUM);
    expect(hist[1].name).toBe('project-memberships');
    expect(hist[1].checksum).toBe(MIGRATIONS[1].checksum);
    const cols = inst.sqlite.prepare('SELECT name, pk FROM pragma_table_info(?)').all('project_memberships') as any[];
    expect(cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)).toEqual(['user_id', 'project_id']);
    const fks = (inst.sqlite.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('project_memberships') as any[]).map((f) => [f.from, f.table, f.to, f.on_delete]);
    expect(fks).toHaveLength(2);
    expect(fks).toContainEqual(['user_id', 'users', 'id', 'CASCADE']);
    expect(fks).toContainEqual(['project_id', 'projects', 'id', 'CASCADE']);
    const idx = (inst.sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ?').all('index', 'project_memberships') as any[]).map((r) => r.name);
    expect(idx).toContain('idx_project_memberships_project');
    expect(inst.sqlite.prepare('SELECT COUNT(*) AS n FROM project_memberships').get()).toEqual({ n: 0 });
  });
  it('upgrades a real v1 fixture preserving rows, ciphertext, audit rowids and v1 history', () => {
    const path = v1Fixture();
    const seed = raw(path);
    seed.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('u1', 'alice', 'a@test', 'Alice', 'hash', '2024-01-01', '2024-01-01');
    seed.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)').run('p1', 'Site', '2024-01-01', '2024-01-01');
    seed.prepare('INSERT INTO transactions (id, date, amount_encrypted, base_amount_encrypted, category_id, title_encrypted, title_blind_index, created_by_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('t1', '2024-02-01', 'CIPHER-AMOUNT', 'CIPHER-BASE', 'c1', 'CIPHER-TITLE', 'bidx1', 'u1', '2024-02-01', '2024-02-01');
    seed.prepare('INSERT INTO audit_logs (id, user_id, action, entity, timestamp, hash) VALUES (?,?,?,?,?,?)').run('a1', 'u1', 'create', 'tx', '2024-02-01T00:00:00Z', 'h1');
    seed.prepare('INSERT INTO audit_logs (id, user_id, action, entity, timestamp, hash) VALUES (?,?,?,?,?,?)').run('a2', 'u1', 'update', 'tx', '2024-02-02T00:00:00Z', 'h2');
    seed.prepare('INSERT INTO auth_sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)').run('s1', 'u1', 100, 999999);
    const before = v1State(seed);
    drop(seed);
    const inst = track(initDatabase({ path }));
    const after = v1State(inst.sqlite);
    expect(after.users).toEqual(before.users);
    expect(after.projects).toEqual(before.projects);
    expect(after.tx).toEqual(before.tx);
    expect(after.audit).toEqual(before.audit);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.hist[0]).toEqual(before.hist[0]);
    expect(after.hist.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(inst.sqlite.prepare('SELECT COUNT(*) AS n FROM project_memberships').get()).toEqual({ n: 0 });
  });
  it('real v2 late failure rolls back DDL and ledger, then retry succeeds once', () => {
    const path = v1Fixture();
    const seed = raw(path);
    seed.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('u1', 'alice', 'a@test', 'Alice', 'hash', '2024-01-01', '2024-01-01');
    seed.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)').run('p1', 'Site', '2024-01-01', '2024-01-01');
    seed.exec('CREATE TRIGGER fail_v2 BEFORE INSERT ON schema_migrations WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, \u0027v2 failure\u0027); END');
    const schemaBefore = seed.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
    const before = v1State(seed);
    drop(seed);
    expect(() => initDatabase({ path })).toThrow(/v2 failure/);
    const check = raw(path);
    expect(check.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()).toEqual(schemaBefore);
    expect(v1State(check)).toEqual(before);
    const names = (check.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table') as any[]).map((r) => r.name);
    expect(names).not.toContain('project_memberships');
    const idxs = (check.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('index') as any[]).map((r) => r.name);
    expect(idxs).not.toContain('idx_project_memberships_project');
    check.exec('DROP TRIGGER fail_v2');
    drop(check);
    const inst = track(initDatabase({ path }));
    expect(inst.sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(inst.sqlite.prepare('SELECT COUNT(*) AS n FROM project_memberships').get()).toEqual({ n: 0 });
  });
  it('rejects missing foreign key parents and duplicate pairs, allows independent pairs', () => {
    const inst = track(initDatabase({ path: tempPath() }));
    const db = inst.sqlite;
    db.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('u1', 'alice', 'a@test', 'Alice', 'h', '2024-01-01', '2024-01-01');
    db.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('u2', 'bob', 'b@test', 'Bob', 'h', '2024-01-01', '2024-01-01');
    for (const id of ['p1', 'p2']) db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(id, 'Site ' + id, '2024-01-01', '2024-01-01');
    const ins = db.prepare('INSERT INTO project_memberships (user_id, project_id, created_at) VALUES (?,?,?)');
    expect(() => ins.run('ghost', 'p1', '2024-01-01')).toThrow(/FOREIGN KEY/);
    expect(() => ins.run('u1', 'ghost', '2024-01-01')).toThrow(/FOREIGN KEY/);
    ins.run('u1', 'p1', '2024-01-01');
    expect(() => ins.run('u1', 'p1', '2024-01-02')).toThrow(/UNIQUE|PRIMARY/);
    ins.run('u2', 'p2', '2024-01-01');
    expect(db.prepare('SELECT COUNT(*) AS n FROM project_memberships').get()).toEqual({ n: 2 });
  });
  it('real user and project deletion cascades only intended membership rows', () => {
    const inst = track(initDatabase({ path: tempPath() }));
    const db = inst.sqlite;
    db.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('u1', 'alice', 'a@test', 'Alice', 'h', '2024-01-01', '2024-01-01');
    db.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run('u2', 'bob', 'b@test', 'Bob', 'h', '2024-01-01', '2024-01-01');
    for (const id of ['p1', 'p2']) db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(id, 'Site ' + id, '2024-01-01', '2024-01-01');
    const ins = db.prepare('INSERT INTO project_memberships (user_id, project_id, created_at) VALUES (?,?,?)');
    ins.run('u1', 'p1', '2024-01-01'); ins.run('u2', 'p1', '2024-01-01'); ins.run('u2', 'p2', '2024-01-01');
    const pairs = () => (db.prepare('SELECT user_id, project_id FROM project_memberships ORDER BY user_id, project_id').all() as any[]).map((r) => [r.user_id, r.project_id]);
    db.prepare('DELETE FROM users WHERE id = ?').run('u1');
    expect(pairs()).toEqual([['u2', 'p1'], ['u2', 'p2']]);
    db.prepare('DELETE FROM projects WHERE id = ?').run('p2');
    expect(pairs()).toEqual([['u2', 'p1']]);
    expect(db.prepare('SELECT id FROM users ORDER BY id').all()).toEqual([{ id: 'u2' }]);
    expect(db.prepare('SELECT id FROM projects ORDER BY id').all()).toEqual([{ id: 'p1' }]);
  });
function seedU(db: any, id: string, username: string): void {
  db.prepare('INSERT INTO users (id, username, email, full_name, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)').run(id, username, username + '@test', username, 'h', '2024-01-01', '2024-01-01');
}
function seedP(db: any, id: string): void {
  db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)').run(id, 'Site ' + id, '2024-01-01', '2024-01-01');
}

  it('reopen is a no-op for history, applied_at and membership rows', () => {
    const path = tempPath();
    const first = track(initDatabase({ path }));
    seedU(first.sqlite, 'u1', 'alice');
    seedP(first.sqlite, 'p1');
    first.sqlite.prepare('INSERT INTO project_memberships (user_id, project_id, created_at) VALUES (?,?,?)').run('u1', 'p1', '2024-05-01');
    const read = (db: any) => ({
      hist: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      members: db.prepare('SELECT rowid,* FROM project_memberships ORDER BY user_id, project_id').all(),
      schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    });
    const before = read(first.sqlite);
    drop(first.sqlite);
    const second = track(initDatabase({ path }));
    expect(read(second.sqlite)).toEqual(before);
  });
  it.each([
    { label: 'missing table', setup: (db: any) => db.exec('DROP TABLE project_memberships') },
    { label: 'columns without primary key or foreign keys', setup: (db: any) => { db.exec('DROP TABLE project_memberships'); db.exec('CREATE TABLE project_memberships (user_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL)'); } },
    { label: 'primary key without foreign keys', setup: (db: any) => { db.exec('DROP TABLE project_memberships'); db.exec('CREATE TABLE project_memberships (user_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, project_id))'); } },
    { label: 'foreign keys without cascading delete', setup: (db: any) => { db.exec('DROP TABLE project_memberships'); db.exec('CREATE TABLE project_memberships (user_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, project_id), FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (project_id) REFERENCES projects(id))'); } },
  ])('applied v2 with $label fails closed without history or data writes', ({ setup }) => {
    const path = tempPath();
    const first = track(initDatabase({ path }));
    seedU(first.sqlite, 'u1', 'alice');
    seedP(first.sqlite, 'p1');
    setup(first.sqlite);
    const read = (db: any) => {
      const hasMembers = !!db.prepare('SELECT 1 AS x FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'project_memberships');
      return {
        hist: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
        users: db.prepare('SELECT rowid,* FROM users ORDER BY id').all(),
        projects: db.prepare('SELECT rowid,* FROM projects ORDER BY id').all(),
        members: hasMembers ? db.prepare('SELECT rowid,* FROM project_memberships ORDER BY user_id, project_id').all() : null,
        schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
      };
    };
    const before = read(first.sqlite);
    drop(first.sqlite);
    expect(() => initDatabase({ path })).toThrow(/schema validation failed/);
    const check = raw(path);
    expect(read(check)).toEqual(before);
    const idxs = (check.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('index') as any[]).map((r) => r.name);
    expect(idxs).not.toContain('idx_project_memberships_project');
    drop(check);
  });
  it('rejects a genuinely orphaned membership row on reopen and leaves storage untouched', () => {
    const path = tempPath();
    const first = track(initDatabase({ path }));
    seedU(first.sqlite, 'u1', 'alice');
    seedP(first.sqlite, 'p1');
    first.sqlite.prepare('INSERT INTO project_memberships (user_id, project_id, created_at) VALUES (?,?,?)').run('u1', 'p1', '2024-05-01');
    drop(first.sqlite);
    const tamper = raw(path);
    tamper.pragma('foreign_keys = OFF');
    tamper.prepare('INSERT INTO project_memberships (user_id, project_id, created_at) VALUES (?,?,?)').run('ghost', 'p1', '2024-06-01');
    const snapshot = (db: any) => ({
      hist: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      members: db.prepare('SELECT rowid,* FROM project_memberships ORDER BY user_id, project_id').all(),
      users: db.prepare('SELECT rowid,* FROM users ORDER BY id').all(),
      projects: db.prepare('SELECT rowid,* FROM projects ORDER BY id').all(),
      schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    });
    const before = snapshot(tamper);
    drop(tamper);
    expect(() => initDatabase({ path })).toThrow(/foreign key/i);
    const check = raw(path);
    expect(snapshot(check)).toEqual(before);
    drop(check);
  });
  it('does not silently adopt a pre-existing unknown project_memberships table from a v1 database', () => {
    const path = v1Fixture();
    const first = raw(path);
    first.exec('CREATE TABLE project_memberships (marker TEXT)');
    first.prepare('INSERT INTO project_memberships (marker) VALUES (?)').run('sentinel-040a');
    const read = (db: any) => ({
      hist: db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(),
      users: db.prepare('SELECT rowid,* FROM users ORDER BY id').all(),
      projects: db.prepare('SELECT rowid,* FROM projects ORDER BY id').all(),
      sentinel: db.prepare('SELECT rowid,* FROM project_memberships ORDER BY rowid').all(),
      schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    });
    const before = read(first);
    drop(first);
    expect(() => initDatabase({ path })).toThrow(/already exists/);
    const check = raw(path);
    expect(read(check)).toEqual(before);
    check.exec('DROP TABLE project_memberships');
    drop(check);
    const upgraded = track(initDatabase({ path }));
    const versions = (upgraded.sqlite.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as any[]).map((r) => r.version);
    expect(versions).toEqual([1, 2, 3]);
    expect(upgraded.sqlite.prepare('SELECT COUNT(*) AS n FROM project_memberships').get()).toEqual({ n: 0 });
    const cols = (upgraded.sqlite.prepare('SELECT name FROM pragma_table_info(?)').all('project_memberships') as any[]).map((r) => r.name);
    expect(cols).toEqual(['user_id', 'project_id', 'created_at']);
  });
});
