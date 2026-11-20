import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import { AppConfig, loadConfig } from './config.js';
import {
  initLeasedDatabase,
  type DatabaseInstance,
  UserRepository,
  CategoryRepository,
  CustomFieldRepository,
  TransactionRepository,
  AuditLogRepository,
  WhiteLabelRepository,
  ProjectRepository,
  PartyRepository,
  AccountRepository,
  SetupRepository,
  SessionRepository,
  ProjectMembershipRepository,
} from '@cost-core/database';
import type { AuthSession } from '@cost-core/database';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { ProjectAccessService } from './services/project-access.service.js';

import { authRoutes } from './routes/auth.routes.js';
import { categoryRoutes } from './routes/category.routes.js';
import { customFieldRoutes } from './routes/custom-field.routes.js';
import { transactionRoutes } from './routes/transaction.routes.js';
import { auditRoutes } from './routes/audit.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { reportRoutes } from './routes/report.routes.js';
import { projectRoutes } from './routes/project.routes.js';
import { partyRoutes } from './routes/party.routes.js';
import { accountRoutes } from './routes/account.routes.js';
import { importRoutes } from './routes/import.routes.js';
import { systemRoutes } from './routes/system.routes.js';
import { backupRoutes } from './routes/backup.routes.js';

// Fastify modül genişletmesi
declare module 'fastify' {
  interface FastifyRequest {
    authSession: AuthSession | null;
  }
  interface FastifyInstance {
    config: AppConfig;
    authenticate: any;
    userRepo: UserRepository;
    categoryRepo: CategoryRepository;
    customFieldRepo: CustomFieldRepository;
    transactionRepo: TransactionRepository;
    auditRepo: AuditLogRepository;
    whiteLabelRepo: WhiteLabelRepository;
    projectRepo: ProjectRepository;
    partyRepo: PartyRepository;
    accountRepo: AccountRepository;
    setupRepo: SetupRepository;
    sessionRepo: SessionRepository;
    projectAccess: ProjectAccessService;
    projectMembershipRepo: ProjectMembershipRepository;
    db: unknown;
    sqlite: BetterSqliteDatabase;
  }
}

export interface BuildAppOptions {
  config?: Partial<AppConfig>;
  dbPath?: string;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config: AppConfig = loadConfig({
    ...options.config,
    dbPath: options.dbPath || options.config?.dbPath || ':memory:',
  });

  const fastify = Fastify({
    logger: false,
    routerOptions: { maxParamLength: 128 },
  });

  // CORS ve Güvenlik
  await fastify.register(cors, {
    origin: false,
    credentials: false,
  });

  // JWT Eklentisi
  await fastify.register(jwt, {
    secret: config.jwtSecret,
  });

  // Veritabanı ve Repository katmanı
  await fastify.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    cache: 5000,
    errorResponseBuilder: (_req: any, context: any) => { const err: any = new Error('\u00c7ok fazla deneme yap\u0131ld\u0131. L\u00fctfen daha sonra tekrar deneyin.'); err.statusCode = context?.statusCode ?? 429; return err; },
  });

  fastify.setErrorHandler((err: any, _request: any, reply: any) => {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    if (status === 429) { return reply.status(429).send({ error: '\u00c7ok fazla deneme yap\u0131ld\u0131. L\u00fctfen daha sonra tekrar deneyin.' }); }
    if (status >= 400 && status < 500) { const msg = typeof err?.message === 'string' && err.message ? err.message : '\u0130stek i\u015flenemedi.'; return reply.status(status).send({ error: msg }); }
    return reply.status(500).send({ error: 'Beklenmedik bir hata olu\u015ftu. L\u00fctfen daha sonra tekrar deneyin.' });
  });

  const database = initLeasedDatabase(config.dbPath);
  try {
    fastify.addHook('onClose', async () => { database.close(); });
    await registerDatabaseRoutes(fastify, config, database);
    return fastify;
  } catch (error) {
    try {
      database.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Could not close the database after failed server startup.');
    }
    throw error;
  }
}

