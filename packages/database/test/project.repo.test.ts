import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { initDatabase } from '../src/client.js';
import { auditLogs, authSessions, projects, users } from '../src/schema.js';
import { ProjectRepository } from '../src/repos/project.repo.js';
import type { CreateProjectInput } from '@cost-core/types';

const BASE = Date.UTC(2024, 0, 15, 10, 0, 0);
const ISO = new Date(BASE).toISOString();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY = String();

function input(name: string): CreateProjectInput {
  return { name, code: null, description: null, budget: 0, currency: 'TRY' };
}
function seedProject(db: any, id: string): string {
  db.insert(projects).values({ id, name: 'Project ' + id, code: null, description: null, budget: 0, currency: 'TRY', status: 'active', createdAt: ISO, updatedAt: ISO }).run();
  return id;
}
function seedUser(db: any, id: string): string {
  db.insert(users).values({ id, username: 'user-' + id, email: id + '@example.test', fullName: 'Synthetic User', passwordHash: 'synthetic-hash', role: 'viewer', isActive: true, twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: '[]', pinHash: null, createdAt: ISO, updatedAt: ISO }).run();
  return id;
}
function count(db: any, table: any): number { return db.select().from(table).all().length; }

let db: any; let sqlite: any; let repo: ProjectRepository;

