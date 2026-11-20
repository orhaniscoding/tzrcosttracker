import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { projectMemberships, projects, transactions, users } from '@cost-core/database';
import { buildApp } from '../src/app.js';

const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
let app: any;
afterEach(async () => { if (app) { await app.close(); app = undefined; } });
const headers = (token: string) => ({ authorization: 'Bearer ' + token });
const ids = (r: any) => { expect(r.statusCode).toBe(200); return JSON.parse(r.body).map((x: any) => x.id).sort(); };
const get = (token: string, path = '') => app.inject({ method: 'GET', url: '/api/transactions' + path, headers: headers(token) });
const duplicate = (token: string, payload: any) => app.inject({ method: 'POST', url: '/api/transactions/check-duplicate', headers: headers(token), payload });
const input = (projectId: string | null, title: string) => ({ projectId, title, date: '2026-10-01T10:00:00.000Z', type: 'expense', amount: 100, currency: 'TRY', categoryId: '', paymentSource: 'company_account', paymentMethod: 'Banka', isPaid: false });

async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const db = app.db, now = new Date().toISOString();
  for (const id of ['site one', 'site2']) db.insert(projects).values({ id, name: id, budget: 0, currency: 'TRY', status: 'active', createdAt: now, updatedAt: now }).run();
  const tokens: Record<string, string> = {};
  for (const role of ['admin', 'manager', 'accountant', 'auditor', 'viewer', 'other', 'unassigned']) {
    const actualRole = role === 'other' || role === 'unassigned' ? 'viewer' : role;
    db.insert(users).values({ id: role, username: role, email: role + '@example.test', fullName: 'Synthetic', passwordHash: 'synthetic-hash', role: actualRole, isActive: true, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(role);
    tokens[role] = app.jwt.sign({ id: role, username: role, role: actualRole, sid: session.id, exp: session.expiresAt });
    if (role !== 'admin' && role !== 'unassigned') db.insert(projectMemberships).values({ userId: role, projectId: role === 'other' ? 'site2' : 'site one', createdAt: now }).run();
  }
  const category = await app.categoryRepo.createCategory({ name: 'Synthetic category' });
  function create(pid: string | null, title: string) {
    return app.transactionRepo.createTransaction({ ...input(pid, title), categoryId: category.id, createdById: 'admin' }, config.masterKey, config.blindIndexPepper).transaction;
  }
  const a = create('site one', 'Visible'); const b = create('site2', 'Foreign'); const legacy = create(null, 'Legacy');
  const trashA = create('site one', 'Trash visible'); const trashB = create('site2', 'Trash foreign');
  app.transactionRepo.softDeleteTransaction(trashA.id, config.masterKey); app.transactionRepo.softDeleteTransaction(trashB.id, config.masterKey);
  return { db, tokens, a, b, legacy, trashA, trashB };
}

describe('transaction read project scope', () => {
  it('scopes list, detail, trash and duplicate for every role', async () => {
    const s = await setup(), t = s.tokens;
    expect(ids(await get(t.admin))).toEqual([s.a.id, s.b.id, s.legacy.id].sort());
    expect(ids(await get(t.admin, '/trash'))).toEqual([s.trashA.id, s.trashB.id].sort());
    expect((await get(t.admin, '/' + s.legacy.id)).statusCode).toBe(200);
    expect(JSON.parse((await duplicate(t.admin, { title: 'Legacy', date: '2026-10-01' })).body)).toEqual({ isDuplicate: true, existingTransactionId: s.legacy.id });
    for (const role of ['manager', 'accountant', 'auditor', 'viewer']) {
      const token = t[role];
      expect(ids(await get(token, '?role=admin&userId=admin&scope=all'))).toEqual([s.a.id]);
      expect(ids(await get(token, '/trash'))).toEqual([s.trashA.id]);
      expect((await get(token, '/' + s.a.id)).statusCode).toBe(200);
      for (const id of [s.b.id, s.legacy.id, s.trashA.id, 'missing']) expect((await get(token, '/' + id)).statusCode).toBe(404);
      expect(JSON.parse((await duplicate(token, { title: 'Visible', date: input(null, '').date })).body)).toEqual({ isDuplicate: true, existingTransactionId: s.a.id });
      expect(JSON.parse((await duplicate(token, { title: 'Foreign', date: input(null, '').date })).body)).toEqual({ isDuplicate: false });
      expect((await duplicate(token, { title: 'Foreign', date: input(null, '').date, projectId: 'site2' })).statusCode).toBe(404);
    }
    expect(ids(await get(t.other))).toEqual([s.b.id]);
    expect(ids(await get(t.unassigned))).toEqual([]);
    expect(ids(await get(t.unassigned, '/trash'))).toEqual([]);
    expect(JSON.parse((await duplicate(t.unassigned, { title: 'Visible', date: input(null, '').date })).body)).toEqual({ isDuplicate: false });
  });

  it('validates explicit project and identifiers without trimming or broadening', async () => {
    const s = await setup(), token = s.tokens.manager;
    expect(ids(await get(token, '?projectId=site%20one'))).toEqual([s.a.id]);
    for (const p of ['site2', 'missing', '%20site%20one%20']) expect((await get(token, '?projectId=' + p)).statusCode).toBe(404);
    for (const p of ['', '%20%20', 'x'.repeat(129), 'site2&projectId=site%20one']) expect((await get(token, '?projectId=' + p)).statusCode).toBe(400);
    expect((await get(token, '/%20%20')).statusCode).toBe(400);
    expect((await get(token, '/' + 'x'.repeat(129))).statusCode).toBe(414);
    expect((await get(token, '/' + 'x'.repeat(1000))).statusCode).toBe(414);
    for (const body of [null, {}, { title: '', date: '2026-10-01' }, { title: 'Visible', date: 'bad' }, { title: 'Visible', date: '2026-02-30' }, { title: 'Visible', date: '2026-10-01', projectId: null }, { title: 'Visible', date: '2026-10-01', projectId: '' }, { title: 'Visible', date: '2026-10-01', projectId: ['site one'] }]) expect((await duplicate(token, body)).statusCode).toBe(400);
    expect((await duplicate(token, { title: 'Visible', date: '2026-10-01', projectId: 'missing' })).statusCode).toBe(404);
  });

  it('applies membership revocation to the next request using the same token', async () => {
    const s = await setup(), token = s.tokens.manager;
    expect(ids(await get(token))).toEqual([s.a.id]);
    s.db.delete(projectMemberships).where(and(eq(projectMemberships.userId, 'manager'), eq(projectMemberships.projectId, 'site one'))).run();
    expect(ids(await get(token))).toEqual([]);
    expect(ids(await get(token, '/trash'))).toEqual([]);
    expect((await get(token, '/' + s.a.id)).statusCode).toBe(404);
    expect(JSON.parse((await duplicate(token, { title: 'Visible', date: '2026-10-01' })).body)).toEqual({ isDuplicate: false });
  });

  it('uses the union of current memberships and the current server role', async () => {
    const s = await setup(), token = s.tokens.manager;
    s.db.insert(projectMemberships).values({ userId: 'manager', projectId: 'site2', createdAt: new Date().toISOString() }).run();
    expect(ids(await get(token))).toEqual([s.a.id, s.b.id].sort());
    s.db.update(users).set({ role: 'admin' }).where(eq(users.id, 'manager')).run();
    expect(ids(await get(token))).toEqual([s.a.id, s.b.id, s.legacy.id].sort());
    s.db.update(users).set({ role: 'viewer' }).where(eq(users.id, 'manager')).run();
    expect(ids(await get(token))).toEqual([s.a.id, s.b.id].sort());
  });

  it('does not decrypt excluded malformed ciphertext', async () => {
    const s = await setup();
    s.db.update(transactions).set({ amountEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, s.b.id)).run();
    s.db.update(transactions).set({ amountEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, s.trashB.id)).run();
    expect(ids(await get(s.tokens.manager))).toEqual([s.a.id]);
    expect(ids(await get(s.tokens.manager, '/trash'))).toEqual([s.trashA.id]);
    expect((await get(s.tokens.manager, '/' + s.b.id)).statusCode).toBe(404);
    expect((await get(s.tokens.admin)).statusCode).toBe(500);
  });
});
