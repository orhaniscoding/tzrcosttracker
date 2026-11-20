import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CostCoreDatabase } from '../client.js';
import { auditLogs, categories, projects, users, whiteLabelSettings, authSessions } from '../schema.js';
import { computeAuditHash, encryptField, hashPassword } from '@cost-core/crypto';
import { SESSION_TTL_SECONDS } from './session.repo.js';
import type { AuthSession } from './session.repo.js';
import type { Project, User } from '@cost-core/types';

export class SetupAlreadyCompletedError extends Error {
  constructor(message: string = 'System setup has already been completed.') {
    super(message); this.name = 'SetupAlreadyCompletedError';
  }
}

export interface SetupTemplateGroup { name: string; color: string; budget?: number; subCategories?: string[]; }
export interface SetupRepositoryInput {
  companyName: string; appTitle: string; baseCurrency: string;
  admin: { username: string; fullName: string; email: string; password: string; pin: string };
  industryTemplate: string; projectName: string; templateCategories: SetupTemplateGroup[];
  masterKey: string | Buffer; ipAddress?: string | null; userAgent?: string | null;
}
export interface SetupRepositoryResult { user: User; project: Project; session: AuthSession; }

export class SetupRepository {
  constructor(private db: CostCoreDatabase) {}

  async performSetup(input: SetupRepositoryInput): Promise<SetupRepositoryResult> {
    const passwordHash = await hashPassword(input.admin.password);
    const pinHash = await hashPassword(input.admin.pin);
    const now = new Date().toISOString();
    const adminId = randomUUID(); const projectId = randomUUID(); const auditId = randomUUID();
    const companyName = input.companyName.trim();
    const projectName = input.projectName.trim();
    const newState = { companyName, baseCurrency: input.baseCurrency, industryTemplate: input.industryTemplate, adminUser: input.admin.username.trim() };
    const diffEncrypted = encryptField({ previousState: null, newState }, input.masterKey);
    const userRow = { id: adminId, username: input.admin.username.trim(), email: input.admin.email.trim(), fullName: input.admin.fullName.trim(), passwordHash, pinHash, role: 'admin' as const, isActive: true, twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: JSON.stringify([]), createdAt: now, updatedAt: now };
    const safeUser: User = { id: adminId, username: userRow.username, email: userRow.email, fullName: userRow.fullName, role: 'admin', isActive: true, hasPin: true, twoFactorEnabled: false, createdAt: now, updatedAt: now };
    const projectRow = { id: projectId, name: projectName, code: null, description: 'Sistem kurulumu sırasında oluşturulan ana operasyon bütçesi', budget: 0, currency: input.baseCurrency, status: 'active' as const, createdAt: now, updatedAt: now };
    type CatRow = { id: string; name: string; code: null; parentId: string | null; description: null; budget: number; color: string; icon: string; orderIndex: number; customFieldIds: string; isActive: boolean; createdAt: string; updatedAt: string };
    const categoryRows: CatRow[] = [];
    for (const group of input.templateCategories) {
      const rootId = randomUUID();
      categoryRows.push({ id: rootId, name: group.name, code: null, parentId: null, description: null, budget: group.budget || 0, color: group.color, icon: 'folder', orderIndex: 0, customFieldIds: '[]', isActive: true, createdAt: now, updatedAt: now });
      for (const subName of group.subCategories || []) {
        categoryRows.push({ id: randomUUID(), name: subName, code: null, parentId: rootId, description: null, budget: 0, color: group.color, icon: 'folder', orderIndex: 0, customFieldIds: '[]', isActive: true, createdAt: now, updatedAt: now });
      }
    }
    const defaultSettings = { id: 'global', companyName, appTitle: input.appTitle, logoUrl: null, faviconUrl: null, backgroundUrl: null, primaryColor: '#2563EB', secondaryColor: '#1E40AF', defaultTheme: 'dark' as const, baseCurrency: input.baseCurrency, dateFormat: 'DD.MM.YYYY', updatedAt: now };
    return this.db.transaction((tx) => {
      const existingUser = tx.select({ id: users.id }).from(users).limit(1).get();
      const marker = tx.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entity, 'system'), eq(auditLogs.entityId, 'initial_setup'))).limit(1).get();
      if (existingUser || marker) { throw new SetupAlreadyCompletedError(); }
      const existingSettings = tx.select().from(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).limit(1).get();
      if (existingSettings) {
        tx.update(whiteLabelSettings).set({ companyName, appTitle: input.appTitle, baseCurrency: input.baseCurrency, updatedAt: now }).where(eq(whiteLabelSettings.id, 'global')).run();
      } else {
        tx.insert(whiteLabelSettings).values(defaultSettings).run();
      }
      tx.insert(users).values(userRow).run();
      tx.insert(projects).values(projectRow).run();
      for (const row of categoryRows) { tx.insert(categories).values(row).run(); }
      const latest = tx.select().from(auditLogs).orderBy(desc(sql`rowid`)).limit(1).get();
      const previousHash = latest ? latest.hash : 'GENESIS';
      const hash = computeAuditHash({ previousHash, action: 'CREATE', entity: 'system', entityId: 'initial_setup', userId: adminId, timestamp: now, previousState: null, newState });
      tx.insert(auditLogs).values({ id: auditId, userId: adminId, action: 'CREATE', entity: 'system', entityId: 'initial_setup', timestamp: now, ipAddress: input.ipAddress || null, userAgent: input.userAgent || null, diffEncrypted, hash, previousHash }).run();
      const nowSec = Math.floor(new Date(now).getTime() / 1000);
      const session = { id: randomUUID(), userId: adminId, createdAt: nowSec, expiresAt: nowSec + SESSION_TTL_SECONDS, revokedAt: null };
      tx.insert(authSessions).values(session).run();
      return { user: safeUser, project: projectRow, session };
    }, { behavior: 'immediate' });
  }
}
