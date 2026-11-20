import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from '@cost-core/types';
import { AuditLogRepository } from '@cost-core/database';
import { ForbiddenError, SessionInvalidError } from '../services/project-access.service.js';
import { BackupV2Error, buildFullBackupV2 } from '../services/backup-v2-export.service.js';
import { checkRestoreRelationships } from '../services/backup-v2-restore.service.js';

const ExportV2Schema = z.object({
  backupPassword: z.string().refine((value) => {
    const bytes = Buffer.byteLength(value, 'utf8');
    return bytes >= 12 && bytes <= 256;
  }),
});
class BackupV2ValidationError extends Error {}

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
    return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
  }

  for (const endpoint of ['/export', '/import']) {
    fastify.post(endpoint, {
      onRequest: [fastify.authenticate, async (request, reply) => {
        try {
          withAdmin(request, () => undefined);
          return reply.status(410).send({ code: 'BACKUP_V1_RETIRED', error: 'V1 yedek işlemleri kaldırıldı. V2 yedeğini kullanın.' });
        } catch (error) {
          return backupError(reply, error);
        }
      }],
    }, async () => undefined);
  }
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
      if (error instanceof BackupV2Error && error.code === 'LIMIT_EXCEEDED') {
        return reply.status(413).send({ code: 'BACKUP_V2_LIMIT_EXCEEDED', error: 'V2 yedek dışa aktarım sınırı aşıldı.' });
      }
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
