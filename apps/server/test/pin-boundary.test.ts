import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const PASSWORD = 'Synthetic-Pass-9012';
const ADMIN_PIN = '1111';
const VIEWER_PIN = '2222';

async function buildFreshApp() {
  const app = await buildApp({
    config: {
      jwtSecret: 'test-jwt-secret-very-long-and-secure-1234',
      masterKey: 'test-master-key-32-bytes-long-1234',
      blindIndexPepper: 'test-pepper-for-blind-index-1234',
    },
    dbPath: ':memory:',
  });
  await app.ready();
  return app;
}

async function createUserWithPin(app: FastifyInstance, username: string, role: 'admin' | 'viewer', pin: string) {
  const created = await app.userRepo.createUser(
    { username, email: username + '@example.test', fullName: 'Synthetic User', password: PASSWORD, role },
    app.config.masterKey
  );
  await app.userRepo.setUserPin(created.id, pin);
  return created;
}

async function login(app: FastifyInstance, username: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { usernameOrEmail: username, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  return body.token as string;
}

function decodeToken(app: FastifyInstance, token: string) {
  return app.jwt.decode(token) as { id: string; role: string };
}

describe('PIN boundary - switch-pin verifies only the current account', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildFreshApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('rejects a viewer presenting a correct admin PIN for another account', async () => {
    const admin = await createUserWithPin(app, 'pin_admin', 'admin', ADMIN_PIN);
    await createUserWithPin(app, 'pin_viewer', 'viewer', VIEWER_PIN);
    const token = await login(app, 'pin_viewer');
    const spy = vi.spyOn(app.userRepo, 'verifyUserPin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-pin',
      headers: { authorization: 'Bearer ' + token },
      payload: { userId: admin.id, pin: ADMIN_PIN },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.token).toBeUndefined();
    expect(body.user).toBeUndefined();
    expect(typeof body.error).toBe('string');
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an admin presenting a viewer PIN for another account', async () => {
    await createUserWithPin(app, 'pin_admin2', 'admin', ADMIN_PIN);
    const viewer = await createUserWithPin(app, 'pin_viewer2', 'viewer', VIEWER_PIN);
    const token = await login(app, 'pin_admin2');
    const spy = vi.spyOn(app.userRepo, 'verifyUserPin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-pin',
      headers: { authorization: 'Bearer ' + token },
      payload: { userId: viewer.id, pin: VIEWER_PIN },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.token).toBeUndefined();
    expect(body.user).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an unknown other user id without any PIN lookup', async () => {
    await createUserWithPin(app, 'pin_admin3', 'admin', ADMIN_PIN);
    const token = await login(app, 'pin_admin3');
    const spy = vi.spyOn(app.userRepo, 'verifyUserPin');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-pin',
      headers: { authorization: 'Bearer ' + token },
      payload: { userId: '00000000-0000-4000-8000-000000000000', pin: ADMIN_PIN },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.token).toBeUndefined();
    expect(body.user).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('unlocks the current account with its own PIN when userId is omitted', async () => {
    const admin = await createUserWithPin(app, 'pin_self_a', 'admin', ADMIN_PIN);
    const token = await login(app, 'pin_self_a');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-pin',
      headers: { authorization: 'Bearer ' + token },
      payload: { pin: ADMIN_PIN },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.id).toBe(admin.id);
    expect(body.user.role).toBe('admin');
    expect(typeof body.token).toBe('string');
    const claims = decodeToken(app, body.token);
    expect(claims.id).toBe(admin.id);
    expect(claims.role).toBe('admin');
  });

  it('unlocks the current account with its own PIN when the self id is explicit', async () => {
    const admin = await createUserWithPin(app, 'pin_self_b', 'admin', ADMIN_PIN);
    await createUserWithPin(app, 'pin_self_b_other', 'viewer', VIEWER_PIN);
    const token = await login(app, 'pin_self_b');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-pin',
      headers: { authorization: 'Bearer ' + token },
      payload: { userId: admin.id, pin: ADMIN_PIN },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.id).toBe(admin.id);
    expect(body.user.role).toBe('admin');
    const claims = decodeToken(app, body.token);
    expect(claims.id).toBe(admin.id);
    expect(claims.role).toBe('admin');
  });

  it('keeps a wrong own PIN as 401 without issuing a token', async () => {
    await createUserWithPin(app, 'pin_self_c', 'admin', ADMIN_PIN);
    const token = await login(app, 'pin_self_c');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-pin',
      headers: { authorization: 'Bearer ' + token },
      payload: { pin: '9999' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.token).toBeUndefined();
    expect(body.user).toBeUndefined();
  });
});
