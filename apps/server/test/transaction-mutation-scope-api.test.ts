import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { accounts, auditLogs, authSessions, projectMemberships, transactions, users } from '@cost-core/database';
import { buildApp } from '../src/app.js';

const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
let app: any;
afterEach(async () => { if (app) { await app.close(); app = undefined; } });

async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const db = app.db, now = new Date().toISOString();
  const p1 = await app.projectRepo.createProject({ name: 'One' }), p2 = await app.projectRepo.createProject({ name: 'Two' });
  const category = await app.categoryRepo.createCategory({ name: 'Category' });
  const tokens: Record<string, string> = {};
  for (const role of ['admin', 'manager', 'accountant', 'viewer', 'auditor']) {
    db.insert(users).values({ id: role, username: role, email: role + '@example.test', fullName: 'Synthetic', passwordHash: 'synthetic', role, isActive: true, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(role);
    tokens[role] = app.jwt.sign({ id: role, username: role, role, sid: session.id, exp: session.expiresAt });
    if (role !== 'admin') db.insert(projectMemberships).values({ userId: role, projectId: p1.id, createdAt: now }).run();
  }
  const wallet = (projectId: string | null) => app.accountRepo.createAccount({ name: 'Synthetic', type: 'cash', currency: 'TRY', initialBalance: 1000, projectId }, config.masterKey, config.blindIndexPepper);
  const w1 = wallet(p1.id), w2 = wallet(p2.id);
  const input = { projectId: p1.id, type: 'expense', date: '2026-10-01T10:00:00.000Z', amount: 100, currency: 'TRY', categoryId: category.id, title: 'Synthetic', accountFromId: w1.id, isPaid: true };
  const call = (role: string, method: string, suffix: string, payload?: any) => app.inject({ method, url: '/api/transactions' + suffix, headers: { authorization: 'Bearer ' + tokens[role] }, ...(payload === undefined ? {} : { payload }) });
  const create = async (data: any = input) => { const r = await call('admin', 'POST', '', data); expect(r.statusCode).toBe(201); return JSON.parse(r.body); };
  const snapshot = () => JSON.stringify([db.select().from(accounts).all(), db.select().from(transactions).all(), db.select().from(auditLogs).all()]);
  return { db, p1, p2, w1, w2, input, tokens, call, create, snapshot };
}

describe('transaction mutation scope', () => {
  it('permits scoped updates, payment, delete, restore and both permanent routes', async () => {
    const s = await setup();
    const a = (await s.create({ ...s.input, isPaid: false })).transaction.id;
    expect((await s.call('manager', 'PUT', '/' + a, { title: 'Updated' })).statusCode).toBe(200);
    expect((await s.call('accountant', 'POST', '/' + a + '/mark-paid')).statusCode).toBe(200);
    const paid = s.snapshot();
    expect((await s.call('manager', 'POST', '/' + a + '/mark-paid')).statusCode).toBe(200);
    expect(s.snapshot()).toBe(paid);
    expect((await s.call('manager', 'DELETE', '/' + a)).statusCode).toBe(200);
    expect((await s.call('manager', 'POST', '/' + a + '/restore')).statusCode).toBe(200);
    const restored = s.snapshot();
    expect((await s.call('manager', 'POST', '/' + a + '/restore')).statusCode).toBe(200);
    expect(s.snapshot()).toBe(restored);
    expect((await s.call('manager', 'DELETE', '/' + a + '?permanent=true')).statusCode).toBe(200);
    const b = (await s.create()).transaction.id;
    expect((await s.call('manager', 'DELETE', '/' + b + '/permanent')).statusCode).toBe(200);
  });

  it('rejects foreign and legacy rows before decrypting, and rejects read-only roles', async () => {
    const s = await setup();
    const foreign = (await s.create({ ...s.input, projectId: s.p2.id, accountFromId: s.w2.id })).transaction.id;
    const legacy = (await s.create({ ...s.input, projectId: null, accountFromId: null })).transaction.id;
    const own = (await s.create()).transaction.id;
    s.db.update(transactions).set({ amountEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, foreign)).run();
    const before = s.snapshot();
    for (const [method, suffix, body] of [['PUT', '', { title: 'X' }], ['DELETE', '', undefined], ['DELETE', '?permanent=true', undefined], ['DELETE', '/permanent', undefined], ['POST', '/restore', undefined], ['POST', '/mark-paid', undefined]] as const) {
      for (const id of [foreign, legacy, 'missing']) expect((await s.call('manager', method, '/' + id + suffix, body)).statusCode).toBe(404);
      for (const role of ['viewer', 'auditor']) expect((await s.call(role, method, '/' + own + suffix, body)).statusCode).toBe(403);
    }
    expect(s.snapshot()).toBe(before);
    expect((await s.call('admin', 'DELETE', '/%20')).statusCode).toBe(400);
    expect((await s.call('admin', 'DELETE', '/' + legacy)).statusCode).toBe(200);
  });

  it('rejects cross-project wallets even for a member of both projects', async () => {
    const s = await setup();
    s.db.insert(projectMemberships).values({ userId: 'manager', projectId: s.p2.id, createdAt: new Date().toISOString() }).run();
    const bad = (await s.create({ ...s.input, accountFromId: s.w2.id })).transaction.id;
    const good = (await s.create()).transaction.id;
    const before = s.snapshot();
    for (const [method, suffix, body] of [['PUT', '', { title: 'X' }], ['DELETE', '', undefined], ['DELETE', '/permanent', undefined], ['POST', '/restore', undefined], ['POST', '/mark-paid', undefined]] as const) expect((await s.call('manager', method, '/' + bad + suffix, body)).statusCode).toBe(404);
    expect((await s.call('manager', 'PUT', '/' + good, { accountFromId: s.w2.id })).statusCode).toBe(404);
    expect(s.snapshot()).toBe(before);
  });

  it('fails closed on forward and reverse cross-project Oto links', async () => {
    const s = await setup();
    const pair = await s.create({ ...s.input, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic' });
    const a = pair.transaction.id, b = pair.otoKasaTransaction.id;
    s.db.update(transactions).set({ projectId: s.p2.id, amountEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, b)).run();
    for (const both of [false, true]) {
      if (both) s.db.insert(projectMemberships).values({ userId: 'manager', projectId: s.p2.id, createdAt: new Date().toISOString() }).run();
      const before = s.snapshot();
      for (const id of both ? [a, b] : [a]) for (const [method, suffix, body] of [['PUT', '', { title: 'X' }], ['DELETE', '', undefined], ['DELETE', '/permanent', undefined], ['POST', '/restore', undefined], ['POST', '/mark-paid', undefined]] as const) expect([404, 409]).toContain((await s.call('manager', method, '/' + id + suffix, body)).statusCode);
      expect(s.snapshot()).toBe(before);
    }
  });

  it('preserves linked Oto lifecycle and rolls back the entire pair on audit failure', async () => {
    const s = await setup();
    const pair = await s.create({ ...s.input, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic' });
    const a = pair.transaction.id, b = pair.otoKasaTransaction.id;
    expect((await s.call('manager', 'PUT', '/' + b, { title: 'X' })).statusCode).toBe(409);
    expect((await s.call('manager', 'POST', '/' + b + '/mark-paid')).statusCode).toBe(409);
    expect((await s.call('manager', 'PUT', '/' + a, { title: 'Updated' })).statusCode).toBe(200);
    const before = s.snapshot();
    s.db.run(sql.raw("CREATE TRIGGER fail_pair_audit BEFORE INSERT ON audit_logs WHEN NEW.entity='transaction' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;"));
    expect((await s.call('manager', 'DELETE', '/' + a)).statusCode).toBe(500);
    expect(s.snapshot()).toBe(before);
    s.db.run(sql.raw('DROP TRIGGER fail_pair_audit'));
    expect((await s.call('manager', 'DELETE', '/' + b)).statusCode).toBe(200);
    expect((await s.call('manager', 'POST', '/' + b + '/restore')).statusCode).toBe(200);
  });

  it('rejects malformed or missing links and reverse-only links without effects', async () => {
    const s = await setup();
    const pair = await s.create({ ...s.input, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic' });
    const a = pair.transaction.id, b = pair.otoKasaTransaction.id;
    for (const link of [null, '', 'missing']) {
      s.db.update(transactions).set({ otoKasaTransactionId: link }).where(eq(transactions.id, a)).run();
      const before = s.snapshot();
      for (const id of [a, b]) expect([404, 409]).toContain((await s.call('manager', 'DELETE', '/' + id)).statusCode);
      expect(s.snapshot()).toBe(before);
    }
  });

  it('rechecks membership and session, and rolls back audit failures', async () => {
    const s = await setup(); const id = (await s.create()).transaction.id;
    s.db.delete(projectMemberships).where(and(eq(projectMemberships.userId, 'manager'), eq(projectMemberships.projectId, s.p1.id))).run();
    let before = s.snapshot();
    expect((await s.call('manager', 'DELETE', '/' + id)).statusCode).toBe(404); expect(s.snapshot()).toBe(before);
    s.db.insert(projectMemberships).values({ userId: 'manager', projectId: s.p1.id, createdAt: new Date().toISOString() }).run();
    const old = app.sessionRepo.getActiveSession.bind(app.sessionRepo);
    app.sessionRepo.getActiveSession = (sid: string, uid: string) => { const result = old(sid, uid); if (result && uid === 'manager') s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, sid)).run(); return result; };
    const invalid = await s.call('manager', 'DELETE', '/' + id);
    expect(invalid.statusCode).toBe(401); expect(JSON.parse(invalid.body).code).toBe('SESSION_INVALID');
    app.sessionRepo.getActiveSession = old;
    before = s.snapshot();
    s.db.run(sql.raw("CREATE TRIGGER fail_mutation_audit BEFORE INSERT ON audit_logs WHEN NEW.entity='transaction' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;"));
    expect((await s.call('admin', 'DELETE', '/' + id)).statusCode).toBe(500);
    expect(s.snapshot()).toBe(before);
  });

  it.each(['role', 'membership'])('rechecks %s after authentication', async (change) => {
    const s = await setup(); const id = (await s.create()).transaction.id;
    const before = s.snapshot();
    const old = app.sessionRepo.getActiveSession.bind(app.sessionRepo);
    let called = false;
    app.sessionRepo.getActiveSession = (sid: string, uid: string) => {
      const result = old(sid, uid);
      if (uid === 'manager' && result && !called) {
        called = true;
        if (change === 'role') s.db.update(users).set({ role: 'viewer' }).where(eq(users.id, uid)).run();
        else s.db.delete(projectMemberships).where(and(eq(projectMemberships.userId, uid), eq(projectMemberships.projectId, s.p1.id))).run();
      }
      return result;
    };
    try {
      expect((await s.call('manager', 'DELETE', '/' + id)).statusCode).toBe(change === 'role' ? 403 : 404);
      expect(called).toBe(true); expect(s.snapshot()).toBe(before);
    } finally { app.sessionRepo.getActiveSession = old; }
  });

  it('rejects expiry at the exact boundary even for an idempotent payment', async () => {
    const s = await setup(); const id = (await s.create()).transaction.id;
    const before = s.snapshot(), old = app.sessionRepo.getActiveSession.bind(app.sessionRepo);
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    app.sessionRepo.getActiveSession = (sid: string, uid: string) => {
      const result = old(sid, uid);
      if (uid === 'manager' && result && !clock) clock = vi.spyOn(Date, 'now').mockReturnValue(result.expiresAt * 1000);
      return result;
    };
    try {
      const response = await s.call('manager', 'POST', '/' + id + '/mark-paid');
      expect(clock).toBeDefined(); expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body).code).toBe('SESSION_INVALID'); expect(s.snapshot()).toBe(before);
    } finally { clock?.mockRestore(); app.sessionRepo.getActiveSession = old; }
  });

  it('rejects malformed IDs on all mutation endpoints', async () => {
    const s = await setup();
    const before = s.snapshot();
    for (const [method, suffix, body] of [['PUT', '', { title: 'X' }], ['DELETE', '', undefined], ['DELETE', '?permanent=true', undefined], ['DELETE', '/permanent', undefined], ['POST', '/restore', undefined], ['POST', '/mark-paid', undefined]] as const) {
      expect((await s.call('admin', method, '/%20' + suffix, body)).statusCode).toBe(400);
    }
    expect(s.snapshot()).toBe(before);
  });

  it.each(['expense', 'income'])('fails closed for an orphan personal %s on every endpoint', async (remaining) => {
    const s = await setup();
    const pair = await s.create({ ...s.input, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic' });
    const main = pair.transaction.id, oto = pair.otoKasaTransaction.id;
    s.db.update(transactions).set({ otoKasaTransactionId: null }).where(eq(transactions.id, main)).run();
    s.db.update(transactions).set({ otoKasaTransactionId: null }).where(eq(transactions.id, oto)).run();
    s.db.delete(transactions).where(eq(transactions.id, remaining === 'expense' ? oto : main)).run();
    const id = remaining === 'expense' ? main : oto, before = s.snapshot();
    for (const role of ['admin', 'manager']) for (const [method, suffix, body] of [['PUT', '', { title: 'X' }], ['DELETE', '', undefined], ['DELETE', '?permanent=true', undefined], ['DELETE', '/permanent', undefined], ['POST', '/restore', undefined], ['POST', '/mark-paid', undefined]] as const) {
      expect([404, 409]).toContain((await s.call(role, method, '/' + id + suffix, body)).statusCode);
    }
    expect(s.snapshot()).toBe(before);
  });

  it.each(['expense', 'income'])('rejects all mutations on a half-deleted pair from the %s side', async (side) => {
    const s = await setup();
    const pair = await s.create({ ...s.input, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic' });
    const main = pair.transaction.id, oto = pair.otoKasaTransaction.id;
    s.db.update(transactions).set({ deletedAt: '2026-10-02T00:00:00.000Z', amountEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, oto)).run();
    const before = s.snapshot(), id = side === 'expense' ? main : oto;
    for (const role of ['admin', 'manager']) for (const [method, suffix, body] of [['PUT', '', { title: 'X' }], ['DELETE', '', undefined], ['DELETE', '?permanent=true', undefined], ['DELETE', '/permanent', undefined], ['POST', '/restore', undefined], ['POST', '/mark-paid', undefined]] as const) {
      expect([404, 409]).toContain((await s.call(role, method, '/' + id + suffix, body)).statusCode);
    }
    expect(s.snapshot()).toBe(before);
  });

  it('rejects opposite-direction company wallets for both member roles without effects', async () => {
    const s = await setup();
    const expense = (await s.create()).transaction.id;
    const income = (await s.create({ ...s.input, type: 'income', accountFromId: null, accountToId: s.w1.id })).transaction.id;
    const before = s.snapshot();
    for (const role of ['manager', 'accountant']) for (const wallet of [s.w1.id, s.w2.id]) {
      expect((await s.call(role, 'PUT', '/' + expense, { accountToId: wallet })).statusCode).toBe(400);
      expect((await s.call(role, 'PUT', '/' + income, { accountFromId: wallet })).statusCode).toBe(400);
    }
    expect(s.snapshot()).toBe(before);
  });

  it('checks old and new effective wallets across company and person mode changes', async () => {
    const s = await setup();
    s.db.insert(projectMemberships).values({ userId: 'manager', projectId: s.p2.id, createdAt: new Date().toISOString() }).run();
    const bad = (await s.create({ ...s.input, accountFromId: s.w2.id })).transaction.id;
    const good = (await s.create()).transaction.id;
    const before = s.snapshot();
    expect((await s.call('manager', 'PUT', '/' + bad, { paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic' })).statusCode).toBe(404);
    expect((await s.call('manager', 'PUT', '/' + good, { accountFromId: s.w2.id })).statusCode).toBe(404);
    expect(s.snapshot()).toBe(before);
    expect((await s.call('manager', 'PUT', '/' + good, { paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic', accountFromId: s.w2.id, accountToId: s.w2.id })).statusCode).toBe(200);
    const person = app.transactionRepo.getTransactionById(good, config.masterKey);
    expect(person.accountFromId).toBeNull(); expect(person.accountToId).toBeNull(); expect(person.otoKasaTransactionId).toBeTruthy();
    const personSnapshot = s.snapshot();
    expect((await s.call('manager', 'PUT', '/' + good, { paymentSource: 'company_account', accountFromId: s.w2.id })).statusCode).toBe(404);
    expect(s.snapshot()).toBe(personSnapshot);
    expect((await s.call('manager', 'PUT', '/' + good, { paymentSource: 'company_account', accountFromId: s.w1.id })).statusCode).toBe(200);
    expect(app.transactionRepo.getTransactionById(good, config.masterKey).otoKasaTransactionId).toBeNull();
  });

  it.each(['company', 'person'])('rolls back update, payment, restore and permanent deletes for %s', async (mode) => {
    const s = await setup();
    const data = mode === 'person' ? { ...s.input, isPaid: false, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic' } : { ...s.input, isPaid: false };
    const live = (await s.create({ ...data, isPaid: true })).transaction.id;
    const unpaid = (await s.create(data)).transaction.id;
    const trash = (await s.create({ ...data, isPaid: true })).transaction.id;
    expect((await s.call('admin', 'DELETE', '/' + trash)).statusCode).toBe(200);
    s.db.run(sql.raw("CREATE TRIGGER fail_matrix_audit BEFORE INSERT ON audit_logs WHEN NEW.entity='transaction' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;"));
    const before = s.snapshot();
    for (const [method, id, suffix, body] of [['PUT', live, '', { amount: 120 }], ['POST', unpaid, '/mark-paid', undefined], ['POST', trash, '/restore', undefined], ['DELETE', live, '?permanent=true', undefined], ['DELETE', live, '/permanent', undefined], ['DELETE', trash, '?permanent=true', undefined], ['DELETE', trash, '/permanent', undefined]] as const) {
      expect((await s.call('manager', method, '/' + id + suffix, body)).statusCode).toBe(500);
      expect(s.snapshot()).toBe(before);
    }
  });
});
