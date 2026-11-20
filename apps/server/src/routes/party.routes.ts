import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AuditLogRepository, parties, type CostCoreDatabase } from '@cost-core/database';
import { createBlindIndex } from '@cost-core/crypto';
import { CreatePartySchema, PartyTypeSchema } from '@cost-core/types';
import { ForbiddenError, SessionInvalidError, isValidPathId } from '../services/project-access.service.js';

class PartyValidationError extends Error {}
type PartyTransaction = Parameters<Parameters<CostCoreDatabase['transaction']>[0]>[0];

function partyError(reply: FastifyReply, error: unknown) {
  if (error instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
  if (error instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
  if (error instanceof PartyValidationError) return reply.status(400).send({ error: 'Geçersiz veri.' });
  return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
}

export const partyRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, projectAccess } = fastify;
  const db = fastify.db as CostCoreDatabase;

  // The directory has no project linkage: membership never grants access.
  // PartyRepository is async; keep these narrowly scoped operations synchronous
  // so fresh authorization, mutation and tx-bound audit commit atomically.
  function inPartyTransaction<T>(request: FastifyRequest, write: boolean, work: (tx: PartyTransaction, userId: string) => T): T {
    return db.transaction(tx => {
      const userId = (request.user as { id: string }).id;
      const session = request.authSession;
      projectAccess.requireFreshAdmin(tx, userId, session?.id as string, session ? Number(session.expiresAt) : NaN);
      return work(tx, userId);
    }, write ? { behavior: 'immediate' } : undefined);
  }

  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const list = inPartyTransaction(request, false, tx => {
        const query = request.query as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(query, 'type')) return tx.select().from(parties).all();
        const parsed = PartyTypeSchema.safeParse(query.type);
        if (!parsed.success) throw new PartyValidationError();
        return tx.select().from(parties).where(eq(parties.type, parsed.data)).all();
      });
      return reply.send(list);
    } catch (error) { return partyError(reply, error); }
  });

  fastify.post('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const created = inPartyTransaction(request, true, (tx, userId) => {
        const parse = CreatePartySchema.safeParse(request.body);
        if (!parse.success) throw new PartyValidationError();
        const input = parse.data, now = new Date().toISOString();
        // Mirror PartyRepository defaults; never spread client/server fields.
        const row: typeof parties.$inferInsert = {
          id: randomUUID(), name: input.name,
          nameBlindIndex: createBlindIndex(input.name, config.blindIndexPepper),
          type: input.type || 'supplier', phone: input.phone || null,
          email: input.email || null, iban: input.iban || null,
          taxNo: input.taxNo || null, taxOffice: input.taxOffice || null,
          notes: input.notes || null, isActive: true, createdAt: now, updatedAt: now,
        };
        tx.insert(parties).values(row).run();
        // Repository accepts the root DB type, but uses only the shared
        // synchronous transaction API. Bind it to this tx, never fastify.db.
        new AuditLogRepository(tx as unknown as CostCoreDatabase).logAction({
          userId, action: 'CREATE', entity: 'party', entityId: row.id,
          ipAddress: request.ip, userAgent: request.headers['user-agent'], newState: row,
        }, config.masterKey);
        return row;
      });
      return reply.status(201).send(created);
    } catch (error) { return partyError(reply, error); }
  });

  fastify.delete('/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const deleted = inPartyTransaction(request, true, (tx, userId) => {
        const { id } = request.params as { id: unknown };
        if (!isValidPathId(id)) throw new PartyValidationError();
        const previousState = tx.select().from(parties).where(eq(parties.id, id)).get();
        if (!previousState) return false;
        tx.delete(parties).where(eq(parties.id, id)).run();
        new AuditLogRepository(tx as unknown as CostCoreDatabase).logAction({
          userId, action: 'DELETE', entity: 'party', entityId: id,
          ipAddress: request.ip, userAgent: request.headers['user-agent'], previousState,
        }, config.masterKey);
        return true;
      });
      if (!deleted) return reply.status(404).send({ error: 'Cari bulunamadı.' });
      return reply.send({ success: true, message: 'Cari kaydı silindi.' });
    } catch (error) { return partyError(reply, error); }
  });
};
