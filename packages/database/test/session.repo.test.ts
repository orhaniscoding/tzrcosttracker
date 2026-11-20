import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { initDatabase } from '../src/client.js';
import { users, authSessions } from '../src/schema.js';
import { SessionRepository, SESSION_TTL_SECONDS } from '../src/repos/session.repo.js';

const BASE = 1700000000;
let db;
let sqlite;
let repo;
let userSeq = 0;

function seedUser(active) {
  userSeq += 1;
  const id = 'user-' + userSeq;
  const now = new Date(BASE * 1000).toISOString();
  db.insert(users).values({ id, username: 'u' + userSeq, email: 'u' + userSeq + '@example.test', fullName: 'Fake User', passwordHash: 'synthetic-hash', pinHash: null, role: 'viewer', isActive: active, twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: '[]', createdAt: now, updatedAt: now }).run();
  return id;
}
function setNow(sec) { vi.spyOn(Date, 'now').mockReturnValue(sec * 1000); }
function activeCount(userId) {
  const now = Math.floor(Date.now() / 1000);
  return db.select().from(authSessions).where(eq(authSessions.userId, userId)).all().filter((r) => r.revokedAt === null && r.expiresAt > now).length;
}

describe('SessionRepository', () => {
  beforeEach(() => { const init = initDatabase({ path: ':memory:' }); db = init.db; sqlite = init.sqlite; repo = new SessionRepository(db); setNow(BASE); });
  afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

  it('creates and reads a valid session with 8h lifetime', () => {
    const uid = seedUser(true);
    const s = repo.createSession(uid);
    expect(s.userId).toBe(uid);
    expect(s.createdAt).toBe(BASE);
    expect(s.expiresAt).toBe(BASE + SESSION_TTL_SECONDS);
    expect(SESSION_TTL_SECONDS).toBe(28800);
    expect(s.revokedAt).toBeNull();
    expect(Object.keys(s).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'revokedAt', 'userId']);
    expect(repo.getActiveSession(s.id, uid)).toEqual(s);
  });

  it('expires exactly at boundary and cleanupExpired removes it', () => {
    const uid = seedUser(true);
    const s = repo.createSession(uid);
    setNow(s.expiresAt - 1);
    expect(repo.getActiveSession(s.id, uid)).not.toBeNull();
    setNow(s.expiresAt);
    expect(repo.getActiveSession(s.id, uid)).toBeNull();
    expect(repo.cleanupExpired(s.expiresAt)).toBe(1);
  });

  it('rejects wrong user and wrong id', () => {
    const uid = seedUser(true); const other = seedUser(true);
    const s = repo.createSession(uid);
    expect(repo.getActiveSession(s.id, other)).toBeNull();
    expect(repo.getActiveSession('missing-id', uid)).toBeNull();
  });

  it('revokes current vs all and leaves another user unaffected', () => {
    const uid = seedUser(true); const other = seedUser(true);
    const a = repo.createSession(uid); const b = repo.createSession(uid); const c = repo.createSession(other);
    expect(repo.revokeSession(a.id, other)).toBe(false);
    expect(repo.getActiveSession(a.id, uid)).not.toBeNull();
    expect(repo.revokeSession(a.id, uid)).toBe(true);
    expect(repo.getActiveSession(a.id, uid)).toBeNull();
    expect(repo.getActiveSession(b.id, uid)).not.toBeNull();
    expect(repo.revokeAllSessions(uid)).toBe(1);
    expect(repo.getActiveSession(b.id, uid)).toBeNull();
    expect(repo.getActiveSession(c.id, other)).not.toBeNull();
  });

  it('keeps max 10 active on 11 creations and newest stays valid', () => {
    const uid = seedUser(true);
    const made = [];
    for (let i = 0; i < 11; i++) made.push(repo.createSession(uid));
    expect(activeCount(uid)).toBe(10);
    expect(repo.getActiveSession(made[0].id, uid)).toBeNull();
    expect(repo.getActiveSession(made[10].id, uid)).not.toBeNull();
    expect(repo.getActiveSession(made[1].id, uid)).not.toBeNull();
  });

  it('rejects inactive and nonexistent users', () => {
    const inactive = seedUser(false);
    expect(() => repo.createSession(inactive)).toThrow();
    expect(() => repo.createSession('no-such-user')).toThrow();
  });

  it('rolls back prior revocations when insert fails via trigger', () => {
    const uid = seedUser(true);
    const made = [];
    for (let i = 0; i < 10; i++) made.push(repo.createSession(uid));
    sqlite.exec('CREATE TRIGGER fail_session_insert BEFORE INSERT ON auth_sessions BEGIN INSERT INTO missing_table VALUES (1); END;');
    expect(() => repo.createSession(uid)).toThrow();
    sqlite.exec('DROP TRIGGER fail_session_insert;');
    expect(repo.getActiveSession(made[0].id, uid)).not.toBeNull();
    expect(activeCount(uid)).toBe(10);
  });
});
