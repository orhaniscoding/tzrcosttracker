import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from '@cost-core/types';
import { encryptField, decryptField } from '@cost-core/crypto';
import {
  AuditLogRepository, users, projects, parties, accounts, categories,
  customFields, transactions, whiteLabelSettings, auditLogs,
} from '@cost-core/database';
import { ForbiddenError, SessionInvalidError } from '../services/project-access.service.js';
import { BackupV2Error, buildFullBackupV2 } from '../services/backup-v2-export.service.js';
import { checkRestoreRelationships } from '../services/backup-v2-restore.service.js';

const ExportSchema = z.object({ backupPassword: z.string().min(6) });
const ExportV2Schema = z.object({
  backupPassword: z.string().refine((value) => {
    const bytes = Buffer.byteLength(value, 'utf8');
    return bytes >= 12 && bytes <= 256;
  }),
});
const ImportSchema = z.object({ backupPassword: z.string().min(1), vaultData: z.string().min(20) });
const tableNames = ['users', 'projects', 'parties', 'accounts', 'categories', 'customFields', 'transactions', 'whiteLabelSettings', 'auditLogs'] as const;
type Tables = Partial<Record<typeof tableNames[number], Record<string, any>[]>>;
class BackupValidationError extends Error {}
class BackupV2ValidationError extends Error {}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function readSnapshot(vaultData: string, backupPassword: string): Tables {
  try {
    // decryptField intentionally passes plaintext through; backup imports must not.
    // Validate the complete v1 envelope, then require authenticated GCM decryption.
    if (!/^TZRVAULT:v1:[0-9a-fA-F]{24}:[0-9a-fA-F]{32}:(?:[0-9a-fA-F]{2})+(?![\s\S])/.test(vaultData)) throw new BackupValidationError();
    const snapshot = decryptField<unknown>('enc:v1:' + vaultData.slice('TZRVAULT:v1:'.length), backupPassword);
    if (!plainObject(snapshot) || snapshot.app !== 'TZRCoster' || snapshot.format !== 'tzrvault' ||
      snapshot.version !== '1.0' || !plainObject(snapshot.tables)) throw new BackupValidationError();
    const tables = snapshot.tables;
    for (const name of tableNames) {
      if (Object.prototype.hasOwnProperty.call(tables, name) &&
        (!Array.isArray(tables[name]) || !(tables[name] as unknown[]).every(plainObject))) throw new BackupValidationError();
    }
    return tables as Tables;
  } catch { throw new BackupValidationError(); }
}

function recordCounts(tables: Tables) {
  return {
    users: tables.users?.length ?? 0, projects: tables.projects?.length ?? 0,
    transactions: tables.transactions?.length ?? 0, categories: tables.categories?.length ?? 0,
    parties: tables.parties?.length ?? 0, auditLogs: tables.auditLogs?.length ?? 0,
  };
}

