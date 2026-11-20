import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AuditLogRepository, categories, type CostCoreDatabase } from '@cost-core/database';
import { CreateCategorySchema } from '@cost-core/types';
import { ForbiddenError, SessionInvalidError, isValidPathId } from '../services/project-access.service.js';

class CategoryValidationError extends Error {}
class CategoryCycleError extends Error {}
type CategoryTransaction = Parameters<Parameters<CostCoreDatabase['transaction']>[0]>[0];
const createSchema = CreateCategorySchema.extend({ budget: CreateCategorySchema.shape.budget.unwrap().finite().optional() });
const updateSchema = createSchema.partial();
// Explicit SQL projection, not post-read redaction. Common reference definitions
// are visible to every current role, irrespective of project membership.
const referenceColumns = {
  id: categories.id, name: categories.name, code: categories.code,
  parentId: categories.parentId, color: categories.color, icon: categories.icon,
  orderIndex: categories.orderIndex, customFieldIds: categories.customFieldIds, isActive: categories.isActive,
};
function decodeCategory<T extends { customFieldIds: string }>(row: T) {
  return { ...row, customFieldIds: JSON.parse(row.customFieldIds || '[]') as string[] };
}
function categoryTree<T extends { id: string; parentId: string | null }>(all: T[]) {
  type Node = T & { children: Node[] };
  const map = new Map<string, Node>();
  for (const row of all) map.set(row.id, { ...row, children: [] });
  const roots: Node[] = [];
  // Preserve repository iteration order and treat missing parents as roots.
  for (const row of all) {
    const node = map.get(row.id)!;
    if (row.parentId && map.has(row.parentId)) map.get(row.parentId)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}
function assertAcyclicParent(tx: CategoryTransaction, categoryId: string, parentId: string | null) {
  const visited = new Set([categoryId]);
  let currentId = parentId;
  while (currentId !== null) {
    if (visited.has(currentId)) throw new CategoryCycleError();
    visited.add(currentId);
    const current = tx.select({ parentId: categories.parentId }).from(categories).where(eq(categories.id, currentId)).get();
    currentId = current?.parentId ?? null;
  }
}
function categoryError(reply: FastifyReply, error: unknown) {
  if (error instanceof CategoryCycleError) return reply.status(409).send({ code: 'CATEGORY_CYCLE', error: 'Kategori hiyerarşisinde döngü oluşturulamaz.' });
  if (error instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
  if (error instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
  if (error instanceof CategoryValidationError) return reply.status(400).send({ error: 'Geçersiz veri.' });
  return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
}
function pathId(request: FastifyRequest) {
  const { id } = request.params as { id: unknown };
  if (!isValidPathId(id)) throw new CategoryValidationError();
  return id;
}

export const categoryRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, projectAccess } = fastify;
  const db = fastify.db as CostCoreDatabase;
  // CategoryRepository remains async. All route operations use the synchronous
  // driver API so actor/session checks, data and audit share one transaction.
  function inCategoryTransaction<T>(request: FastifyRequest, write: boolean, work: (tx: CategoryTransaction, userId: string, role: string) => T): T {
    return db.transaction(tx => {
      const userId = (request.user as { id: string }).id, session = request.authSession;
      const role = write
        ? projectAccess.requireFreshAdmin(tx, userId, session?.id as string, session ? Number(session.expiresAt) : NaN)
        : projectAccess.requireFreshActor(tx, userId, session?.id as string, session ? Number(session.expiresAt) : NaN);
      return work(tx, userId, role);
    }, write ? { behavior: 'immediate' } : undefined);
  }
  function audit(tx: CategoryTransaction, request: FastifyRequest, input: Parameters<AuditLogRepository['logAction']>[0]) {
    new AuditLogRepository(tx as unknown as CostCoreDatabase).logAction({
      ...input, entity: 'category', ipAddress: request.ip, userAgent: request.headers['user-agent'],
    }, config.masterKey);
  }

  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const result = inCategoryTransaction(request, false, (tx, _userId, role) => {
        const query = request.query as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(query, 'tree') && query.tree !== 'true' && query.tree !== 'false') throw new CategoryValidationError();
        const list = role === 'admin'
          ? tx.select().from(categories).all().map(decodeCategory)
          : tx.select(referenceColumns).from(categories).all().map(decodeCategory);
        return query.tree === 'true' ? categoryTree<(typeof list)[number]>(list) : list;
      });
      return reply.send(result);
    } catch (error) { return categoryError(reply, error); }
  });

  fastify.get('/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const result = inCategoryTransaction(request, false, (tx, _userId, role) => {
        const id = pathId(request);
        const row = role === 'admin'
          ? tx.select().from(categories).where(eq(categories.id, id)).get()
          : tx.select(referenceColumns).from(categories).where(eq(categories.id, id)).get();
        return row ? decodeCategory(row) : null;
      });
      if (!result) return reply.status(404).send({ error: 'Kategori bulunamadı.' });
      return reply.send(result);
    } catch (error) { return categoryError(reply, error); }
  });

  fastify.post('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const created = inCategoryTransaction(request, true, (tx, userId) => {
        const parse = createSchema.safeParse(request.body);
        if (!parse.success) throw new CategoryValidationError();
        const input = parse.data, now = new Date().toISOString();
        const row: typeof categories.$inferSelect = {
          id: randomUUID(), name: input.name, code: input.code || null, parentId: input.parentId || null,
          description: input.description || null, budget: input.budget ?? 0, color: input.color || '#3B82F6',
          icon: input.icon || 'folder', orderIndex: input.orderIndex ?? 0,
          customFieldIds: JSON.stringify(input.customFieldIds || []), isActive: true, createdAt: now, updatedAt: now,
        };
        assertAcyclicParent(tx, row.id, row.parentId);
        tx.insert(categories).values(row).run();
        const result = decodeCategory(row);
        audit(tx, request, { userId, action: 'CREATE', entity: 'category', entityId: row.id, newState: result });
        return result;
      });
      return reply.status(201).send(created);
    } catch (error) { return categoryError(reply, error); }
  });

  fastify.put('/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const updated = inCategoryTransaction(request, true, (tx, userId) => {
        const id = pathId(request), parse = updateSchema.safeParse(request.body);
        if (!parse.success) throw new CategoryValidationError();
        const previous = tx.select().from(categories).where(eq(categories.id, id)).get();
        if (!previous) return null;
        const { customFieldIds, ...fields } = parse.data;
        if (fields.parentId !== undefined && fields.parentId !== previous.parentId) {
          assertAcyclicParent(tx, id, fields.parentId);
        }
        const values: Partial<typeof categories.$inferInsert> = { ...fields, updatedAt: new Date().toISOString() };
        if (customFieldIds !== undefined) values.customFieldIds = JSON.stringify(customFieldIds);
        tx.update(categories).set(values).where(eq(categories.id, id)).run();
        const result = decodeCategory(tx.select().from(categories).where(eq(categories.id, id)).get()!);
        audit(tx, request, { userId, action: 'UPDATE', entity: 'category', entityId: id, previousState: decodeCategory(previous), newState: result });
        return result;
      });
      if (!updated) return reply.status(404).send({ error: 'Kategori bulunamadı.' });
      return reply.send(updated);
    } catch (error) { return categoryError(reply, error); }
  });

  fastify.delete('/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const deleted = inCategoryTransaction(request, true, (tx, userId) => {
        const id = pathId(request), previous = tx.select().from(categories).where(eq(categories.id, id)).get();
        if (!previous) return false;
        tx.delete(categories).where(eq(categories.id, id)).run();
        audit(tx, request, { userId, action: 'DELETE', entity: 'category', entityId: id, previousState: decodeCategory(previous) });
        return true;
      });
      if (!deleted) return reply.status(404).send({ error: 'Kategori bulunamadı veya silinemedi.' });
      return reply.send({ success: true, message: 'Kategori başarıyla silindi.' });
    } catch (error) { return categoryError(reply, error); }
  });
};
