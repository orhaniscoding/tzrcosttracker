import { and, eq } from 'drizzle-orm';
import { authSessions, projectMemberships, users } from '@cost-core/database';

export interface ProjectScope { all: boolean; projectIds: string[]; }

const PROJECT_ROLES = ['admin', 'manager', 'accountant', 'auditor', 'viewer'];

export class SessionInvalidError extends Error { constructor() { super('SESSION_INVALID'); this.name = 'SessionInvalidError'; } }
export class ForbiddenError extends Error { constructor() { super('FORBIDDEN'); this.name = 'ForbiddenError'; } }
export class NotFoundError extends Error { constructor() { super('NOT_FOUND'); this.name = 'NotFoundError'; } }

export function isValidPathId(value: unknown): value is string {
  if (typeof value !== 'string') { return false; }
  if (value.length === 0 || value.length > 128) { return false; }
  return value.trim().length > 0;
}

export class ProjectAccessService {
  private pickUser(tx: any, userId: string): { id: string; role: string; isActive: boolean } | null {
    if (!isValidPathId(userId)) { return null; }
    const row = tx.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, userId)).get();
    return (row as any) || null;
  }
  resolveScopeInTx(tx: any, userId: string): ProjectScope {
    return this.scopeFor(tx, userId);
  }

  private scopeFor(tx: any, userId: string): ProjectScope {
    const user = this.pickUser(tx, userId);
    if (!user || !user.isActive || !PROJECT_ROLES.includes(user.role)) {
      return { all: false, projectIds: [] };
    }
    if (user.role === 'admin') { return { all: true, projectIds: [] }; }
    const rows = tx
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(eq(projectMemberships.userId, user.id))
      .all();
    return { all: false, projectIds: rows.map((r: any) => String(r.projectId)) };
  }


  // Fresh in-transaction actor + session verification.
  requireFreshActor(tx: any, userId: string, sessionId: string, originalExpiresAt: number): string {
    if (!isValidPathId(userId) || !isValidPathId(sessionId) || typeof originalExpiresAt !== 'number' || !Number.isFinite(originalExpiresAt)) {
      throw new SessionInvalidError();
    }
    const user = this.pickUser(tx, userId);
    if (!user || !user.isActive || !PROJECT_ROLES.includes(user.role)) { throw new SessionInvalidError(); }
    const now = Math.floor(Date.now() / 1000);
    const session = tx
      .select({ id: authSessions.id, userId: authSessions.userId, expiresAt: authSessions.expiresAt, revokedAt: authSessions.revokedAt })
      .from(authSessions)
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
      .get();
    if (!session || session.revokedAt !== null || session.expiresAt <= now || session.expiresAt !== originalExpiresAt) {
      throw new SessionInvalidError();
    }
    return user.role;
  }
  requireFreshAdmin(tx: any, userId: string, sessionId: string, originalExpiresAt: number): 'admin' {
    const role = this.requireFreshActor(tx, userId, sessionId, originalExpiresAt);
    if (role !== 'admin') { throw new ForbiddenError(); }
    return 'admin';
  }
}