export const backupRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, projectAccess } = fastify;
  const db: any = fastify.db;

  function withAdmin<T>(request: any, operation: (tx: any, audit: AuditLogRepository) => T): T {
    return db.transaction((tx: any) => {
      const session = request.authSession;
      projectAccess.requireFreshAdmin(tx, request.user?.id, session?.id, session ? Number(session.expiresAt) : NaN);
      return operation(tx, new AuditLogRepository(tx));
    }, { behavior: 'immediate' });
  }

  function backupError(reply: any, error: unknown) {
    if (error instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
    if (error instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
    if (error instanceof BackupV2ValidationError) return reply.status(400).send({ error: 'Geçersiz v2 yedek parametreleri.' });
    if (error instanceof BackupValidationError) return reply.status(400).send({ error: 'Geçersiz yedek parametreleri, hatalı parola veya bozuk / uyumsuz v1 yedek.' });
    return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
  }

  // Legacy v1 exports nine tables, not a complete recovery/rekey/session backup.
  fastify.post('/export', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const result = withAdmin(request, (tx, audit) => {
        const parse = ExportSchema.safeParse(request.body);
        if (!parse.success) throw new BackupValidationError();
        const tables = {
          users: tx.select().from(users).all(), projects: tx.select().from(projects).all(),
          parties: tx.select().from(parties).all(), accounts: tx.select().from(accounts).all(),
          categories: tx.select().from(categories).all(), customFields: tx.select().from(customFields).all(),
          transactions: tx.select().from(transactions).all(), whiteLabelSettings: tx.select().from(whiteLabelSettings).all(),
          auditLogs: tx.select().from(auditLogs).all(),
        };
        const snapshot = { app: 'TZRCoster', format: 'tzrvault', version: '1.0', exportedAt: new Date().toISOString(), recordCounts: recordCounts(tables), tables };
        const rawEncrypted = encryptField(JSON.stringify(snapshot), parse.data.backupPassword);
        const vaultData = rawEncrypted.replace('enc:v1:', 'TZRVAULT:v1:');
        const filename = `TZRCoster_Tam_Yedek_${snapshot.exportedAt.split('T')[0]}.tzrvault`;
        audit.logAction({
          userId: (request.user as { id: string }).id, action: 'EXPORT', entity: 'system_backup', entityId: 'tzrvault',
          ipAddress: request.ip, userAgent: request.headers['user-agent'],
          newState: { filename, recordCounts: snapshot.recordCounts },
        }, config.masterKey);
        return { success: true, filename, vaultData, recordCounts: snapshot.recordCounts, exportedAt: snapshot.exportedAt };
      });
      // No payload leaves the route until the snapshot and audit commit together.
      return reply.send(result);
    } catch (error) { return backupError(reply, error); }
  });

  fastify.post('/import', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const result = withAdmin(request, (tx, audit) => {
        const parse = ImportSchema.safeParse(request.body);
        if (!parse.success) throw new BackupValidationError();
        const tables = readSnapshot(parse.data.vaultData, parse.data.backupPassword);
        // Preserve the five-table partial upsert contract. Wallets, users, custom
        // fields, old audit rows, memberships and sessions are NOT restored.
        for (const row of tables.categories ?? []) tx.insert(categories).values(row).onConflictDoUpdate({ target: categories.id, set: row }).run();
        for (const row of tables.projects ?? []) tx.insert(projects).values(row).onConflictDoUpdate({ target: projects.id, set: row }).run();
        for (const row of tables.parties ?? []) tx.insert(parties).values(row).onConflictDoUpdate({ target: parties.id, set: row }).run();
        for (const row of tables.transactions ?? []) tx.insert(transactions).values(row).onConflictDoUpdate({ target: transactions.id, set: row }).run();
        for (const row of tables.whiteLabelSettings ?? []) tx.insert(whiteLabelSettings).values(row).onConflictDoUpdate({ target: whiteLabelSettings.id, set: row }).run();
        const counts = recordCounts(tables);
        audit.logAction({
          userId: (request.user as { id: string }).id, action: 'RESTORE', entity: 'system_backup', entityId: 'tzrvault',
          ipAddress: request.ip, userAgent: request.headers['user-agent'],
          newState: { restoredAt: new Date().toISOString(), recordCounts: counts },
        }, config.masterKey);
        return { success: true, message: 'V1 yedeğinin beş tabloluk kısmi geri yüklemesi tamamlandı; bu tam sistem kurtarma değildir.', recordCounts: counts };
      });
      return reply.send(result);
    } catch (error) { return backupError(reply, error); }
  });
  // V2 is a separate complete-export contract; legacy v1 routes remain unchanged.
  fastify.post('/export-v2', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    let masterKey: Buffer | undefined;
    try {
      withAdmin(request, () => undefined);
      const parse = ExportV2Schema.safeParse(request.body);
      if (!parse.success) throw new BackupV2ValidationError();

      masterKey = createHash('sha256').update(config.masterKey, 'utf8').digest();
      const exported = await buildFullBackupV2({
        sqlite: fastify.sqlite,
        beforeSnapshot: () => { withAdmin(request, () => undefined); },
        validateSnapshot: checkRestoreRelationships,
        password: parse.data.backupPassword,
        masterKey,
        blindIndexPepper: config.blindIndexPepper,
      });
      const filename = `TZRCoster_Tam_Yedek_${exported.manifest.exportedAt.split('T')[0]}_v2.tzrvault`;
      withAdmin(request, (_tx, audit) => {
        audit.logAction({
          userId: (request.user as { id: string }).id,
          action: 'EXPORT',
          entity: 'system_backup',
          entityId: 'tzrvault-v2',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          newState: { filename, manifest: exported.manifest },
        }, config.masterKey);
      });
      return reply.send({ success: true, filename, vaultData: exported.vault, manifest: exported.manifest });
    } catch (error) {
      if (error instanceof BackupV2Error && error.code === 'RESTORE_RELATION_INVALID') {
        return reply.status(409).send({ code: 'BACKUP_V2_RELATION_INVALID',
          error: 'Yedek geri yüklenemiyor. Kategori hiyerarşisini, şantiye ilişkilerini ve bağlı mali kayıtları kontrol edin.' });
      }
      if (error instanceof BackupV2Error && error.code === 'RESTORE_ATTACHMENTS_UNAVAILABLE') {
        return reply.status(409).send({ code: 'BACKUP_V2_ATTACHMENTS_UNAVAILABLE',
          error: 'V2 yedeği ek dosya içeren kayıtları henüz geri yükleyemiyor.' });
      }
      return backupError(reply, error);
    } finally {
      masterKey?.fill(0);
    }
  });

};