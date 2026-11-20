import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { getTotpCode } from '@cost-core/crypto';

const PASSWORD = 'Synthetic-Pass-9012';
const USERNAME = 'synthetic_2fa_user';
const EMAIL = 'synthetic_2fa@example.test';

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

async function createPendingAndFullTokens(app: FastifyInstance) {
  const created = await app.userRepo.createUser({ username: USERNAME, email: EMAIL, fullName: 'Synthetic User', password: PASSWORD, role: 'admin' }, 'test-master-key-32-bytes-long-1234');
  expect(created.username).toBe(USERNAME);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: USERNAME, password: PASSWORD } });
  expect(login.statusCode).toBe(200);
  const fullToken = JSON.parse(login.body).token as string;

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/2fa/setup',
    headers: { authorization: 'Bearer ' + fullToken },
  });
  expect(setup.statusCode).toBe(200);
  const setupBody = JSON.parse(setup.body);
  const secret = setupBody.secret as string;
  expect(typeof secret).toBe('string');

  const enable = await app.inject({
    method: 'POST',
    url: '/api/auth/2fa/enable',
    headers: { authorization: 'Bearer ' + fullToken },
    payload: { secret, code: getTotpCode(secret), backupCodes: setupBody.backupCodes },
  });
  expect(enable.statusCode).toBe(200);

  const pendingLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { usernameOrEmail: USERNAME, password: PASSWORD },
  });
  expect(pendingLogin.statusCode).toBe(200);
  const pendingBody = JSON.parse(pendingLogin.body);
  expect(pendingBody.requireTwoFactor).toBe(true);
  expect(typeof pendingBody.tempToken).toBe('string');

  const fullLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { usernameOrEmail: USERNAME, password: PASSWORD, twoFactorCode: getTotpCode(secret) },
  });
  expect(fullLogin.statusCode).toBe(200);
  const verifiedToken = JSON.parse(fullLogin.body).token as string;
  expect(typeof verifiedToken).toBe('string');

  return { pendingToken: pendingBody.tempToken as string, verifiedToken };
}


describe('auth guard: reject 2FA-pending tokens on protected routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildFreshApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects the exact pending token on GET /api/projects and POST /api/categories without creating a category', async () => {
    const { pendingToken, verifiedToken } = await createPendingAndFullTokens(app);

    const projects = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: 'Bearer ' + pendingToken },
    });
    expect(projects.statusCode).toBe(401);

    const createCategory = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { authorization: 'Bearer ' + pendingToken },
      payload: { name: 'Should Not Exist' },
    });
    expect(createCategory.statusCode).toBe(401);

    const listCategories = await app.inject({
      method: 'GET',
      url: '/api/categories',
      headers: { authorization: 'Bearer ' + verifiedToken },
    });
    expect(listCategories.statusCode).toBe(200);
    const categories = JSON.parse(listCategories.body) as unknown[];
    expect(Array.isArray(categories)).toBe(true);
    expect(categories.length).toBe(0);
  });

  it('allows a valid password+TOTP full token to access protected APIs', async () => {
    const { verifiedToken } = await createPendingAndFullTokens(app);

    const projects = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: 'Bearer ' + verifiedToken },
    });
    expect(projects.statusCode).toBe(200);

    const createCategory = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { authorization: 'Bearer ' + verifiedToken },
      payload: { name: 'Synthetic Category' },
    });
    expect(createCategory.statusCode).toBe(201);
  });

  it('keeps missing token behavior as 401', async () => {
    const projects = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(projects.statusCode).toBe(401);

    const createCategory = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'No Token Category' },
    });
    expect(createCategory.statusCode).toBe(401);
  });

  it('keeps invalid token behavior as 401', async () => {
    const projects = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: 'Bearer not-a-valid-token' },
    });
    expect(projects.statusCode).toBe(401);

    const createCategory = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { authorization: 'Bearer not-a-valid-token' },
      payload: { name: 'Invalid Token Category' },
    });
    expect(createCategory.statusCode).toBe(401);
  });
});
