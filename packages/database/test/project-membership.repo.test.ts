import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { initDatabase } from '../src/client.js';
import { authSessions, auditLogs, projectMemberships, projects, users } from '../src/schema.js';
import { ProjectMembershipRepository } from '../src/repos/project-membership.repo.js';

const BASE = Date.UTC(2024, 0, 15, 10, 0, 0);
const ISO = new Date(BASE).toISOString();

function seedUser(db: any, id: string): string {
  db.insert(users).values({ id, username: 'user-' + id, email: id + '@example.test', fullName: 'Synthetic User', passwordHash: 'synthetic-hash', role: 'viewer', isActive: true, twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: '[]', pinHash: null, createdAt: ISO, updatedAt: ISO }).run();
  return id;
}
function seedProject(db: any, id: string): string {
  db.insert(projects).values({ id, name: 'Project ' + id, code: null, description: null, budget: 0, currency: 'TRY', status: 'active', createdAt: ISO, updatedAt: ISO }).run();
  return id;
}
function allRows(db: any) { return db.select().from(projectMemberships).all(); }
function countOf(db: any, table: any) { return db.select().from(table).all().length; }

let db: any; let sqlite: any; let repo: ProjectMembershipRepository;

describe('ProjectMembershipRepository', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(BASE); const init = initDatabase({ path: ':memory:' }); db = init.db; sqlite = init.sqlite; repo = new ProjectMembershipRepository(db); });
  afterEach(() => { vi.useRealTimers(); sqlite.close(); });

  it('returns empty reads and creates no automatic memberships', () => {
    const u = seedUser(db, 'u-empty');
    const p = seedProject(db, 'p-empty');
    expect(repo.listProjectIdsForUser(u)).toEqual([]);
    expect(repo.listMembersForProject(p)).toEqual([]);
    expect(repo.hasMembership(u, p)).toBe(false);
    expect(allRows(db)).toEqual([]);
  });

  it('grants once, reports duplicates as false, and never rewrites createdAt', () => {
    const u = seedUser(db, 'u-grant');
    const p = seedProject(db, 'p-grant');
    expect(repo.grantMembershipInTx(db, u, p)).toBe(true);
    const first = allRows(db);
    expect(first).toEqual([{ userId: u, projectId: p, createdAt: ISO }]);
    vi.setSystemTime(BASE + 86400000);
    expect(repo.grantMembershipInTx(db, u, p)).toBe(false);
    expect(allRows(db)).toEqual(first);
  });

  it('scopes and sorts reads across two users and three projects', () => {
    const u1 = seedUser(db, 'u-a');
    const u2 = seedUser(db, 'u-b');
    const p1 = seedProject(db, 'p-1');
    const p2 = seedProject(db, 'p-2');
    const p3 = seedProject(db, 'p-3');
    for (const [u, p] of [[u1, p3], [u1, p1], [u2, p1], [u2, p2]] as const) { repo.grantMembershipInTx(db, u, p); }
    expect(repo.listProjectIdsForUser(u1)).toEqual([p1, p3]);
    expect(repo.listProjectIdsForUser(u2)).toEqual([p1, p2]);
    const members = repo.listMembersForProject(p1);
    expect(members.map((m) => m.userId)).toEqual([u1, u2]);
    for (const m of members) { expect(Object.keys(m).sort()).toEqual(['createdAt', 'projectId', 'userId']); }
    expect(repo.listMembersForProject(p3).map((m) => m.userId)).toEqual([u1]);
    expect(repo.listMembersForProject('p-missing')).toEqual([]);
  });

  it('revokes the exact pair, is idempotent, and retains other pairs', () => {
    const u1 = seedUser(db, 'u-r1');
    const u2 = seedUser(db, 'u-r2');
    const p1 = seedProject(db, 'p-r1');
    const p2 = seedProject(db, 'p-r2');
    for (const [u, p] of [[u1, p1], [u1, p2], [u2, p1]] as const) { repo.grantMembershipInTx(db, u, p); }
    const before = allRows(db);
    expect(repo.revokeMembershipInTx(db, u1, p1)).toBe(true);
    expect(repo.hasMembership(u1, p1)).toBe(false);
    expect(allRows(db)).toEqual(before.filter((r) => !(r.userId === u1 && r.projectId === p1)));
    expect(repo.revokeMembershipInTx(db, u1, p1)).toBe(false);
    expect(repo.revokeMembershipInTx(db, u1, 'p-r2-missing')).toBe(false);
    expect(repo.hasMembership(u1, p2)).toBe(true);
    expect(repo.hasMembership(u2, p1)).toBe(true);
    expect(allRows(db).length).toBe(2);
  });

  it('rolls back a grant in a real caller transaction and allows retry', () => {
    const u = seedUser(db, 'u-tx2');
    const p = seedProject(db, 'p-tx2');
    expect(() => db.transaction((tx: any) => { repo.grantMembershipInTx(tx, u, p); throw new Error('synthetic-abort'); })).toThrow('synthetic-abort');
    expect(allRows(db)).toEqual([]);
    expect(repo.hasMembership(u, p)).toBe(false);
    expect(repo.grantMembershipInTx(db, u, p)).toBe(true);
    expect(repo.hasMembership(u, p)).toBe(true);
  });

  it('rolls back a revoke and restores the full original row', () => {
    const u = seedUser(db, 'u-tx3');
    const p = seedProject(db, 'p-tx3');
    repo.grantMembershipInTx(db, u, p);
    const original = allRows(db);
    expect(() => db.transaction((tx: any) => { repo.revokeMembershipInTx(tx, u, p); throw new Error('synthetic-abort'); })).toThrow('synthetic-abort');
    expect(allRows(db)).toEqual(original);
    expect(original[0].createdAt).toBe(ISO);
    expect(repo.hasMembership(u, p)).toBe(true);
  });

  it('rejects invalid ids without reads, writes, or leaked values', () => {
    const u = seedUser(db, 'u-inv'); const p = seedProject(db, 'p-inv');
    repo.grantMembershipInTx(db, u, p); const before = allRows(db);
    const bads = ['', '   ', 'x'.repeat(129), null as any, 42 as any];
    for (const bad of bads) {
      expect(repo.listProjectIdsForUser(bad)).toEqual([]);
      expect(repo.listMembersForProject(bad)).toEqual([]);
      expect(repo.hasMembership(bad, p)).toBe(false);
      expect(repo.hasMembership(u, bad)).toBe(false);
      for (const call of [() => repo.grantMembershipInTx(db, bad, p), () => repo.revokeMembershipInTx(db, bad, p)]) {
        let err: any; try { call(); } catch (e) { err = e; }
        expect(err && err.name).toBe('InvalidMembershipInputError');
        expect(err && err.message).toBe('INVALID_MEMBERSHIP_INPUT');
        expect(err && err.message).not.toContain('u-inv');
      }
    }
    expect(allRows(db)).toEqual(before);
  });

  it('fails a grant whose parent user or project is missing via real FK', () => {
    const u = seedUser(db, 'u-fk'); const p = seedProject(db, 'p-fk');
    expect(() => repo.grantMembershipInTx(db, 'u-absent', p)).toThrow();
    expect(() => repo.grantMembershipInTx(db, u, 'p-absent')).toThrow();
    expect(allRows(db)).toEqual([]);
    expect(repo.hasMembership('u-absent', p)).toBe(false);
    expect(repo.hasMembership(u, 'p-absent')).toBe(false);
    expect(repo.revokeMembershipInTx(db, 'u-absent', p)).toBe(false);
    expect(repo.revokeMembershipInTx(db, u, 'p-absent')).toBe(false);
    expect(allRows(db)).toEqual([]);
  });

  it('keeps quote and injection-looking ids as literal bound values', () => {
    const Q = String.fromCharCode(39);
    const uq = 'quote' + Q + 'user';
    const pq = 'quote' + Q + 'proj';
    const evil = 'x' + Q + ' OR ' + Q + '1' + Q + '=' + Q + '1';
    const u = seedUser(db, uq);
    const p = seedProject(db, pq);
    const other = seedProject(db, 'plain-proj');
    expect(repo.grantMembershipInTx(db, u, p)).toBe(true);
    expect(repo.listProjectIdsForUser(u)).toEqual([p]);
    expect(repo.listMembersForProject(p).map((m) => m.userId)).toEqual([u]);
    expect(repo.hasMembership(uq, pq)).toBe(true);
    expect(repo.listProjectIdsForUser(evil)).toEqual([]);
    expect(repo.listMembersForProject(evil)).toEqual([]);
    expect(repo.hasMembership(evil, p)).toBe(false);
    expect(repo.revokeMembershipInTx(db, evil, p)).toBe(false);
    expect(repo.revokeMembershipInTx(db, u, other)).toBe(false);
    expect(repo.hasMembership(u, p)).toBe(true);
    expect(repo.revokeMembershipInTx(db, u, p)).toBe(true);
    expect(allRows(db)).toEqual([]);
  });

  it('honors the supplied tx across two connections on one WAL file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'membership-repo-'));
    const real = realpathSync(dir);
    expect(real.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    expect(real.endsWith(sep + basename(dir))).toBe(true);
    const file = join(dir, 'wal.db');
    const a = initDatabase({ path: file });
    const b = initDatabase({ path: file });
    try {
      const repoA = new ProjectMembershipRepository(a.db);
      seedUser(a.db, 'u-wal');
      seedProject(a.db, 'p-wal');
      expect(() => b.db.transaction((tx: any) => {
        repoA.grantMembershipInTx(tx, 'u-wal', 'p-wal');
        expect(repoA.hasMembershipInTx(tx, 'u-wal', 'p-wal')).toBe(true);
        expect(repoA.hasMembership('u-wal', 'p-wal')).toBe(false);
        throw new Error('rollback-wal');
      })).toThrow('rollback-wal');
      expect(repoA.hasMembership('u-wal', 'p-wal')).toBe(false);

      const beforeUsers = countOf(a.db, users);
      const beforeProjects = countOf(a.db, projects);
      const beforeAudit = countOf(a.db, auditLogs);
      const beforeSessions = countOf(a.db, authSessions);
      b.db.transaction((tx: any) => { repoA.grantMembershipInTx(tx, 'u-wal', 'p-wal'); });
      expect(repoA.hasMembership('u-wal', 'p-wal')).toBe(true);
      const repoB = new ProjectMembershipRepository(b.db);
      expect(repoB.hasMembership('u-wal', 'p-wal')).toBe(true);
      b.db.transaction((tx: any) => { expect(repoA.revokeMembershipInTx(tx, 'u-wal', 'p-wal')).toBe(true); });
      expect(repoA.hasMembership('u-wal', 'p-wal')).toBe(false);
      expect(repoB.hasMembership('u-wal', 'p-wal')).toBe(false);
      expect(countOf(a.db, users)).toBe(beforeUsers);
      expect(countOf(a.db, projects)).toBe(beforeProjects);
      expect(countOf(a.db, auditLogs)).toBe(beforeAudit);
      expect(countOf(a.db, authSessions)).toBe(beforeSessions);
    } finally {
      try { a.sqlite.close(); } catch { /* closed */ }
      try { b.sqlite.close(); } catch { /* closed */ }
    }
    expect(real).toContain(sep);
    expect(real.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

