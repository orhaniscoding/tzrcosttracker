import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { AuditLogRepository, customFields, type CostCoreDatabase } from '@cost-core/database';
import { CustomFieldDefinitionSchema } from '@cost-core/types';
import { ForbiddenError, SessionInvalidError } from '../services/project-access.service.js';

class CustomFieldValidationError extends Error {}
type CustomFieldTransaction = Parameters<Parameters<CostCoreDatabase['transaction']>[0]>[0];
const createSchema = CustomFieldDefinitionSchema.omit({ id: true });
// Shared field definitions are reference data, not transaction value data.
// An explicit SQL projection keeps server-only columns (createdAt) out of the
// response while preserving the repository's list DTO and row order.
const definitionColumns = {
  id: customFields.id, name: customFields.name, label: customFields.label,
  type: customFields.type, optionsJson: customFields.optionsJson, unit: customFields.unit,
  required: customFields.required, placeholder: customFields.placeholder,
  defaultValue: customFields.defaultValue,
};

function decodeCustomField<T extends {
  id: string; name: string; label: string; type: string; required: boolean;
  optionsJson: string | null; unit: string | null; placeholder: string | null; defaultValue: string | null;
}>(row: T) {
  // Same key order and fallbacks as CustomFieldRepository.listCustomFields.
  return {
    id: row.id, name: row.name, label: row.label, type: row.type,
    options: row.optionsJson ? (JSON.parse(row.optionsJson) as string[]) : undefined,
    unit: row.unit || undefined, required: row.required,
    placeholder: row.placeholder || undefined, defaultValue: row.defaultValue || undefined,
  };
}

function customFieldError(reply: FastifyReply, error: unknown) {
  if (error instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
  if (error instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
  if (error instanceof CustomFieldValidationError) return reply.status(400).send({ error: 'Geçersiz veri.' });
  return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
}

export const customFieldRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, projectAccess } = fastify;
  const db = fastify.db as CostCoreDatabase;

  // CustomFieldRepository remains async. These two routes use the synchronous
  // driver API so fresh actor/session checks, data access and audit share one
  // transaction; writes are immediate and commit before serialization.
  function inCustomFieldTransaction<T>(request: FastifyRequest, write: boolean, work: (tx: CustomFieldTransaction, userId: string, role: string) => T): T {
    return db.transaction(tx => {
      const userId = (request.user as { id: string }).id, session = request.authSession;
      const role = write
        ? projectAccess.requireFreshAdmin(tx, userId, session?.id as string, session ? Number(session.expiresAt) : NaN)
        : projectAccess.requireFreshActor(tx, userId, session?.id as string, session ? Number(session.expiresAt) : NaN);
      return work(tx, userId, role);
    }, write ? { behavior: 'immediate' } : undefined);
  }

  // 1. ÖZEL ALAN TANIMLARINI LİSTELE — every fresh authenticated role.
  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const list = inCustomFieldTransaction(request, false, tx =>
        tx.select(definitionColumns).from(customFields).all().map(decodeCustomField));
      return reply.send(list);
    } catch (error) { return customFieldError(reply, error); }
  });

  // 2. YENİ ÖZEL ALAN TANIMI OLUŞTUR — fresh admin only, before validation.
  fastify.post('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const created = inCustomFieldTransaction(request, true, (tx, userId) => {
        const parse = createSchema.safeParse(request.body);
        if (!parse.success) throw new CustomFieldValidationError();
        const input = parse.data, now = new Date().toISOString();
        // Mirror CustomFieldRepository defaults; never spread client/server fields.
        const row: typeof customFields.$inferInsert = {
          id: randomUUID(), name: input.name, label: input.label, type: input.type,
          optionsJson: input.options ? JSON.stringify(input.options) : null,
          unit: input.unit || null, required: input.required ?? false,
          placeholder: input.placeholder || null,
          defaultValue: input.defaultValue ? String(input.defaultValue) : null,
          createdAt: now,
        };
        tx.insert(customFields).values(row).run();
        // Creation response keeps the repository's raw input semantics; a later
        // list read returns the stored-string/null-to-undefined projection.
        const result = {
          id: row.id, name: row.name, label: row.label, type: row.type,
          options: input.options, unit: input.unit, required: row.required,
          placeholder: input.placeholder, defaultValue: input.defaultValue,
        };
        // Repository accepts the root DB type but uses only the shared
        // synchronous transaction API. Bind it to this tx, never fastify.db.
        new AuditLogRepository(tx as unknown as CostCoreDatabase).logAction({
          userId, action: 'CREATE', entity: 'custom_field', entityId: row.id,
          ipAddress: request.ip, userAgent: request.headers['user-agent'], newState: result,
        }, config.masterKey);
        return result;
      });
      return reply.status(201).send(created);
    } catch (error) { return customFieldError(reply, error); }
  });
};
