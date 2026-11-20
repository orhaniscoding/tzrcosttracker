import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { accounts, auditLogs, authSessions, projectMemberships, transactions, users } from '@cost-core/database';
import { buildApp } from '../src/app.js';

const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
let app: any;
afterEach(async () => { if (app) { await app.close(); app = undefined; } });
const headers = (token: string) => ({ authorization: 'Bearer ' + token });
const post = (token: string, payload: any) => app.inject({ method: 'POST', url: '/api/transactions', headers: headers(token), payload });
const missing = '00000000-0000-4000-8000-000000000000';

async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const db = app.db, now = new Date().toISOString();
  const p1 = await app.projectRepo.createProject({ name: 'Synthetic one' });
  const p2 = await app.projectRepo.createProject({ name: 'Synthetic two' });
  const category = await app.categoryRepo.createCategory({ name: 'Synthetic category' });
  const tokens: Record<string, string> = {};
  for (const role of ['admin', 'manager', 'accountant', 'viewer', 'auditor', 'free']) {
    const actual = role === 'free' ? 'manager' : role;
    db.insert(users).values({ id: role, username: role, email: role + '@example.test', fullName: 'Synthetic', passwordHash: 'synthetic-hash', role: actual, isActive: true, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(role);
    tokens[role] = app.jwt.sign({ id: role, username: role, role: actual, sid: session.id, exp: session.expiresAt });
    if (role !== 'admin' && role !== 'free') db.insert(projectMemberships).values({ userId: role, projectId: p1.id, createdAt: now }).run();
  }
  const wallet = (projectId: string | null, name: string) => app.accountRepo.createAccount({ name, type: 'cash', currency: 'TRY', initialBalance: 1000, projectId }, config.masterKey, config.blindIndexPepper);
  const w1 = wallet(p1.id, 'One'), w2 = wallet(p2.id, 'Two'), legacy = wallet(null, 'Legacy');
  const input = { projectId: p1.id, type: 'expense', date: '2026-10-01T10:00:00.000Z', amount: 100, currency: 'TRY', categoryId: category.id, title: 'Synthetic expense', accountFromId: w1.id, isPaid: true };
  const snapshot = () => JSON.stringify([db.select().from(accounts).all(), db.select().from(transactions).all(), db.select().from(auditLogs).all()]);
  return { db, p1, p2, w1, w2, legacy, input, tokens, snapshot };
}

describe('transaction CREATE authorization', () => {
  it('applies a keyed expense once and rejects reusing the key for different content', async () => {
    const s = await setup();
    const key = '2a9a2c7f-f56f-46ed-9ae6-92aa6647c212';
    const submit = (payload: typeof s.input) => app.inject({
      method: 'POST', url: '/api/transactions', headers: { ...headers(s.tokens.manager), 'idempotency-key': key }, payload,
    });
    const first = await submit(s.input);
    expect(first.statusCode).toBe(201);
    const created = JSON.parse(first.body).transaction;
    const committed = s.snapshot();
    const retry = await submit(s.input);
    expect(retry.statusCode).toBe(201);
    expect(JSON.parse(retry.body).transaction.id).toBe(created.id);
    expect(s.snapshot()).toBe(committed);
    expect(app.accountRepo.getAccountById(s.w1.id, config.masterKey).balance).toBe(900);
    expect((await submit({ ...s.input, amount: 101 })).statusCode).toBe(409);
    expect(s.snapshot()).toBe(committed);
  });

  it('applies a concurrent ordinary keyed expense exactly once', async () => {
    const s = await setup();
    const key = '31c4ad72-7d7e-4ef5-8e36-cda6da4cae91';
    const submit = () => app.inject({
      method: 'POST', url: '/api/transactions', payload: s.input,
      headers: { ...headers(s.tokens.manager), 'idempotency-key': key },
    });
    const [first, second] = await Promise.all([submit(), submit()]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json()).toEqual(second.json());
    expect(s.db.select().from(transactions).all()).toHaveLength(1);
    expect(s.db.select().from(auditLogs).all()).toHaveLength(1);
    expect(app.accountRepo.getAccountById(s.w1.id, config.masterKey).balance).toBe(900);
  });

  it('treats reordered attachments as a different keyed request', async () => {
    const s = await setup();
    const submit = (attachments: string[]) => app.inject({
      method: 'POST', url: '/api/transactions',
      headers: { ...headers(s.tokens.manager), 'idempotency-key': '229bac55-9302-4d44-aa2b-d8607ce8e99a' },
      payload: { ...s.input, attachments },
    });
    const attachments = ['synthetic-first.pdf', 'synthetic-second.pdf'];
    expect((await submit(attachments)).statusCode).toBe(201);
    const committed = s.snapshot();
    expect((await submit([...attachments].reverse())).statusCode).toBe(409);
    expect(s.snapshot()).toBe(committed);
  });

  it('replays an admin legacy transaction whose project is null', async () => {
    const s = await setup();
    const payload = { ...s.input, projectId: null, accountFromId: s.legacy.id };
    const submit = () => app.inject({ method: 'POST', url: '/api/transactions', payload, headers: { ...headers(s.tokens.admin), 'idempotency-key': '8db4e8e4-0b39-4e46-8a36-8a9f5ad89e2a' } });
    const first = await submit();
    expect(first.statusCode).toBe(201);
    const second = await submit();
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(s.db.select().from(transactions).all()).toHaveLength(1);
    expect(app.accountRepo.getAccountById(s.legacy.id, config.masterKey).balance).toBe(900);
  });
  it('checks current project membership before reporting a key conflict', async () => {
    const s = await setup();
    const submit = (payload: typeof s.input) => app.inject({
      method: 'POST', url: '/api/transactions', payload,
      headers: { ...headers(s.tokens.manager), 'idempotency-key': '870d65ef-a761-4611-a66b-c112dd956df3' },
    });
    expect((await submit(s.input)).statusCode).toBe(201);
    s.db.delete(projectMemberships).where(eq(projectMemberships.userId, 'manager')).run();
    const before = s.snapshot();
    expect((await submit(s.input)).statusCode).toBe(404);
    expect((await submit({ ...s.input, amount: 101 })).statusCode).toBe(404);
    expect(s.snapshot()).toBe(before);
  });

  it('returns the same expense after the wallet is deactivated and keeps the receipt private', async () => {
    const s = await setup();
    const submit = () => app.inject({
      method: 'POST', url: '/api/transactions', payload: s.input,
      headers: { ...headers(s.tokens.manager), 'idempotency-key': '27215cbe-6122-4a8a-ace9-c8cfcbe25fd4' },
    });
    const first = await submit();
    expect(first.statusCode).toBe(201);
    s.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, s.w1.id)).run();
    const before = s.snapshot();
    const replay = await submit();
    expect(replay.statusCode).toBe(201);
    expect(JSON.parse(replay.body)).toEqual(JSON.parse(first.body));
    expect(s.snapshot()).toBe(before);
    const [entry] = app.auditRepo.listAuditLogs(10, config.masterKey);
    expect(entry.newState.id).toBe(JSON.parse(first.body).transaction.id);
    expect(entry.newState).not.toHaveProperty('_creationReceipt');
    const response = await app.inject({ method: 'GET', url: '/api/audit', headers: headers(s.tokens.admin) });
    expect(response.statusCode).toBe(200);
    expect(response.json()[0].newState.id).toBe(entry.newState.id);
    for (const field of ['_creationReceipt', 'nonce', 'fingerprint', 'diffEncrypted']) {
      expect(response.body).not.toContain(`"${field}"`);
    }
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('rejects malformed, UUID v1, and unsupported UUID variant request keys without side effects', async () => {
    const s = await setup(), before = s.snapshot();
    for (const key of ['invalid', '2a9a2c7f-f56f-16ed-9ae6-92aa6647c212', '2a9a2c7f-f56f-46ed-7ae6-92aa6647c212']) {
      const response = await app.inject({
        method: 'POST', url: '/api/transactions', payload: s.input,
        headers: { ...headers(s.tokens.manager), 'idempotency-key': key },
      });
      expect(response.statusCode).toBe(400);
      expect(s.snapshot()).toBe(before);
    }
  });

  it('replays an Oto-Kasa pair as public DTOs with stable JSON key ordering and no extra rows', async () => {
    const s = await setup();
    const payload = { ...s.input, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic payer', customValues: { b: 'second', a: 'first' } };
    const submit = (input: typeof payload, token = s.tokens.manager, idempotencyKey = '09d27fc1-07ff-4a56-82ae-fb4d07317adf') => app.inject({
      method: 'POST', url: '/api/transactions', payload: input,
      headers: { ...headers(token), 'idempotency-key': idempotencyKey },
    });
    const [first, second] = await Promise.all([submit(payload), submit({ ...payload, customValues: { a: 'first', b: 'second' } })]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const result = JSON.parse(first.body);
    expect(JSON.parse(second.body)).toEqual(result);
    expect(result.otoKasaTransaction.otoKasaTransactionId).toBe(result.transaction.id);
    expect(result.otoKasaTransaction).not.toHaveProperty('titleEncrypted');
    expect(result.otoKasaTransaction).not.toHaveProperty('titleBlindIndex');
    expect(s.db.select().from(transactions).all()).toHaveLength(2);
    expect(s.db.select().from(auditLogs).all()).toHaveLength(1);
    expect(app.accountRepo.getAccountById(s.w1.id, config.masterKey).balance).toBe(1000);
    const otherActor = await submit(payload, s.tokens.accountant);
    expect(otherActor.statusCode).toBe(201);
    expect(JSON.parse(otherActor.body).transaction.id).not.toBe(result.transaction.id);
  });

  it('releases a keyed expense after a rolled-back audit insert', async () => {
    const s = await setup(), before = s.snapshot();
    const submit = () => app.inject({
      method: 'POST', url: '/api/transactions', payload: s.input,
      headers: { ...headers(s.tokens.manager), 'idempotency-key': '50a979fd-ecad-448f-bb7d-3837a5d9dc4b' },
    });
    s.db.run(sql.raw("CREATE TRIGGER fail_keyed_audit BEFORE INSERT ON audit_logs WHEN NEW.entity='transaction' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;"));
    expect((await submit()).statusCode).toBe(500);
    expect(s.snapshot()).toBe(before);
    s.db.run(sql.raw('DROP TRIGGER fail_keyed_audit'));
    const first = await submit();
    expect(first.statusCode).toBe(201);
    expect(JSON.parse((await submit()).body)).toEqual(JSON.parse(first.body));
    expect(s.db.select().from(auditLogs).all()).toHaveLength(1);
    expect(app.accountRepo.getAccountById(s.w1.id, config.masterKey).balance).toBe(900);
  });

  it('permits admin legacy and assigned manager/accountant with matching wallet and atomic Oto pair', async () => {
    const s = await setup();
    for (const role of ['manager', 'accountant']) {
      const r = await post(s.tokens[role], s.input);
      expect(r.statusCode).toBe(201);
      expect(JSON.parse(r.body).transaction.projectId).toBe(s.p1.id);
    }
    expect(app.accountRepo.getAccountById(s.w1.id, config.masterKey).balance).toBe(800);
    const income = await post(s.tokens.manager, { ...s.input, type: 'income', accountFromId: null, accountToId: s.w1.id });
    expect(income.statusCode).toBe(201);
    expect(app.accountRepo.getAccountById(s.w1.id, config.masterKey).balance).toBe(900);
    const legacy = await post(s.tokens.admin, { ...s.input, projectId: null, accountFromId: s.legacy.id });
    expect(legacy.statusCode).toBe(201);
    const adminCrossProject = await post(s.tokens.admin, { ...s.input, accountFromId: s.w2.id });
    expect(adminCrossProject.statusCode).toBe(201);
    const oto = await post(s.tokens.manager, { ...s.input, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic payer', accountFromId: s.w2.id, accountToId: s.legacy.id });
    expect(oto.statusCode).toBe(201);
    const body = JSON.parse(oto.body);
    expect(body.transaction.projectId).toBe(s.p1.id);
    expect(body.otoKasaTransaction.projectId).toBe(s.p1.id);
    expect(body.transaction.otoKasaTransactionId).toBe(body.otoKasaTransaction.id);
    expect(body.transaction.accountFromId).toBeNull(); expect(body.transaction.accountToId).toBeNull();
    expect(app.accountRepo.getAccountById(s.w2.id, config.masterKey).balance).toBe(900);
    expect(app.accountRepo.getAccountById(s.legacy.id, config.masterKey).balance).toBe(900);
  });

  it('rejects a member from using a foreign project wallet even when both projects exist', async () => {
    const s = await setup();
    const before = s.snapshot();
    const response = await post(s.tokens.manager, { ...s.input, accountFromId: s.w2.id });
    expect(response.statusCode).toBe(404);
    expect(s.snapshot()).toBe(before);
  });
  it('denies unassigned, foreign, missing, malformed, null and read-only without effects', async () => {
    const s = await setup(), before = s.snapshot();
    for (const role of ['viewer', 'auditor']) expect((await post(s.tokens[role], s.input)).statusCode).toBe(403);
    for (const projectId of [null, undefined]) expect((await post(s.tokens.manager, { ...s.input, projectId })).statusCode).toBe(403);
    for (const projectId of [s.p2.id, missing]) expect((await post(s.tokens.manager, { ...s.input, projectId })).statusCode).toBe(404);
    expect((await post(s.tokens.free, s.input)).statusCode).toBe(404);
    for (const projectId of ['', 'bad', 123, []]) expect((await post(s.tokens.manager, { ...s.input, projectId })).statusCode).toBe(400);
    expect((await post(s.tokens.admin, { ...s.input, projectId: missing })).statusCode).toBe(404);
    expect((await post(s.tokens.manager, { ...s.input, accountFromId: 'bad' })).statusCode).toBe(400);
    expect(s.snapshot()).toBe(before);
  });

  it('checks wallet in SQL by the transaction project before decrypting, even with two memberships', async () => {
    const s = await setup();
    s.db.insert(projectMemberships).values({ userId: 'manager', projectId: s.p2.id, createdAt: new Date().toISOString() }).run();
    s.db.update(accounts).set({ balanceEncrypted: 'enc:v1:corrupt' }).where(eq(accounts.id, s.w2.id)).run();
    const before = s.snapshot();
    for (const id of [s.w2.id, s.legacy.id, missing]) expect((await post(s.tokens.manager, { ...s.input, accountFromId: id })).statusCode).toBe(404);
    expect((await post(s.tokens.manager, { ...s.input, type: 'income', accountFromId: null, accountToId: s.w2.id })).statusCode).toBe(404);
    expect(s.snapshot()).toBe(before);
    expect((await post(s.tokens.manager, s.input)).statusCode).toBe(201);
  });

  it('honors membership revocation with the same token', async () => {
    const s = await setup();
    expect((await post(s.tokens.manager, s.input)).statusCode).toBe(201);
    s.db.delete(projectMemberships).where(and(eq(projectMemberships.userId, 'manager'), eq(projectMemberships.projectId, s.p1.id))).run();
    const before = s.snapshot();
    expect((await post(s.tokens.manager, s.input)).statusCode).toBe(404);
    expect(s.snapshot()).toBe(before);
  });

  it('rechecks membership removed after authentication before CREATE', async () => {
    const s = await setup(), before = s.snapshot();
    const originalSession = app.sessionRepo.getActiveSession;
    const originalFresh = app.projectAccess.requireFreshActor;
    let activeSessionSeen = false, freshActorCalls = 0;
    app.sessionRepo.getActiveSession = function (id: string, uid: string) {
      const result = originalSession.call(this, id, uid);
      if (uid === 'manager' && result && !activeSessionSeen) {
        activeSessionSeen = true;
        s.db.delete(projectMemberships).where(and(eq(projectMemberships.userId, uid), eq(projectMemberships.projectId, s.p1.id))).run();
      }
      return result;
    };
    app.projectAccess.requireFreshActor = function (...args: any[]) {
      freshActorCalls++;
      return originalFresh.apply(this, args);
    };
    try {
      const r = await post(s.tokens.manager, s.input);
      expect(activeSessionSeen).toBe(true);
      expect(freshActorCalls).toBe(1);
      expect(r.statusCode).toBe(404);
      expect(s.snapshot()).toBe(before);
    } finally {
      app.sessionRepo.getActiveSession = originalSession;
      app.projectAccess.requireFreshActor = originalFresh;
    }
  });

  it.each([0, 1])('rejects session expiry %i seconds after the boundary between authentication and CREATE', async (secondsPastExpiry) => {
    const s = await setup(), before = s.snapshot();
    const originalSession = app.sessionRepo.getActiveSession;
    const originalFresh = app.projectAccess.requireFreshActor;
    let expiry: number | undefined, freshExpiry: number | undefined, freshNow: number | undefined;
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    app.sessionRepo.getActiveSession = function (id: string, uid: string) {
      const result = originalSession.call(this, id, uid);
      if (uid === 'manager' && result && expiry === undefined) {
        expiry = result.expiresAt;
        clock = vi.spyOn(Date, 'now').mockReturnValue((result.expiresAt + secondsPastExpiry) * 1000);
      }
      return result;
    };
    app.projectAccess.requireFreshActor = function (tx: any, userId: string, sessionId: string, originalExpiresAt: number) {
      freshExpiry = originalExpiresAt;
      freshNow = Math.floor(Date.now() / 1000);
      return originalFresh.call(this, tx, userId, sessionId, originalExpiresAt);
    };
    try {
      const r = await post(s.tokens.manager, s.input);
      expect(expiry).toBeTypeOf('number');
      expect(freshExpiry).toBe(expiry);
      expect(freshNow).toBe(expiry! + secondsPastExpiry);
      expect(r.statusCode).toBe(401);
      expect(JSON.parse(r.body).code).toBe('SESSION_INVALID');
      expect(s.snapshot()).toBe(before);
    } finally {
      clock?.mockRestore();
      app.sessionRepo.getActiveSession = originalSession;
      app.projectAccess.requireFreshActor = originalFresh;
    }
  });

  it('rechecks role and session after authentication', async () => {
    const s = await setup();
    const oldUser = app.userRepo.getAuthStateById.bind(app.userRepo);
    let done = false;
    app.userRepo.getAuthStateById = async (id: string) => { const result = await oldUser(id); if (!done && id === 'admin') { done = true; s.db.update(users).set({ role: 'viewer' }).where(eq(users.id, id)).run(); } return result; };
    const before = s.snapshot();
    expect((await post(s.tokens.admin, s.input)).statusCode).toBe(403);
    expect(s.snapshot()).toBe(before);
    app.userRepo.getAuthStateById = oldUser;
    const oldSession = app.sessionRepo.getActiveSession.bind(app.sessionRepo);
    done = false;
    app.sessionRepo.getActiveSession = (id: string, uid: string) => { const result = oldSession(id, uid); if (!done && result) { done = true; s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, id)).run(); } return result; };
    const r = await post(s.tokens.manager, s.input);
    expect(r.statusCode).toBe(401); expect(JSON.parse(r.body).code).toBe('SESSION_INVALID');
    expect(s.snapshot()).toBe(before);
  });

  it('rolls back wallet, main and Oto rows when audit insert fails', async () => {
    const s = await setup(), before = s.snapshot();
    s.db.run(sql.raw("CREATE TRIGGER fail_create_audit BEFORE INSERT ON audit_logs WHEN NEW.entity='transaction' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;"));
    expect((await post(s.tokens.manager, s.input)).statusCode).toBe(500);
    expect(s.snapshot()).toBe(before);
    expect((await post(s.tokens.manager, { ...s.input, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic payer' })).statusCode).toBe(500);
    expect(s.snapshot()).toBe(before);
    s.db.run(sql.raw('DROP TRIGGER fail_create_audit'));
    expect((await post(s.tokens.manager, s.input)).statusCode).toBe(201);
  });
});
