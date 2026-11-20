import { eq, inArray, asc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CostCoreDatabase } from '../client.js';
import { projects } from '../schema.js';
import type { Project, CreateProjectInput } from '@cost-core/types';

const MAX_ID_LENGTH = 128;

function isValidId(value: unknown): value is string {
  if (typeof value !== 'string') { return false; }
  if (value.length === 0 || value.length > MAX_ID_LENGTH) { return false; }
  return value.trim().length > 0;
}

export class ProjectRepository {
  constructor(private db: CostCoreDatabase) {}

  createProjectInTx(tx: any, input: CreateProjectInput): Project {
    const id = randomUUID();
    const now = new Date().toISOString();
    const row: Project = {
      id,
      name: input.name,
      code: input.code || null,
      description: input.description || null,
      budget: input.budget || 0,
      currency: input.currency || 'TRY',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    tx.insert(projects).values(row).run();
    const stored = tx.select().from(projects).where(eq(projects.id, id)).get();
    if (!stored) { throw new Error('PROJECT_CREATE_FAILED'); }
    return stored as Project;
  }

  getProjectByIdInTx(tx: any, id: string): Project | null {
    if (!isValidId(id)) { return null; }
    const row = tx.select().from(projects).where(eq(projects.id, id)).get();
    return (row ?? null) as Project | null;
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    return this.createProjectInTx(this.db, input);
  }

  async listProjects(): Promise<Project[]> {
    return this.db.select().from(projects);
  }

  async getProjectById(id: string): Promise<Project | null> {
    return this.getProjectByIdInTx(this.db, id);
  }

  listProjectsByIds(ids: readonly string[]): Project[] {
    if (!Array.isArray(ids)) { return []; }
    const valid: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!isValidId(id)) { return []; }
      if (!seen.has(id)) { seen.add(id); valid.push(id); }
    }
    if (valid.length === 0) { return []; }
    return this.db
      .select()
      .from(projects)
      .where(inArray(projects.id, valid))
      .orderBy(asc(projects.id))
      .all() as Project[];
  }

  async updateProject(id: string, updates: Partial<CreateProjectInput>): Promise<Project | null> {
    const now = new Date().toISOString();
    await this.db
      .update(projects)
      .set({ ...updates, updatedAt: now })
      .where(eq(projects.id, id));

    return this.getProjectById(id);
  }

  async deleteProject(id: string): Promise<boolean> {
    const res = await this.db.delete(projects).where(eq(projects.id, id));
    return res.changes > 0;
  }
}
