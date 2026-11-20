import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { authSessions, auditLogs, MAX_ACTIVE_SESSIONS_PER_USER } from '@cost-core/database';
import { buildApp } from '../src/app.js';
const CFG={jwtSecret:'test-jwt-secret-very-long-and-secure-1234',masterKey:'test-master-key-32-bytes-long-1234',blindIndexPepper:'test-pepper-for-blind-index-1234',bootstrapToken:'synthetic-bootstrap-token-32chars!'};
const PW='Synthetic-Pass-1234';
const pfx=(u:string)=>'atomic_'+u;
let app: FastifyInstance | undefined;
async function fresh(){const a=await buildApp({config:CFG,dbPath:':memory:'});await a.ready();app=a;return a;}
afterEach(async()=>{if(app){await app.close();app=undefined;}});
function dbOf(a:any){return (a.userRepo as any).db;}
function raw(a:any,s:string){dbOf(a).run(sql.raw(s));}
async function mkUser(a: any, u: string, role = 'viewer') { return a.userRepo.createUser({ username: pfx(u), email: pfx(u) + '@example.test', fullName: 'Syn User', password: PW, role }, CFG.masterKey); }
function auth(t: string) { return { authorization: 'Bearer ' + t }; }
function login(a: any, u: string) { return a.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: pfx(u), password: PW } }); }
function me(a: any, t: string) { return a.inject({ method: 'GET', url: '/api/auth/me', headers: auth(t) }); }
function mint(a: any, u: any, s: any) { return a.jwt.sign({ id: u.id, username: u.username, role: u.role, sid: s.id, exp: s.expiresAt }); }
function rowsS(a: any) { return dbOf(a).select().from(authSessions).all().map((r: any) => [r.id, r.userId, r.createdAt, r.expiresAt, r.revokedAt]).sort((x: any, y: any) => String(x[0]).localeCompare(String(y[0]))); }
function rowsA(a: any) { return dbOf(a).select().from(auditLogs).all().map((r: any) => [r.id, r.userId, r.action, r.entity, r.entityId, r.hash, r.previousHash]).sort((x: any, y: any) => String(x[0]).localeCompare(String(y[0]))); }
function snapS(a: any) { return JSON.stringify(rowsS(a)); }
function snapA(a: any) { return JSON.stringify(rowsA(a)); }
function settle(a: any, u: any, n: number) { const out: any[] = []; for (let i = 0; i < n; i++) { const s = a.sessionRepo.createSession(u.id); out.push({ s, t: mint(a, u, s) }); } return out; }
describe('auth session/audit atomicity', () => {
  it('login session insert failure returns 500 without token and leaves rows untouched; retry succeeds', async () => {
    const a = await fresh(); const u = await mkUser(a, 'login_fail', 'admin'); expect(u.id).toBeTruthy();
    const s0 = snapS(a); const a0 = snapA(a);
    raw(a, "CREATE TRIGGER fail_auth_sessions BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT,'synthetic session insert failure'); END;");
    const r = await login(a, 'login_fail');
    expect(r.statusCode).toBe(500); expect(JSON.parse(r.body).token).toBeUndefined();
    expect(r.body).not.toContain('RAISE'); expect(r.body).not.toContain('INSERT');
    expect(snapS(a)).toBe(s0); expect(snapA(a)).toBe(a0);
    raw(a, 'DROP TRIGGER IF EXISTS fail_auth_sessions');
    const r2 = await login(a, 'login_fail');
    expect(r2.statusCode).toBe(200); expect(JSON.parse(r2.body).token).toBeTruthy();
    expect(rowsS(a)).toHaveLength(1);
    expect((await a.auditRepo.verifyChainIntegrity(CFG.masterKey)).valid).toBe(true);
  });
  it('login audit failure at full session cap rolls back new row, eviction and audit count; retry succeeds with cap enforced', async () => {
    const a = await fresh(); const u = await mkUser(a, 'cap_user', 'viewer');
    const list = settle(a, u, MAX_ACTIVE_SESSIONS_PER_USER);
    expect(list).toHaveLength(MAX_ACTIVE_SESSIONS_PER_USER);
    const oldest = list[0]; const newest = list[list.length - 1];
    expect((await me(a, oldest.t)).statusCode).toBe(200);
    expect((await me(a, newest.t)).statusCode).toBe(200);
    const s0 = snapS(a); const a0 = snapA(a); const c0 = dbOf(a).select().from(auditLogs).all().length;
    raw(a, "CREATE TRIGGER fail_login_audit BEFORE INSERT ON audit_logs WHEN NEW.action='LOGIN' BEGIN SELECT RAISE(ABORT,'synthetic login audit failure'); END;");
    const r = await login(a, 'cap_user');
    expect(r.statusCode).toBe(500); expect(JSON.parse(r.body).token).toBeUndefined();
    expect(snapS(a)).toBe(s0); expect(snapA(a)).toBe(a0);
    expect(dbOf(a).select().from(auditLogs).all().length).toBe(c0);
    expect((await me(a, oldest.t)).statusCode).toBe(200);
    raw(a, 'DROP TRIGGER IF EXISTS fail_login_audit');
    const r2 = await login(a, 'cap_user');
    expect(r2.statusCode).toBe(200); expect(JSON.parse(r2.body).token).toBeTruthy();
    const rows = rowsS(a);
    expect(rows.filter((x: any) => x[4] === null).length).toBeLessThanOrEqual(MAX_ACTIVE_SESSIONS_PER_USER);
    const oldRow: any = rows.find((x: any) => x[0] === oldest.s.id);
    expect(oldRow[4]).not.toBeNull();
    expect((await me(a, oldest.t)).statusCode).toBe(401);
    expect((await me(a, newest.t)).statusCode).toBe(200);
    expect((await a.auditRepo.verifyChainIntegrity(CFG.masterKey)).valid).toBe(true);
    expect(dbOf(a).select().from(auditLogs).all().length).toBe(c0 + 1);
  });
  it('logout audit failure rolls revocation back; retry then 401', async () => {
    const a = await fresh(); const u = await mkUser(a, 'logout_fail', 'viewer');
    const r0 = await login(a, 'logout_fail'); const t0 = JSON.parse(r0.body).token;
    expect((await me(a, t0)).statusCode).toBe(200);
    const s0 = snapS(a); const a0 = snapA(a);
    raw(a, "CREATE TRIGGER fail_logout_audit BEFORE INSERT ON audit_logs WHEN NEW.action='LOGOUT' BEGIN SELECT RAISE(ABORT,'synthetic logout audit failure'); END;");
    const r = await a.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(t0) });
    expect(r.statusCode).toBe(500);
    expect((await me(a, t0)).statusCode).toBe(200);
    expect(snapS(a)).toBe(s0); expect(snapA(a)).toBe(a0);
    raw(a, 'DROP TRIGGER IF EXISTS fail_logout_audit');
    const r2 = await a.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(t0) });
    expect(r2.statusCode).toBe(200);
    expect((await me(a, t0)).statusCode).toBe(401);
    expect((await a.auditRepo.verifyChainIntegrity(CFG.masterKey)).valid).toBe(true);
  });
  it('logout-all audit failure preserves own and other user sessions; retry affects own only', async () => {
    const a = await fresh(); const u = await mkUser(a, 'la_user', 'viewer'); const o = await mkUser(a, 'la_other', 'viewer');
    const t1 = JSON.parse((await login(a, 'la_user')).body).token; const t2 = JSON.parse((await login(a, 'la_user')).body).token;
    const to = JSON.parse((await login(a, 'la_other')).body).token;
    const s0 = snapS(a); const a0 = snapA(a);
    raw(a, "CREATE TRIGGER fail_la_audit BEFORE INSERT ON audit_logs WHEN NEW.action='LOGOUT' BEGIN SELECT RAISE(ABORT,'synthetic logout-all audit failure'); END;");
    const r = await a.inject({ method: 'POST', url: '/api/auth/logout-all', headers: auth(t1) });
    expect(r.statusCode).toBe(500);
    expect((await me(a, t1)).statusCode).toBe(200);
    expect((await me(a, t2)).statusCode).toBe(200);
    expect((await me(a, to)).statusCode).toBe(200);
    expect(snapS(a)).toBe(s0); expect(snapA(a)).toBe(a0);
    raw(a, 'DROP TRIGGER IF EXISTS fail_la_audit');
    const r2 = await a.inject({ method: 'POST', url: '/api/auth/logout-all', headers: auth(t1) });
    expect(r2.statusCode).toBe(200); expect(JSON.parse(r2.body).revokedCount).toBe(2);
    expect((await me(a, t1)).statusCode).toBe(401);
    expect((await me(a, t2)).statusCode).toBe(401);
    expect((await me(a, to)).statusCode).toBe(200);
    expect((await a.auditRepo.verifyChainIntegrity(CFG.masterKey)).valid).toBe(true);
  });
  it('admin target revoke audit failure leaves both active; retry revokes target only', async () => {
    const a = await fresh(); const admin = await mkUser(a, 'adm_rev', 'admin'); const target = await mkUser(a, 'tgt_rev', 'viewer');
    const ta = JSON.parse((await login(a, 'adm_rev')).body).token; const tt = JSON.parse((await login(a, 'tgt_rev')).body).token;
    const s0 = snapS(a); const a0 = snapA(a);
    raw(a, "CREATE TRIGGER fail_rev_audit BEFORE INSERT ON audit_logs WHEN NEW.action='LOGOUT' BEGIN SELECT RAISE(ABORT,'synthetic revoke audit failure'); END;");
    const r = await a.inject({ method: 'POST', url: '/api/auth/users/' + target.id + '/revoke-sessions', headers: auth(ta) });
    expect(r.statusCode).toBe(500);
    expect((await me(a, tt)).statusCode).toBe(200);
    expect((await me(a, ta)).statusCode).toBe(200);
    expect(snapS(a)).toBe(s0); expect(snapA(a)).toBe(a0);
    raw(a, 'DROP TRIGGER IF EXISTS fail_rev_audit');
    const r2 = await a.inject({ method: 'POST', url: '/api/auth/users/' + target.id + '/revoke-sessions', headers: auth(ta) });
    expect(r2.statusCode).toBe(200); expect(JSON.parse(r2.body).revokedCount).toBe(1);
    expect((await me(a, tt)).statusCode).toBe(401);
    expect((await me(a, ta)).statusCode).toBe(200);
    expect((await a.auditRepo.verifyChainIntegrity(CFG.masterKey)).valid).toBe(true);
  });
  it('successful login, logout, logout-all and admin revoke keep a valid deterministically ordered audit chain', async () => {
    const a = await fresh(); const admin = await mkUser(a, 'chain_adm', 'admin'); const viewer = await mkUser(a, 'chain_vw', 'viewer');
    const ta = JSON.parse((await login(a, 'chain_adm')).body).token;
    const tv = JSON.parse((await login(a, 'chain_vw')).body).token;
    expect((await a.inject({ method: 'POST', url: '/api/auth/logout', headers: auth(tv) })).statusCode).toBe(200);
    const tv2 = JSON.parse((await login(a, 'chain_vw')).body).token;
    expect((await a.inject({ method: 'POST', url: '/api/auth/logout-all', headers: auth(tv2) })).statusCode).toBe(200);
    const tv3 = JSON.parse((await login(a, 'chain_vw')).body).token;
    expect((await a.inject({ method: 'POST', url: '/api/auth/users/' + viewer.id + '/revoke-sessions', headers: auth(ta) })).statusCode).toBe(200);
    const all = dbOf(a).select().from(auditLogs).orderBy(sql.raw('rowid')).all();
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all[0].previousHash).toBe('GENESIS');
    for (let i = 1; i < all.length; i++) { expect(all[i].previousHash).toBe(all[i - 1].hash); }
    const acts = all.map((r: any) => r.action);
    expect(acts.filter((x: string) => x === 'LOGIN').length).toBe(4);
    expect(acts.filter((x: string) => x === 'LOGOUT').length).toBe(3);
    const chain = await a.auditRepo.verifyChainIntegrity(CFG.masterKey);
    expect(chain.valid).toBe(true); expect(chain.count).toBe(all.length);
    expect((await me(a, ta)).statusCode).toBe(200);
    expect((await me(a, tv3)).statusCode).toBe(401);
  });
});
