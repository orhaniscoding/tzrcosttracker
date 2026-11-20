import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { authSessions, users, projects, categories, auditLogs, whiteLabelSettings, SESSION_TTL_SECONDS } from '@cost-core/database';

const CFG = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars\u0021' };
const PW = 'Synthetic-Pass-1234';
const PIN = '1234';
let app: FastifyInstance | undefined;

function payload() {
  return { companyName: 'Synthetic Co', baseCurrency: 'TRY', admin: { username: 'setup_admin', fullName: 'Setup Admin', email: 'setup_admin@example.test', password: PW, pin: PIN }, industryTemplate: 'blank', projectName: 'Synthetic Co Main Project' };
}

function setup(a: FastifyInstance, p: any) {
  return a.inject({ method: 'POST', url: '/api/system/setup', headers: { 'x-setup-token': CFG.bootstrapToken }, payload: p });
}

function dump(db: any): string {
  const take = (t: any) => db.select().from(t).all();
  return JSON.stringify({ sessions: take(authSessions), users: take(users), projects: take(projects), cats: take(categories), audit: take(auditLogs), settings: take(whiteLabelSettings) });
}
function raw(app: FastifyInstance): any { const db: any = (app as any).db; return db.session.client || db.$client || db.session; }
function exec(app: FastifyInstance, sql: string) { raw(app).exec(sql); }
const Q = String.fromCharCode(39);
const TRG_SESSION = 'CREATE TRIGGER fail_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT,' + Q + 'synthetic session failure' + Q + '); END;';
const TRG_AUDIT = 'CREATE TRIGGER fail_setup_audit BEFORE INSERT ON audit_logs WHEN NEW.entity_id=' + Q + 'initial_setup' + Q + ' BEGIN SELECT RAISE(ABORT,' + Q + 'synthetic setup audit failure' + Q + '); END;';
const TABLES = () => [authSessions, users, projects, categories, auditLogs, whiteLabelSettings];
describe('setup session atomic', () => {
  afterEach(async () => { if (app) { await app.close(); app = undefined; } });

  it('issues one session and rejects token replay without mutation', async () => {
    app = await buildApp({ config: CFG, dbPath: ':memory:' });
    await app.ready();
    const db: any = (app as any).db;
    const res = await setup(app, payload());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.user.role).toBe('admin');
    const decoded: any = (app as any).jwt.decode(body.token);
    const now = Math.floor(Date.now() / 1000);
    expect(typeof decoded.sid).toBe('string');
    expect(decoded.sid.length).toBeGreaterThan(0);
    expect(decoded.exp).toBeGreaterThan(now);
    expect(decoded.exp).toBeLessThanOrEqual(now + SESSION_TTL_SECONDS);
    const sessions = db.select().from(authSessions).all();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe(decoded.sid);
    expect(sessions[0].userId).toBe(body.user.id);
    expect(sessions[0].userId).toBe(decoded.id);
    expect(sessions[0].expiresAt).toBe(decoded.exp);
    expect(sessions[0].revokedAt).toBeNull();
    const listed = await app.inject({ method: 'GET', url: '/api/projects', headers: { authorization: 'Bearer ' + body.token } });
    expect(listed.statusCode).toBe(200);
    const before = dump(db);
    const counts = () => TABLES().map((t) => db.select().from(t).all().length);
    expect(counts()).toEqual([1, 1, 1, db.select().from(categories).all().length, 1, 1]);
    const replay = await setup(app, payload());
    expect(replay.statusCode).toBe(403);
    expect(replay.json().token).toBeUndefined();
    expect(dump(db)).toBe(before);
    expect(counts()).toEqual([1, 1, 1, db.select().from(categories).all().length, 1, 1]);
  });

  it('session insert abort rolls back everything then retry issues one valid session', async () => {
    app = await buildApp({ config: CFG, dbPath: ':memory:' }); await app.ready();
    const a = app; const db: any = (a as any).db; exec(a, TRG_SESSION);
    const before = dump(db); const parsed = JSON.parse(before);
    expect(parsed.sessions.length).toBe(0); expect(parsed.users.length).toBe(0); expect(parsed.projects.length).toBe(0); expect(parsed.cats.length).toBe(0); expect(parsed.audit.length).toBe(0);
    const settingsLen = parsed.settings.length;
    const failed = await setup(a, payload());
    expect(failed.statusCode).toBe(500); expect(failed.json().token).toBeUndefined();
    expect(dump(db)).toBe(before);
    expect(db.select().from(authSessions).all().length).toBe(0); expect(db.select().from(users).all().length).toBe(0);
    expect(db.select().from(projects).all().length).toBe(0); expect(db.select().from(categories).all().length).toBe(0);
    expect(db.select().from(auditLogs).all().length).toBe(0); expect(db.select().from(whiteLabelSettings).all().length).toBe(settingsLen);
    exec(a, 'DROP TRIGGER IF EXISTS fail_session');
    const ok = await setup(a, payload()); expect(ok.statusCode).toBe(201);
    const body = ok.json(); const sessions = db.select().from(authSessions).all();
    expect(sessions.length).toBe(1);
    const decoded: any = (a as any).jwt.decode(body.token);
    expect(decoded.sid.length).toBeGreaterThan(0); expect(sessions[0].id).toBe(decoded.sid);
    expect(sessions[0].userId).toBe(body.user.id); expect(sessions[0].expiresAt).toBe(decoded.exp); expect(sessions[0].revokedAt).toBeNull();
    const listed = await a.inject({ method: 'GET', url: '/api/projects', headers: { authorization: 'Bearer ' + body.token } });
    expect(listed.statusCode).toBe(200);
    const chain = await a.auditRepo.verifyChainIntegrity(CFG.masterKey); expect(chain.valid).toBe(true);
  });

  it('initial setup audit insert abort rolls back everything then retry succeeds', async () => {
    app = await buildApp({ config: CFG, dbPath: ':memory:' }); await app.ready();
    const a = app; const db: any = (a as any).db; exec(a, TRG_AUDIT);
    const before = dump(db); const parsed = JSON.parse(before);
    expect(parsed.sessions.length).toBe(0); expect(parsed.users.length).toBe(0); expect(parsed.projects.length).toBe(0); expect(parsed.cats.length).toBe(0); expect(parsed.audit.length).toBe(0);
    const settingsLen = parsed.settings.length;
    const failed = await setup(a, payload());
    expect(failed.statusCode).toBe(500); expect(failed.json().token).toBeUndefined();
    expect(dump(db)).toBe(before);
    expect(db.select().from(authSessions).all().length).toBe(0); expect(db.select().from(users).all().length).toBe(0);
    expect(db.select().from(projects).all().length).toBe(0); expect(db.select().from(categories).all().length).toBe(0);
    expect(db.select().from(auditLogs).all().length).toBe(0); expect(db.select().from(whiteLabelSettings).all().length).toBe(settingsLen);
    exec(a, 'DROP TRIGGER IF EXISTS fail_setup_audit');
    const ok = await setup(a, payload()); expect(ok.statusCode).toBe(201);
    const body = ok.json(); const sessions = db.select().from(authSessions).all();
    expect(sessions.length).toBe(1); expect(sessions[0].userId).toBe(body.user.id); expect(sessions[0].revokedAt).toBeNull();
    const logs = await a.auditRepo.listAuditLogs(100, CFG.masterKey);
    expect(logs.filter((x: any) => x.entity === 'system' && x.entityId === 'initial_setup')).toHaveLength(1);
    const chain = await a.auditRepo.verifyChainIntegrity(CFG.masterKey); expect(chain.valid).toBe(true);
  });
});