describe('ProjectRepository scoped primitives', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(BASE); const init = initDatabase({ path: ':memory:' }); db = init.db; sqlite = init.sqlite; repo = new ProjectRepository(db); });
  afterEach(() => { vi.useRealTimers(); sqlite.close(); });

  it('applies defaults and server timestamps, generates uuid, keeps async api working', async () => {
    const created = repo.createProjectInTx(db, input('Alpha'));
    expect(created.id).toMatch(UUID_RE);
    expect(created.createdAt).toBe(ISO);
    expect(created.updatedAt).toBe(ISO);
    expect(created.budget).toBe(0);
    expect(created.currency).toBe('TRY');
    expect(created.status).toBe('active');
    expect(created.code).toBe(null);
    const asyncRow = await repo.createProject(input('Beta'));
    expect(asyncRow.id).toMatch(UUID_RE);
    expect(await repo.getProjectById(asyncRow.id)).toEqual(asyncRow);
    expect((await repo.listProjects()).length).toBe(2);
  });

  it('returns only the explicit id subset in ascending id order, ignoring duplicates and unknown ids', () => {
    const a = seedProject(db, 'p-a');
    const b = seedProject(db, 'p-b');
    seedProject(db, 'p-c');
    expect(repo.listProjectsByIds([b, a, b, 'p-missing']).map((p) => p.id)).toEqual([a, b]);
    expect(repo.listProjectsByIds([a, b]).map((p) => p.id)).toEqual(repo.listProjectsByIds([b, a]).map((p) => p.id));
    expect(repo.listProjectsByIds(['p-c', a]).map((p) => p.id)).toEqual([a, 'p-c']);
    expect(repo.listProjectsByIds([b])[0].name).toBe('Project p-b');
  });

  it('fails closed on empty or invalid runtime id collections and single ids', () => {
    seedProject(db, 'p-x');
    expect(repo.listProjectsByIds([])).toEqual([]);
    expect(repo.listProjectsByIds('p-x' as any)).toEqual([]);
    expect(repo.listProjectsByIds(null as any)).toEqual([]);
    expect(repo.listProjectsByIds([EMPTY])).toEqual([]);
    expect(repo.listProjectsByIds(['   '])).toEqual([]);
    expect(repo.listProjectsByIds([42 as any])).toEqual([]);
    expect(repo.listProjectsByIds(['a'.repeat(129)])).toEqual([]);
    expect(repo.listProjectsByIds(['p-x', EMPTY])).toEqual([]);
    expect(repo.getProjectByIdInTx(db, EMPTY)).toBe(null);
    expect(repo.getProjectByIdInTx(db, null as any)).toBe(null);
  });

  it('treats quote and injection-looking ids literally and cannot broaden scope', () => {
    const Q = String.fromCharCode(39);
    const inj = Q + ' OR ' + Q + '1' + Q + '=' + Q + '1';
    seedProject(db, inj);
    const spaced = ' p-space ';
    seedProject(db, spaced);
    seedProject(db, 'p-safe');
    expect(repo.getProjectByIdInTx(db, inj)!.id).toBe(inj);
    expect(repo.listProjectsByIds([inj]).map((p) => p.id)).toEqual([inj]);
    expect(repo.listProjectsByIds([inj, 'p-safe']).map((p) => p.id)).toEqual([inj, 'p-safe']);
    expect(repo.listProjectsByIds([spaced]).map((p) => p.id)).toEqual([spaced]);
    expect(repo.listProjectsByIds([Q + ' OR ' + Q + '1' + Q + '=' + Q + '1']).map((p) => p.id)).toEqual([inj]); expect(repo.listProjectsByIds([Q + ' OR ' + Q + '2' + Q + '=' + Q + '2'])).toEqual([]);
    expect(repo.listProjectsByIds([Q + '; DROP TABLE projects; --'])).toEqual([]);
    expect(count(db, projects)).toBe(3);
  });

  it('writes through the supplied tx, sees it inside, and rolls back on abort with retry', () => {
    expect(() => db.transaction((tx: any) => {
      const created = repo.createProjectInTx(tx, input('TxOnly'));
      expect(repo.getProjectByIdInTx(tx, created.id)).toEqual(created);
      throw new Error('synthetic-abort');
    })).toThrow('synthetic-abort');
    expect(count(db, projects)).toBe(0);
    const retried = db.transaction((tx: any) => repo.createProjectInTx(tx, input('Retry')));
    expect(repo.getProjectByIdInTx(db, retried.id)).toEqual(retried);
    expect(count(db, projects)).toBe(1);
  });

  it('leaves unrelated users, audit and session rows untouched', () => {
    const u = seedUser(db, 'u-core');
    const beforeAudit = count(db, auditLogs);
    const beforeSessions = count(db, authSessions);
    const created = repo.createProjectInTx(db, input('Core'));
    expect(repo.listProjectsByIds([created.id]).map((p) => p.id)).toEqual([created.id]);
    expect(count(db, users)).toBe(1);
    expect(count(db, auditLogs)).toBe(beforeAudit);
    expect(count(db, authSessions)).toBe(beforeSessions);
    expect(repo.getProjectByIdInTx(db, u)).toBe(null);
  });

  it('fails closed when a BEFORE INSERT trigger ignores the project row', () => {
    const u = seedUser(db, 'u-trigger');
    db.run(sql.raw('CREATE TRIGGER cc_pr_block BEFORE INSERT ON projects BEGIN SELECT RAISE(IGNORE); END'));
    const beforeAudit = count(db, auditLogs);
    const beforeSessions = count(db, authSessions);
    expect(() => db.transaction((tx: any) => repo.createProjectInTx(tx, input('Blocked')))).toThrow('PROJECT_CREATE_FAILED');
    expect(count(db, projects)).toBe(0);
    expect(count(db, users)).toBe(1);
    expect(count(db, auditLogs)).toBe(beforeAudit);
    expect(count(db, authSessions)).toBe(beforeSessions);
    db.run(sql.raw('DROP TRIGGER cc_pr_block'));
    const retried = repo.createProjectInTx(db, input('Retry'));
    expect(repo.getProjectByIdInTx(db, retried.id)).toEqual(retried);
    expect(count(db, projects)).toBe(1);
    expect(repo.getProjectByIdInTx(db, u)).toBe(null);
  });

  it('proves supplied tx authority across two WAL connections', () => { const dir = mkdtempSync(join(tmpdir(), 'cc-pr-')); const f = join(dir, 'p.db'); const a = initDatabase({ path: f }); const b = initDatabase({ path: f }); try { const r = new ProjectRepository(a.db); let c: any = null; expect(() => b.db.transaction((tx: any) => { c = r.createProjectInTx(tx, input('Rb')); expect(r.getProjectByIdInTx(tx, c.id)).toEqual(c); expect(count(a.db, projects)).toBe(0); throw new Error('synthetic-abort'); })).toThrow('synthetic-abort'); expect(count(a.db, projects)).toBe(0); expect(r.getProjectByIdInTx(a.db, c.id)).toBe(null); const d = b.db.transaction((tx: any) => r.createProjectInTx(tx, input('Ok'))); expect(r.getProjectByIdInTx(a.db, d.id)).toEqual(d); expect(count(a.db, projects)).toBe(1); expect(count(b.db, projects)).toBe(1); } finally { a.sqlite.close(); b.sqlite.close(); const root = realpathSync(tmpdir()); const real = realpathSync(dir); if (real.startsWith(root + sep) && basename(real).startsWith('cc-pr-')) { rmSync(real, { recursive: true, force: true }); } } });

});