async function registerDatabaseRoutes(fastify: FastifyInstance, config: AppConfig, { db, sqlite }: DatabaseInstance) {

  fastify.decorate('config', config);
  fastify.decorate('userRepo', new UserRepository(db));
  fastify.decorate('categoryRepo', new CategoryRepository(db));
  fastify.decorate('customFieldRepo', new CustomFieldRepository(db));
  fastify.decorate('transactionRepo', new TransactionRepository(db));
  fastify.decorate('auditRepo', new AuditLogRepository(db));
  fastify.decorate('whiteLabelRepo', new WhiteLabelRepository(db));
  fastify.decorate('projectRepo', new ProjectRepository(db));
  fastify.decorate('partyRepo', new PartyRepository(db));
  fastify.decorate('accountRepo', new AccountRepository(db));
  fastify.decorate('setupRepo', new SetupRepository(db));
  fastify.decorate('sessionRepo', new SessionRepository(db));
  fastify.decorate('projectAccess', new ProjectAccessService());
  fastify.decorate('projectMembershipRepo', new ProjectMembershipRepository(db));
  fastify.decorateRequest('authSession', null);
  fastify.decorate('db', db);
  fastify.decorate('sqlite', sqlite);

  // Kimlik doğrulama kancası (Authentication Hook)
  fastify.decorate('authenticate', async (request: any, reply: any) => {
    const authError = () => reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz eri\u015fim. Ge\u00e7erli bir oturum a\u00e7manız gerekmektedir.' });
    let payload: any;
    try {
      await request.jwtVerify();
      payload = request.user;
    } catch (err) {
      return authError();
    }
    if (payload && payload.is2FaPending === true) {
      return authError();
    }
    const sid = payload?.sid; const exp = payload?.exp;
    if (typeof sid !== 'string' || sid.trim().length === 0 || typeof exp !== 'number' || !Number.isFinite(exp)) { return authError(); }
    const id = payload?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      return authError();
    }
    let state: { id: string; username: string; role: string; isActive: boolean } | null;
    try {
      state = await fastify.userRepo.getAuthStateById(id);
    } catch (err) {
      return reply.status(500).send({ error: 'Beklenmedik bir hata olu\u015ftu. L\u00fctfen daha sonra tekrar deneyin.' });
    }
    if (!state || !state.isActive) {
      return authError();
    }
    const validRoles = ['admin','manager','accountant','auditor','viewer'];
    if (!validRoles.includes(state.role)) {
      return authError();
    }
    let session: AuthSession | null;
    try { session = fastify.sessionRepo.getActiveSession(sid, id); } catch (err) { return reply.status(500).send({ error: 'Beklenmedik bir hata olustu.' }); }
    if (!session || session.expiresAt !== exp) { return authError(); }
    request.authSession = session;
    request.user = { id: state.id, username: state.username, role: state.role };
    if ((state.role === 'viewer' || state.role === 'auditor') && ['POST','PUT','PATCH','DELETE'].includes(request.method)) {
      const ro = (request as any).routeOptions;
      const matched = (ro && ro.url) || (request as any).routerPath || '';
      const allowed = ['/api/auth/set-pin','/api/auth/switch-pin','/api/auth/2fa/setup','/api/auth/2fa/enable','/api/transactions/check-duplicate','/api/auth/logout','/api/auth/logout-all'];
      if (!allowed.includes(matched)) {
        return reply.status(403).send({ error: 'Yasak: salt okunur rol bu i\u015flemi ger\u00e7ekle\u015ftiremez.' });
      }
    }
  });

  // Sağlık kontrolü
  fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // API Rotaları
  await fastify.register(authRoutes, { prefix: '/api/auth' });
  await fastify.register(projectRoutes, { prefix: '/api/projects' });
  await fastify.register(partyRoutes, { prefix: '/api/parties' });
  await fastify.register(accountRoutes, { prefix: '/api/accounts' });
  await fastify.register(categoryRoutes, { prefix: '/api/categories' });
  await fastify.register(customFieldRoutes, { prefix: '/api/custom-fields' });
  await fastify.register(transactionRoutes, { prefix: '/api/transactions' });
  await fastify.register(auditRoutes, { prefix: '/api/audit' });
  await fastify.register(settingsRoutes, { prefix: '/api/settings' });
  await fastify.register(reportRoutes, { prefix: '/api/reports' });
  await fastify.register(importRoutes, { prefix: '/api/import' });
  await fastify.register(systemRoutes, { prefix: '/api/system' });
  await fastify.register(backupRoutes, { prefix: '/api/backup' });

}
