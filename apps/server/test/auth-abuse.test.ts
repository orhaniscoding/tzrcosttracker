import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { getTotpCode } from '@cost-core/crypto';

const PASSWORD = 'Synthetic-Pass-9012';
const CFG = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234' };

async function buildFreshApp() { const app = await buildApp({ config: CFG, dbPath: ':memory:' }); await app.ready(); return app; }
async function createUser(app: FastifyInstance, username: string, role: string = 'admin', pin?: string) { const created = await app.userRepo.createUser({ username, email: username + '@example.test', fullName: 'Synthetic User', password: PASSWORD, role: role as any }, app.config.masterKey); if (pin) { await app.userRepo.setUserPin(created.id, pin); } return created; }
function loginRaw(app: FastifyInstance, usernameOrEmail: string, password: string = PASSWORD, ip?: string, extra: Record<string, unknown> = {}) { const opts: any = { method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail, password, ...extra } }; if (ip) { opts.remoteAddress = ip; } return app.inject(opts); }
async function loginToken(app: FastifyInstance, username: string) { const res = await loginRaw(app, username); expect(res.statusCode).toBe(200); return JSON.parse(res.body).token as string; }
function auth(token: string) { return { authorization: 'Bearer ' + token }; }

describe('auth abuse controls', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildFreshApp(); });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); });

  it('login: five bad attempts 401 then 429 with Retry-After and no token', async () => {
    await createUser(app, 'abuse_victim');
    for (let i = 0; i < 5; i++) { const r = await loginRaw(app, 'abuse_victim', 'wrong-pass-'); expect(r.statusCode).toBe(401); expect(JSON.parse(r.body).token).toBeUndefined(); }
    const blocked = await loginRaw(app, 'abuse_victim', 'wrong-pass-'); expect(blocked.statusCode).toBe(429); expect(blocked.headers['retry-after']).toBeDefined(); expect(JSON.parse(blocked.body).token).toBeUndefined();
  });

  it('login: same normalized identifier across different IPs cannot bypass', async () => {
    await createUser(app, 'cross_ip_user');
    for (let i = 0; i < 5; i++) { const r = await loginRaw(app, '  Cross_IP_User ', 'bad-', '10.0.0.' + (i + 1)); expect(r.statusCode).toBe(401); }
    const blocked = await loginRaw(app, 'cross_ip_user', 'bad-', '10.9.9.9'); expect(blocked.statusCode).toBe(429); expect(JSON.parse(blocked.body).token).toBeUndefined();
    const alsoBlocked = await loginRaw(app, 'CROSS_IP_USER@EXAMPLE.TEST', 'bad-', '10.8.8.8'); expect(alsoBlocked.statusCode).toBe(429);
  });

  it('login: different legitimate user is not blocked by another per-account bucket', async () => {
    await createUser(app, 'blocked_user'); await createUser(app, 'other_user');
    for (let i = 0; i < 5; i++) { expect((await loginRaw(app, 'blocked_user', 'bad-')).statusCode).toBe(401); }
    expect((await loginRaw(app, 'blocked_user', 'bad-')).statusCode).toBe(429);
    const ok = await loginRaw(app, 'other_user'); expect(ok.statusCode).toBe(200); expect(typeof JSON.parse(ok.body).token).toBe('string');
  });

  it('login: bounded-window recovery with a controlled clock, no sleep', async () => {
    await createUser(app, 'recovery_user');
    const realNow = Date.now; const base = realNow(); let nowMs = base; vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    try {
      for (let i = 0; i < 5; i++) { expect((await loginRaw(app, 'recovery_user', 'bad-')).statusCode).toBe(401); }
      expect((await loginRaw(app, 'recovery_user', 'bad-')).statusCode).toBe(429);
      nowMs = base + 61000;
      const ok = await loginRaw(app, 'recovery_user'); expect(ok.statusCode).toBe(200); expect(typeof JSON.parse(ok.body).token).toBe('string');
    } finally { vi.restoreAllMocks(); }
  });

  it('login: correct password and TOTP remains allowed below limits', async () => {
    await createUser(app, 'totp_user'); const token = await loginToken(app, 'totp_user');
    const setup = await app.inject({ method: 'POST', url: '/api/auth/2fa/setup', headers: auth(token) }); expect(setup.statusCode).toBe(200); const setupBody = JSON.parse(setup.body);
    const enable = await app.inject({ method: 'POST', url: '/api/auth/2fa/enable', headers: auth(token), payload: { secret: setupBody.secret, code: getTotpCode(setupBody.secret), backupCodes: setupBody.backupCodes } }); expect(enable.statusCode).toBe(200);
    const pending = await loginRaw(app, 'totp_user'); expect(pending.statusCode).toBe(200); expect(JSON.parse(pending.body).requireTwoFactor).toBe(true);
    const full = await loginRaw(app, 'totp_user', PASSWORD, undefined, { twoFactorCode: getTotpCode(setupBody.secret) }); expect(full.statusCode).toBe(200); expect(typeof JSON.parse(full.body).token).toBe('string');
  });

  it('login: malformed bodies are safe', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} }); expect([400, 429].includes(r1.statusCode)).toBe(true);
    const r2 = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: 42, password: true } as any }); expect([400, 429].includes(r2.statusCode)).toBe(true);
  });

  it('pin: own wrong five then 429, other user isolated, cross-account 403, no token after limit', async () => {
    const alice = await createUser(app, 'pin_alice', 'admin', '1111'); const bob = await createUser(app, 'pin_bob', 'admin', '2222');
    const tA = await loginToken(app, 'pin_alice'); const tB = await loginToken(app, 'pin_bob');
    const cross = await app.inject({ method: 'POST', url: '/api/auth/switch-pin', headers: auth(tA), payload: { userId: bob.id, pin: '2222' } }); expect(cross.statusCode).toBe(403); expect(JSON.parse(cross.body).token).toBeUndefined();
    for (let i = 0; i < 4; i++) { const r = await app.inject({ method: 'POST', url: '/api/auth/switch-pin', headers: auth(tA), payload: { pin: '9999' } }); expect(r.statusCode).toBe(401); }
    const limited = await app.inject({ method: 'POST', url: '/api/auth/switch-pin', headers: auth(tA), payload: { pin: '9999' } }); expect(limited.statusCode).toBe(429); expect(limited.headers['retry-after']).toBeDefined(); expect(JSON.parse(limited.body).token).toBeUndefined();
    const other = await app.inject({ method: 'POST', url: '/api/auth/switch-pin', headers: auth(tB), payload: { pin: '2222' } }); expect(other.statusCode).toBe(200); expect(JSON.parse(other.body).user.id).toBe(bob.id);
    const cross2 = await app.inject({ method: 'POST', url: '/api/auth/switch-pin', headers: auth(tB), payload: { userId: alice.id, pin: '1111' } }); expect(cross2.statusCode).toBe(403);
  });

  it('users: non-admin 403 before lookup with no PII, admin 200, own /me 200', async () => {
    await createUser(app, 'dir_admin', 'admin'); await createUser(app, 'dir_manager', 'manager'); await createUser(app, 'dir_accountant', 'accountant'); await createUser(app, 'dir_viewer', 'viewer'); await createUser(app, 'dir_auditor', 'auditor');
    const spy = vi.spyOn(app.userRepo, 'listUsers');
    for (const u of ['dir_manager', 'dir_accountant', 'dir_viewer', 'dir_auditor']) { const t = await loginToken(app, u); const r = await app.inject({ method: 'GET', url: '/api/auth/users', headers: auth(t) }); expect(r.statusCode).toBe(403); expect(r.body).not.toContain('@example.test'); expect(r.body).not.toContain('passwordHash'); const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(t) }); expect(me.statusCode).toBe(200); expect(JSON.parse(me.body).username).toBe(u); }
    expect(spy).not.toHaveBeenCalled();
    const adminToken = await loginToken(app, 'dir_admin'); const list = await app.inject({ method: 'GET', url: '/api/auth/users', headers: auth(adminToken) }); expect(list.statusCode).toBe(200); expect(Array.isArray(JSON.parse(list.body))).toBe(true); const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(adminToken) }); expect(me.statusCode).toBe(200);
  });

  it('cors: forged Origin not reflected, same-origin paths still work', async () => {
    await createUser(app, 'cors_user'); const token = await loginToken(app, 'cors_user');
    const forged = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...auth(token), origin: 'https://evil.example' } }); expect(forged.statusCode).toBe(200); expect(forged.headers['access-control-allow-origin']).not.toBe('https://evil.example'); expect(forged.headers['access-control-allow-credentials']).not.toBe('true');
    const pre = await app.inject({ method: 'OPTIONS', url: '/api/auth/login', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }); expect(pre.headers['access-control-allow-origin']).not.toBe('https://evil.example');
    const sameOrigin = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token) }); expect(sameOrigin.statusCode).toBe(200);
  });

  it('errors: synthetic internal exception returns sanitized 500 without marker or stack', async () => {
    await createUser(app, 'err_user'); const token = await loginToken(app, 'err_user');
    const marker = 'SYNTH_INTERNAL_MARKER_SECRET_SQL_PATH'; vi.spyOn(app.userRepo, 'getUserById').mockRejectedValue(new Error(marker));
    const r = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token) }); expect(r.statusCode).toBe(500); expect(r.body).not.toContain(marker); expect(r.body).not.toContain('Error:'); expect(r.body).not.toContain('node_modules'); expect(JSON.parse(r.body).error).toBeTruthy();
    const nf = await app.inject({ method: 'GET', url: '/api/auth/no-such-route', headers: auth(token) }); expect(nf.statusCode).toBe(404);
  });
});

