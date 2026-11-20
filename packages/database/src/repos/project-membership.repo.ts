import { and, asc, eq } from 'drizzle-orm';
import type { CostCoreDatabase } from '../client.js';
import { projectMemberships } from '../schema.js';

export type ProjectMembership = typeof projectMemberships.$inferSelect;

const MAX_ID_LENGTH = 128;

export class InvalidMembershipInputError extends Error {
  constructor() {
    super('INVALID_MEMBERSHIP_INPUT');
    this.name = 'InvalidMembershipInputError';
  }
}

function isValidId(value: unknown): value is string {
  if (typeof value !== 'string') { return false; }
  if (value.length === 0 || value.length > MAX_ID_LENGTH) { return false; }
  return value.trim().length > 0;
}

export class ProjectMembershipRepository {
  constructor(private db: CostCoreDatabase) {}

  listProjectIdsForUser(userId: string): string[] {
    if (!isValidId(userId)) { return []; }
    const rows = this.db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(eq(projectMemberships.userId, userId))
      .orderBy(asc(projectMemberships.projectId))
      .all();
    return rows.map((row) => row.projectId);
  }

  listMembersForProject(projectId: string): ProjectMembership[] {
    if (!isValidId(projectId)) { return []; }
    const rows = this.db
      .select({
        userId: projectMemberships.userId,
        projectId: projectMemberships.projectId,
        createdAt: projectMemberships.createdAt,
      })
      .from(projectMemberships)
      .where(eq(projectMemberships.projectId, projectId))
      .orderBy(asc(projectMemberships.userId))
      .all();
    return rows.map((row) => ({ userId: row.userId, projectId: row.projectId, createdAt: row.createdAt }));
  }

  hasMembership(userId: string, projectId: string): boolean {
    return this.hasMembershipInTx(this.db, userId, projectId);
  }

  hasMembershipInTx(tx: any, userId: string, projectId: string): boolean {
    if (!isValidId(userId) || !isValidId(projectId)) { return false; }
    const row = tx
      .select({ userId: projectMemberships.userId })
      .from(projectMemberships)
      .where(and(eq(projectMemberships.userId, userId), eq(projectMemberships.projectId, projectId)))
      .get();
    return row !== undefined;
  }

  grantMembershipInTx(tx: any, userId: string, projectId: string): boolean {
    if (!isValidId(userId) || !isValidId(projectId)) { throw new InvalidMembershipInputError(); }
    const createdAt = new Date().toISOString();
    const res = tx
      .insert(projectMemberships)
      .values({ userId, projectId, createdAt })
      .onConflictDoNothing({
        target: [projectMemberships.userId, projectMemberships.projectId],
      })
      .run();
    return res.changes > 0;
  }

  revokeMembershipInTx(tx: any, userId: string, projectId: string): boolean {
    if (!isValidId(userId) || !isValidId(projectId)) { throw new InvalidMembershipInputError(); }
    const res = tx
      .delete(projectMemberships)
      .where(and(eq(projectMemberships.userId, userId), eq(projectMemberships.projectId, projectId)))
      .run();
    return res.changes > 0;
  }
}

