import type { FastifyPluginAsync } from 'fastify';
import { AuditLogRepository } from '@cost-core/database';
import { ForbiddenError, SessionInvalidError } from '../services/project-access.service.js';

class AuditValidationError extends Error {}

function auditLimit(value: unknown): number {
  const query = (value ?? {}) as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(query, 'limit')) return 100;
  const input = query.limit;
  if (typeof input !== 'string' || input.length === 0 || /[^0-9]/.test(input)) throw new AuditValidationError();
  const limit = Number(input);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new AuditValidationError();
  return limit;
}

export const auditRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, projectAccess } = fastify;
  const db: any = fastify.db;

  // Both the decrypted global diff and verification count/id are admin-only.
  // Fresh authorization and the read share one synchronous database snapshot.
  function readAudit<T>(request: any, read: (repo: AuditLogRepository) => T): T {
    return db.transaction((tx: any) => {
      const session = request.authSession;
      projectAccess.requireFreshAdmin(tx, request.user?.id, session?.id, session ? Number(session.expiresAt) : NaN);
      return read(new AuditLogRepository(tx));
    });
  }

  function auditError(reply: any, error: unknown) {
    if (error instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
    if (error instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
    if (error instanceof AuditValidationError) return reply.status(400).send({ error: 'Geçersiz denetim kaydı limiti.' });
    return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
  }

  // Only limit is accepted; client scope/user/role/project fields confer no access.
  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const logs = readAudit(request, repo => repo.listAuditLogs(auditLimit(request.query), config.masterKey));
      return reply.send(logs);
    } catch (error) { return auditError(reply, error); }
  });

  // This verifies the stored audit chain, not every application row or an external anchor.
  fastify.get('/verify', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const verification = readAudit(request, repo => repo.verifyChainIntegrity(config.masterKey));
      return reply.send({
        verified: verification.valid,
        totalRecordsVerified: verification.count,
        corruptedAtId: verification.corruptedAtId || null,
        message: verification.valid
          ? 'Saklanan denetim zincirinin bağlantıları ve hash kapsamındaki denetim verileri doğrulandı; uygulama tablolarının tamamı doğrulanmaz.'
          : 'Saklanan denetim zincirinin bağlantılarında veya hash kapsamındaki denetim verilerinde tutarsızlık tespit edildi.',
      });
    } catch (error) { return auditError(reply, error); }
  });
};
