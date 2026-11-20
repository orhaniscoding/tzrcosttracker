import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AuditLogRepository, auditLogs, authSessions, projectMemberships, projects, users } from '@cost-core/database';
import { buildApp } from '../src/app.js';

// Synthetic configuration and data only, in a fresh in-memory database per test.
const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
const endpoints = ['', '/verify'] as const;
type Endpoint = typeof endpoints[number];
const genericError = { error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' };
const attack = '?role=admin&userId=admin&scope=all&scope[all]=true&projectId=site2&projectIds=site2';
let app: any;
afterEach(async () => { vi.restoreAllMocks(); if (app) { await app.close(); app = undefined; } });
const get = (endpoint: Endpoint, token?: string, query = '') => app.inject({ method: 'GET', url: '/api/audit' + endpoint + query, headers: token ? { authorization: 'Bearer ' + token } : {} });
const snapshot = () => app.db.select().from(auditLogs).orderBy(auditLogs.id).all();

async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const db = app.db, now = new Date().toISOString();
  for (const id of ['site1', 'site2']) db.insert(projects).values({ id, name: id, budget: 0, currency: 'TRY', status: 'active', createdAt: now, updatedAt: now }).run();
  const tokens: Record<string, string> = {}, sessions: Record<string, any> = {};
  for (const id of ['admin', 'manager', 'accountant', 'auditor', 'viewer', 'unassigned-auditor']) {
    const role = id === 'unassigned-auditor' ? 'auditor' : id;
    db.insert(users).values({ id, username: id, email: id + '@example.test', fullName: 'Synthetic', passwordHash: 'synthetic-hash', role, isActive: true, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(id); sessions[id] = session;
    tokens[id] = app.jwt.sign({ id, username: id, role, sid: session.id, exp: session.expiresAt });
    if (id !== 'admin' && id !== 'unassigned-auditor') db.insert(projectMemberships).values({ userId: id, projectId: 'site1', createdAt: now }).run();
  }
  function log(index: number, projectId: string | null) {
    return app.auditRepo.logAction({ userId: 'admin', action: 'CREATE', entity: 'transaction', entityId: 'synthetic-entity-' + index, previousState: null, newState: { projectId, title: 'Synthetic sensitive title ' + index, amount: 700 + index, person: 'Synthetic private person ' + index } }, config.masterKey);
  }
  const logs = [log(0, 'site1'), log(1, 'site2'), log(2, null)];
  return { db, tokens, sessions, logs, log };
}

function readSpies() {
  return {
    list: vi.spyOn(AuditLogRepository.prototype, 'listAuditLogs'),
    verify: vi.spyOn(AuditLogRepository.prototype, 'verifyChainIntegrity'),
  };
}
function expectNoRead(spies: ReturnType<typeof readSpies>) {
  expect(spies.list).not.toHaveBeenCalled(); expect(spies.verify).not.toHaveBeenCalled();
}
function expectDenied(response: any, status: number) {
  expect(response.statusCode).toBe(status);
  const body = JSON.parse(response.body);
  if (status === 401) expect(body.code).toBe('SESSION_INVALID');
  if (status === 403) expect(body).toEqual({ error: 'Yasak.' });
  for (const field of ['totalRecordsVerified', 'corruptedAtId', 'previousState', 'newState', 'hash']) expect(body).not.toHaveProperty(field);
  for (const text of ['Synthetic sensitive', 'Synthetic private', 'synthetic-entity', 'enc:v1']) expect(response.body).not.toContain(text);
}

// Deterministic auth -> transaction boundary hook, before the real fresh check.
// The hook's synthetic mutation rolls back when the route denies access.
async function duringFresh(mutate: (tx: any, uid: string, sid: string, expiry: number) => void, run: () => Promise<any>) {
  const original = app.projectAccess.requireFreshAdmin;
  let calls = 0;
  app.projectAccess.requireFreshAdmin = function (tx: any, uid: string, sid: string, expiry: number) {
    calls++; expect(tx).not.toBe(app.db); expect(uid).toBe('admin');
    mutate(tx, uid, sid, expiry);
    return original.call(this, tx, uid, sid, expiry);
  };
  try { const response = await run(); expect(calls).toBe(1); return response; }
  finally { app.projectAccess.requireFreshAdmin = original; }
}

describe('global audit HTTP admin boundary', () => {
  it.each(endpoints)('%s denies every non-admin before any global repository read, with or without project assignment', async endpoint => {
    const s = await setup(), before = snapshot(), spies = readSpies();
    for (const role of ['manager', 'accountant', 'auditor', 'viewer', 'unassigned-auditor']) {
      for (const query of ['', attack, attack + '&limit=', '?limit=1&limit=2']) expectDenied(await get(endpoint, s.tokens[role], query), 403);
    }
    expectNoRead(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s denies unauthenticated and invalid tokens before global reads', async endpoint => {
    await setup(); const before = snapshot(), spies = readSpies();
    expectDenied(await get(endpoint), 401); expectDenied(await get(endpoint, 'not-a-token', attack), 401);
    expectNoRead(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s ignores a signed stale role claim and applies same-token admin role revocation', async endpoint => {
    const s = await setup();
    expect((await get(endpoint, s.tokens.admin)).statusCode).toBe(200);
    s.db.update(users).set({ role: 'auditor' }).where(eq(users.id, 'admin')).run();
    s.db.insert(projectMemberships).values({ userId: 'admin', projectId: 'site2', createdAt: new Date().toISOString() }).run();
    const before = snapshot(), spies = readSpies();
    expectDenied(await get(endpoint, s.tokens.admin, attack), 403);
    // Even an admin claim signed by the test harness cannot confer admin access.
    const forgedRole = app.jwt.sign({ id: 'viewer', username: 'viewer', role: 'admin', sid: s.sessions.viewer.id, exp: s.sessions.viewer.expiresAt });
    expectDenied(await get(endpoint, forgedRole, attack), 403);
    expectNoRead(spies); expect(snapshot()).toEqual(before);
  });

  it('preserves the admin list payload, newest-inserted order, decrypted cross-project and legacy state', async () => {
    const s = await setup(), before = snapshot();
    const response = await get('', s.tokens.admin, attack);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([...s.logs].reverse());
    expect(JSON.parse(response.body).map((r: any) => r.newState.projectId)).toEqual([null, 'site2', 'site1']);
    expect(snapshot()).toEqual(before);
  });

  it('defaults to 100 and accepts explicit decimal limits at 1 and 500 without reordering', async () => {
    const s = await setup();
    for (let i = 3; i < 103; i++) s.logs.push(s.log(i, i % 2 ? 'site1' : 'site2'));
    const before = snapshot(), spies = readSpies(), newest = [...s.logs].reverse();
    for (const [query, count, limit] of [['', 100, 100], ['?limit=1', 1, 1], ['?limit=2', 2, 2], ['?limit=001', 1, 1], ['?limit=500', 103, 500]] as const) {
      const response = await get('', s.tokens.admin, query);
      expect(response.statusCode).toBe(200); expect(JSON.parse(response.body)).toEqual(newest.slice(0, count));
      expect(spies.list).toHaveBeenLastCalledWith(limit, config.masterKey);
    }
    expect(spies.verify).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
  });

  it.each(['', '0', '-1', '1.0', '1.5', '1e2', 'NaN', 'Infinity', 'abc', '12abc', '501', '9999999999999999999999', '%201', '1%20', '1%0A', '1%0D', '%2B1', '1&limit=1', '1&limit=2'])('rejects invalid admin list limit "%s" before the repository read', async limit => {
    const s = await setup(), before = snapshot(), spies = readSpies();
    const response = await get('', s.tokens.admin, '?limit=' + limit);
    expect(response.statusCode).toBe(400); expect(JSON.parse(response.body)).toEqual({ error: 'Geçersiz denetim kaydı limiti.' });
    expectNoRead(spies); expect(snapshot()).toEqual(before);
  });

  it('preserves verification shape for valid and corrupt stored audit chains without claiming full database integrity', async () => {
    const s = await setup(), before = snapshot();
    const valid = await get('/verify', s.tokens.admin, attack);
    expect(valid.statusCode).toBe(200);
    expect(JSON.parse(valid.body)).toEqual({ verified: true, totalRecordsVerified: 3, corruptedAtId: null, message: 'Saklanan denetim zincirinin bağlantıları ve hash kapsamındaki denetim verileri doğrulandı; uygulama tablolarının tamamı doğrulanmaz.' });
    expect(snapshot()).toEqual(before);
    s.db.update(auditLogs).set({ hash: 'synthetic-corrupt-hash' }).where(eq(auditLogs.id, s.logs[1].id)).run();
    const corruptBefore = snapshot(), corrupt = await get('/verify', s.tokens.admin);
    expect(corrupt.statusCode).toBe(200);
    expect(JSON.parse(corrupt.body)).toEqual({ verified: false, totalRecordsVerified: 3, corruptedAtId: s.logs[1].id, message: 'Saklanan denetim zincirinin bağlantılarında veya hash kapsamındaki denetim verilerinde tutarsızlık tespit edildi.' });
    expect(snapshot()).toEqual(corruptBefore);
  });

  it.each(endpoints)('%s denies non-admin even when the global sensitive ciphertext is corrupt', async endpoint => {
    const s = await setup();
    s.db.update(auditLogs).set({ diffEncrypted: 'enc:v1:corrupt' }).where(eq(auditLogs.id, s.logs[1].id)).run();
    const before = snapshot(), spies = readSpies();
    expectDenied(await get(endpoint, s.tokens.auditor, attack), 403);
    expectDenied(await get(endpoint, s.tokens['unassigned-auditor']), 403);
    expectNoRead(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s rechecks an auth-to-transaction downgrade before reading audit data', async endpoint => {
    const s = await setup(), before = snapshot(), spies = readSpies();
    const response = await duringFresh((tx, uid) => { tx.update(users).set({ role: 'viewer' }).where(eq(users.id, uid)).run(); }, () => get(endpoint, s.tokens.admin, '?limit='));
    expectDenied(response, 403); expectNoRead(spies); expect(snapshot()).toEqual(before);
  });

  for (const state of ['revoked', 'inactive', 'invalid-role', 'missing-session', 'changed-expiry'] as const) {
    it.each(endpoints)(`%s rejects ${state} after authentication before audit reads`, async endpoint => {
      const s = await setup(), before = snapshot(), spies = readSpies();
      const response = await duringFresh((tx, uid, sid, expiry) => {
        if (state === 'revoked') tx.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, sid)).run();
        if (state === 'inactive') tx.update(users).set({ isActive: false }).where(eq(users.id, uid)).run();
        if (state === 'invalid-role') tx.update(users).set({ role: 'invalid' }).where(eq(users.id, uid)).run();
        if (state === 'missing-session') tx.delete(authSessions).where(eq(authSessions.id, sid)).run();
        if (state === 'changed-expiry') tx.update(authSessions).set({ expiresAt: expiry + 1 }).where(eq(authSessions.id, sid)).run();
      }, () => get(endpoint, s.tokens.admin));
      expectDenied(response, 401); expectNoRead(spies); expect(snapshot()).toEqual(before);
    });
  }

  for (const secondsPastExpiry of [0, 1]) {
    it.each(endpoints)(`%s rejects session expiry at boundary +${secondsPastExpiry}s after authentication`, async endpoint => {
      const s = await setup(), before = snapshot(), spies = readSpies();
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const response = await duringFresh((_tx, _uid, _sid, expiry) => {
          expect(expiry).toBe(s.sessions.admin.expiresAt);
          clock = vi.spyOn(Date, 'now').mockReturnValue((expiry + secondsPastExpiry) * 1000);
        }, () => get(endpoint, s.tokens.admin));
        expectDenied(response, 401); expectNoRead(spies); expect(snapshot()).toEqual(before);
      } finally { clock?.mockRestore(); }
    });
  }

  it.each(endpoints)('%s rejects a revoked session on the next request before global reads', async endpoint => {
    const s = await setup();
    s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, s.sessions.admin.id)).run();
    const before = snapshot(), spies = readSpies();
    expectDenied(await get(endpoint, s.tokens.admin), 401); expectNoRead(spies); expect(snapshot()).toEqual(before);
  });

  it('fresh-checks admin and reads with a repository bound to the identical synchronous transaction', async () => {
    const s = await setup(), before = snapshot();
    const originalTransaction = s.db.transaction, originalFresh = app.projectAccess.requireFreshAdmin;
    const originalList = AuditLogRepository.prototype.listAuditLogs, originalVerify = AuditLogRepository.prototype.verifyChainIntegrity;
    let currentTx: any; const order: string[] = [];
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => originalTransaction.call(s.db, (tx: any) => {
      expect(currentTx).toBeUndefined(); currentTx = tx;
      try { const result = callback(tx); expect(result).not.toBeInstanceOf(Promise); return result; }
      finally { currentTx = undefined; }
    }, ...args));
    app.projectAccess.requireFreshAdmin = function (tx: any, ...args: any[]) {
      expect(tx).toBe(currentTx); expect(tx).not.toBe(s.db);
      const role = originalFresh.call(this, tx, ...args); order.push('fresh-admin'); return role;
    };
    vi.spyOn(AuditLogRepository.prototype, 'listAuditLogs').mockImplementation(function (this: any, ...args) {
      expect(this.db).toBe(currentTx); expect(order).toEqual(['fresh-admin']); order.push('list'); return originalList.apply(this, args);
    });
    vi.spyOn(AuditLogRepository.prototype, 'verifyChainIntegrity').mockImplementation(function (this: any, ...args) {
      expect(this.db).toBe(currentTx); expect(order).toEqual(['fresh-admin']); order.push('verify'); return originalVerify.apply(this, args);
    });
    try {
      for (const endpoint of endpoints) {
        order.length = 0; expect((await get(endpoint, s.tokens.admin)).statusCode).toBe(200);
        expect(order).toEqual(['fresh-admin', endpoint === '' ? 'list' : 'verify']);
      }
      expect(snapshot()).toEqual(before);
    } finally { app.projectAccess.requireFreshAdmin = originalFresh; }
  });

  it.each(endpoints)('%s returns a generic 500 without sensitive exception reflection or audit mutation', async endpoint => {
    const s = await setup(), before = snapshot();
    vi.spyOn(AuditLogRepository.prototype, endpoint === '' ? 'listAuditLogs' : 'verifyChainIntegrity').mockImplementation(() => { throw new Error('Synthetic private person / enc:v1:synthetic-payload'); });
    const response = await get(endpoint, s.tokens.admin);
    expect(response.statusCode).toBe(500); expect(JSON.parse(response.body)).toEqual(genericError);
    expect(response.body).not.toContain('Synthetic private'); expect(response.body).not.toContain('enc:v1'); expect(snapshot()).toEqual(before);
  });
});
