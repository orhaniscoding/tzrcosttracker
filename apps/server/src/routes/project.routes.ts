import type { FastifyPluginAsync } from 'fastify';
import { CreateProjectSchema } from '@cost-core/types';
import { AuditLogRepository, projectMemberships, projects, users } from '@cost-core/database';
import { and, eq } from 'drizzle-orm';
import { ForbiddenError, NotFoundError, ProjectAccessService, SessionInvalidError, isValidPathId } from '../services/project-access.service.js';

function mapError(reply: any, err: any) {
  if (err instanceof SessionInvalidError) { return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz eri\u015fim. Ge\u00e7erli bir oturum a\u00e7man\u0131z gerekmektedir.' }); }
  if (err instanceof ForbiddenError) { return reply.status(403).send({ error: 'Yasak: Bu i\u015flemi ger\u00e7ekle\u015ftirme yetkiniz yok.' }); }
  if (err instanceof NotFoundError) { return reply.status(404).send({ error: 'Bulunamad\u0131.' }); }
  if (err && err.name === 'InvalidMembershipInputError') { return reply.status(400).send({ error: 'Ge\u00e7ersiz \u00fcyelik verisi.' }); }
  return reply.status(500).send({ error: 'Beklenmedik bir hata olu\u015ftu. L\u00fctfen daha sonra tekrar deneyin.' });
}

function actorId(request: any): string { const u: any = request && request.user; return u && typeof u.id === 'string' ? u.id : ''; }
function sessionOf(request: any): any { return (request && request.authSession) || null; }
function membershipDto(row: any) { return { userId: row.userId, projectId: row.projectId, createdAt: row.createdAt }; }
function auditEntityId(projectId: string, userId: string) { return JSON.stringify([projectId, userId]); }

export const projectRoutes: FastifyPluginAsync = async (fastify) => {
  const { projectRepo, config } = fastify;
  const db: any = (fastify as any).db;
  const access = (fastify as any).projectAccess as ProjectAccessService;
  const memberships = (fastify as any).projectMembershipRepo;

  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const uid = actorId(request as any);
    let rows: any[] = [];
    try {
      db.transaction((tx: any) => {
        const scope = access.resolveScopeInTx(tx, uid);
        if (scope.all) { rows = tx.select().from(projects).all(); return; }
        rows = scope.projectIds.length ? projectRepo.listProjectsByIds(scope.projectIds) : [];
      });
    } catch (err) { return mapError(reply, err); }
    return reply.send(rows);
  });

  fastify.post('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const parse = CreateProjectSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Invalid data', details: parse.error.format() });
    }
    const uid = actorId(request as any);
    const sess = sessionOf(request as any);
    let created: any = null;
    try {
      db.transaction((tx: any) => {
        access.requireFreshAdmin(tx, uid, sess && typeof sess.id === 'string' ? sess.id : '', sess ? Number(sess.expiresAt) : NaN);
        const row = projectRepo.createProjectInTx(tx, parse.data);
        new AuditLogRepository(tx).logAction({ userId: uid, action: 'CREATE', entity: 'project', entityId: row.id, ipAddress: (request as any).ip, userAgent: (request as any).headers['user-agent'], newState: row }, config.masterKey);
        created = row;
      }, { behavior: 'immediate' });
    } catch (err) { return mapError(reply, err); }
    return reply.status(201).send(created);
  });

  fastify.get('/:id/members', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const projectId = (request.params as any)?.id;
    const uid = actorId(request as any); const sess = sessionOf(request as any);
    if (!isValidPathId(projectId)) { return reply.status(400).send({ error: 'Ge\u00e7ersiz kimlik.' }); }
    let out: any[] | null = null;
    try {
      db.transaction((tx: any) => {
        access.requireFreshAdmin(tx, uid, sess && typeof sess.id === 'string' ? sess.id : '', sess ? Number(sess.expiresAt) : NaN);
        if (!projectRepo.getProjectByIdInTx(tx, projectId)) { throw new NotFoundError(); }
        out = memberships.listMembersForProject(projectId).map(membershipDto);
      });
    } catch (err) { return mapError(reply, err); }
    return reply.send(out || []);
  });

  fastify.put('/:id/members/:userId', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const projectId = (request.params as any)?.id;
    const targetId = (request.params as any)?.userId;
    const uid = actorId(request as any); const sess = sessionOf(request as any);
    if (!isValidPathId(projectId) || !isValidPathId(targetId)) { return reply.status(400).send({ error: 'Ge\u00e7ersiz kimlik.' }); }
    let changed = false;
    try {
      db.transaction((tx: any) => {
        access.requireFreshAdmin(tx, uid, sess && typeof sess.id === 'string' ? sess.id : '', sess ? Number(sess.expiresAt) : NaN);
        if (!projectRepo.getProjectByIdInTx(tx, projectId)) { throw new NotFoundError(); }
        const target = tx.select({ id: users.id, isActive: users.isActive }).from(users).where(eq(users.id, targetId)).get();
        if (!target || !target.isActive) { throw new NotFoundError(); }
        changed = memberships.grantMembershipInTx(tx, targetId, projectId);
        if (changed) {
          const row = tx.select().from(projectMemberships).where(and(eq(projectMemberships.userId, targetId), eq(projectMemberships.projectId, projectId))).get();
          new AuditLogRepository(tx).logAction({ userId: uid, action: 'CREATE', entity: 'project_membership', entityId: auditEntityId(projectId, targetId), ipAddress: (request as any).ip, userAgent: (request as any).headers['user-agent'], previousState: null, newState: membershipDto(row) }, config.masterKey);
        }
      }, { behavior: 'immediate' });
    } catch (err) { return mapError(reply, err); }
    return reply.status(200).send({ changed });
  });

  fastify.delete('/:id/members/:userId', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const projectId = (request.params as any)?.id;
    const targetId = (request.params as any)?.userId;
    const uid = actorId(request as any); const sess = sessionOf(request as any);
    if (!isValidPathId(projectId) || !isValidPathId(targetId)) { return reply.status(400).send({ error: 'Ge\u00e7ersiz kimlik.' }); }
    let changed = false;
    try {
      db.transaction((tx: any) => {
        access.requireFreshAdmin(tx, uid, sess && typeof sess.id === 'string' ? sess.id : '', sess ? Number(sess.expiresAt) : NaN);
        if (!projectRepo.getProjectByIdInTx(tx, projectId)) { throw new NotFoundError(); }
        const target = tx.select({ id: users.id }).from(users).where(eq(users.id, targetId)).get();
        if (!target) { throw new NotFoundError(); }
        const before = tx.select().from(projectMemberships).where(and(eq(projectMemberships.userId, targetId), eq(projectMemberships.projectId, projectId))).get();
        changed = memberships.revokeMembershipInTx(tx, targetId, projectId);
        if (changed && before) {
          new AuditLogRepository(tx).logAction({ userId: uid, action: 'DELETE', entity: 'project_membership', entityId: auditEntityId(projectId, targetId), ipAddress: (request as any).ip, userAgent: (request as any).headers['user-agent'], previousState: membershipDto(before), newState: null }, config.masterKey);
        }
      }, { behavior: 'immediate' });
    } catch (err) { return mapError(reply, err); }
    return reply.status(200).send({ changed });
  });
};
