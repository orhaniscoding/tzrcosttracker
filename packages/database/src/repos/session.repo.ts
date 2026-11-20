import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { CostCoreDatabase } from '../client.js';
import { authSessions, users } from '../schema.js';

export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const MAX_ACTIVE_SESSIONS_PER_USER = 10;

export interface AuthSession {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

type SessionRow = typeof authSessions.$inferSelect;

function toSession(row: SessionRow): AuthSession {
  return { id: row.id, userId: row.userId, createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class SessionUserInactiveError extends Error { constructor() { super('User not found or inactive'); this.name = 'SessionUserInactiveError'; } }

export class SessionRepository {
  constructor(private db: CostCoreDatabase) {}

  createSessionInTx(tx: any, userId: string): AuthSession {
    const now = nowSeconds();
    const user = tx.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.id, userId)).get();
    if (!user || !user.isActive) { throw new SessionUserInactiveError(); }
    tx.delete(authSessions).where(and(eq(authSessions.userId, userId), or(lte(authSessions.expiresAt, now), isNotNull(authSessions.revokedAt)))).run();
    const active = tx.select().from(authSessions).where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now))).orderBy(asc(authSessions.createdAt), asc(sql.raw('rowid'))).all();
    const excess = active.length - (MAX_ACTIVE_SESSIONS_PER_USER - 1);
    if (excess > 0) { for (const old of active.slice(0, excess)) { tx.update(authSessions).set({ revokedAt: now }).where(eq(authSessions.id, old.id)).run(); } }
    const row: SessionRow = { id: randomUUID(), userId, createdAt: now, expiresAt: now + SESSION_TTL_SECONDS, revokedAt: null };
    tx.insert(authSessions).values(row).run();
    return toSession(row);
  }

  revokeSessionInTx(tx: any, id: string, userId: string): boolean {
    const now = nowSeconds();
    const res = tx.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.id, id), eq(authSessions.userId, userId), isNull(authSessions.revokedAt))).run();
    return res.changes > 0;
  }

  revokeAllSessionsInTx(tx: any, userId: string): number {
    const now = nowSeconds();
    const res = tx.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now))).run();
    return res.changes;
  }

  revokeOtherSessionsInTx(tx: any, userId: string, keepSessionId: string): number {
    const now = nowSeconds();
    const res = tx.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.userId, userId), ne(authSessions.id, keepSessionId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now))).run();
    return res.changes;
  }

  createSession(userId: string): AuthSession {
    const now = nowSeconds();
    return this.db.transaction((tx) => {
      const user = tx.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.id, userId)).get();
      if (!user || !user.isActive) {
        throw new Error('User not found or inactive');
      }
      tx.delete(authSessions).where(and(eq(authSessions.userId, userId), or(lte(authSessions.expiresAt, now), isNotNull(authSessions.revokedAt)))).run();
      const active = tx.select().from(authSessions).where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now))).orderBy(asc(authSessions.createdAt), asc(sql.raw('rowid'))).all();
      const excess = active.length - (MAX_ACTIVE_SESSIONS_PER_USER - 1);
      if (excess > 0) {
        for (const old of active.slice(0, excess)) {
          tx.update(authSessions).set({ revokedAt: now }).where(eq(authSessions.id, old.id)).run();
        }
      }
      const row: SessionRow = { id: randomUUID(), userId, createdAt: now, expiresAt: now + SESSION_TTL_SECONDS, revokedAt: null };
      tx.insert(authSessions).values(row).run();
      return toSession(row);
    }, { behavior: 'immediate' });
  }

  getActiveSession(id: string, userId: string): AuthSession | null {
    const now = nowSeconds();
    const row = this.db.select().from(authSessions).where(and(eq(authSessions.id, id), eq(authSessions.userId, userId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now))).get();
    return row ? toSession(row) : null;
  }

  revokeSession(id: string, userId: string): boolean {
    const now = nowSeconds();
    const res = this.db.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.id, id), eq(authSessions.userId, userId), isNull(authSessions.revokedAt))).run();
    return res.changes > 0;
  }

  revokeAllSessions(userId: string): number {
    const now = nowSeconds();
    const res = this.db.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now))).run();
    return res.changes;
  }

  cleanupExpired(now: number = nowSeconds()): number {
    const res = this.db.delete(authSessions).where(lte(authSessions.expiresAt, now)).run();
    return res.changes;
  }
}
