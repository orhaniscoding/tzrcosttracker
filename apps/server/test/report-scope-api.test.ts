import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { authSessions, projectMemberships, projects, TransactionRepository, transactions, users } from '@cost-core/database';
import { buildApp } from '../src/app.js';

// Synthetic configuration only; all fixtures live in a fresh in-memory DB.
const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
const endpoints = ['balance', 'summary', 'export/csv'] as const;
type Endpoint = typeof endpoints[number];
const csvHeader = '\uFEFFTarih;Başlık / Kalem;Tutar;Para Birimi;Kategori;Tedarikçi / Cari;Açıklama';
const genericError = { error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' };
let app: any;
afterEach(async () => { vi.restoreAllMocks(); if (app) { await app.close(); app = undefined; } });
const get = (endpoint: Endpoint, token?: string, query = '') => app.inject({ method: 'GET', url: '/api/reports/' + endpoint + query, headers: token ? { authorization: 'Bearer ' + token } : {} });

async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const db = app.db, now = new Date().toISOString();
  for (const id of ['site one', 'site2']) db.insert(projects).values({ id, name: id, budget: 0, currency: 'TRY', status: 'active', createdAt: now, updatedAt: now }).run();
  const tokens: Record<string, string> = {}, sessions: Record<string, any> = {};
  for (const id of ['admin', 'manager', 'accountant', 'auditor', 'viewer', 'other', 'unassigned']) {
    const role = ['other', 'unassigned'].includes(id) ? 'viewer' : id;
    db.insert(users).values({ id, username: id, email: id + '@example.test', fullName: 'Synthetic', passwordHash: 'synthetic-hash', role, isActive: true, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(id); sessions[id] = session;
    tokens[id] = app.jwt.sign({ id, username: id, role, sid: session.id, exp: session.expiresAt });
    if (id !== 'admin' && id !== 'unassigned') db.insert(projectMemberships).values({ userId: id, projectId: id === 'other' ? 'site2' : 'site one', createdAt: now }).run();
  }
  const catA = await app.categoryRepo.createCategory({ name: 'Visible category' });
  const catB = await app.categoryRepo.createCategory({ name: 'Foreign category' });
  const catL = await app.categoryRepo.createCategory({ name: 'Legacy category' });
  function create(projectId: string | null, title: string, amount: number, extra: any = {}) {
    return app.transactionRepo.createTransaction({ projectId, title, amount, type: 'expense', date: '2026-10-10T10:00:00.000Z', currency: 'TRY', categoryId: projectId === 'site2' ? catB.id : projectId === null ? catL.id : catA.id, paymentSource: 'company_account', paymentMethod: 'Banka', isPaid: true, createdById: 'admin', ...extra }, config.masterKey, config.blindIndexPepper);
  }
  const a = create('site one', 'Visible expense', 100).transaction;
  const ai = create('site one', 'Visible income', 40, { type: 'income', date: '2026-10-11T10:00:00.000Z', party: 'Visible contributor' }).transaction;
  const b = create('site2', 'Foreign expense', 700).transaction;
  const bi = create('site2', 'Foreign income', 200, { type: 'income', party: 'Foreign contributor' }).transaction;
  const legacy = create(null, 'Legacy expense', 900).transaction;
  const li = create(null, 'Legacy income', 300, { type: 'income', party: 'Legacy contributor' }).transaction;
  const trash = create('site one', 'Deleted visible', 999).transaction;
  const trashB = create('site2', 'Deleted foreign', 888).transaction;
  app.transactionRepo.softDeleteTransaction(trash.id, config.masterKey);
  app.transactionRepo.softDeleteTransaction(trashB.id, config.masterKey);
  return { db, tokens, sessions, create, a, ai, b, bi, legacy, li, trash, trashB, catA, catB, catL, visible: [a, ai], foreign: [b, bi], all: [a, ai, b, bi, legacy, li] };
}

// Assert corrected accounting over exactly the authorized row set. These fixtures
// have no wallets: only realized company movements contribute to company cash.
function expectRows(endpoint: Endpoint, response: any, rows: any[]) {
  expect(response.statusCode).toBe(200);
  const recognized = rows.filter(r => ['approved', 'pending', 'paid'].includes(r.status));
  const oto = (r: any) => r.type === 'income' && (r.otoKasaTransactionId || r.paymentSource === 'person_out_of_pocket');
  const counted = recognized.filter(r => !oto(r) && r.type !== 'transfer');
  const income = counted.filter(r => r.type === 'income').reduce((sum, r) => sum + r.amount, 0);
  const expense = counted.filter(r => r.type === 'expense').reduce((sum, r) => sum + r.amount, 0);
  const body = JSON.parse(endpoint === 'export/csv' ? '{}' : response.body);
  if (endpoint === 'balance') {
    const paid = counted.filter(r => r.type === 'expense' && r.isPaid).reduce((sum, r) => sum + r.amount, 0);
    const personal = counted.filter(r => r.type === 'expense' && r.isPaid && r.paymentSource === 'person_out_of_pocket').reduce((sum, r) => sum + r.amount, 0);
    const pending = counted.filter(r => r.type === 'expense' && !r.isPaid && r.paymentSource !== 'person_out_of_pocket').reduce((sum, r) => sum + r.amount, 0);
    const cashIncome = counted.filter(r => r.type === 'income' && r.isPaid !== false && r.status !== 'pending').reduce((sum, r) => sum + r.amount, 0);
    const cash = cashIncome - (paid - personal);
    expect(body).toMatchObject({ totalIncome: income, totalPaidExpense: paid, companyPaidExpenseTotal: paid - personal, personFundedExpenseTotal: personal, actualCashInHand: cash, totalPendingExpense: pending, overdueDebt: 0, netPositionAfterDue: cash - pending, totalTransactions: counted.length,
      baseCurrency: 'TRY', mixedCurrency: false, excludedCurrencies: [], walletBalanceTotal: 0, unallocatedCashTotal: cash, ccDebt: 0, ccCredit: 0, inactiveAccountCount: 0, inactiveWalletBalanceTotal: 0, crossScopeWalletNetTotal: 0, excludedDraftOrRejectedCount: rows.length - recognized.length, cashScopeMode: expect.stringMatching(/^(current|filtered_period)$/) });
    expect(Object.keys(body).sort()).toEqual(['totalIncome', 'totalPaidExpense', 'companyPaidExpenseTotal', 'personFundedExpenseTotal', 'actualCashInHand', 'totalPendingExpense', 'overdueDebt', 'netPositionAfterDue', 'totalTransactions', 'personContributions', 'baseCurrency', 'mixedCurrency', 'excludedCurrencies', 'byCurrency', 'walletBalanceTotal', 'unallocatedCashTotal', 'ccDebt', 'ccCredit', 'excludedDraftOrRejectedCount', 'cashScopeMode', 'inactiveAccountCount', 'inactiveWalletBalanceTotal', 'crossScopeWalletNetTotal'].sort());
    const names = [...new Set(recognized.filter(r => r.type === 'income').map(r => r.payerPersonName || r.party || 'Diğer'))].sort();
    expect(body.personContributions.map((p: any) => p.personName).sort()).toEqual(names);
    expect(Object.keys(body.byCurrency)).toEqual(rows.length ? ['TRY'] : []);
  } else if (endpoint === 'summary') {
    const categories = new Map<string, number>();
    for (const r of counted.filter(r => r.type === 'expense')) categories.set(r.categoryId, (categories.get(r.categoryId) || 0) + r.amount);
    expect(body).toEqual({ totalIncome: income, totalExpense: expense, netBalance: income - expense, transactionCount: counted.length, categoryBreakdown: expect.any(Array), baseCurrency: 'TRY', mixedCurrency: false, excludedCurrencies: [], byCurrency: expect.any(Object), otoKasaExcludedTotal: recognized.filter(oto).reduce((sum, r) => sum + r.amount, 0), unrecognizedCount: rows.length - recognized.length });
    expect(Object.keys(body.byCurrency)).toEqual(rows.length ? ['TRY'] : []);
    const breakdown = body.categoryBreakdown;
    expect(breakdown).toHaveLength(categories.size);
    expect(breakdown.map((c: any) => c.amount).sort((a: number, b: number) => a - b)).toEqual([...categories.values()].sort((a, b) => a - b));
  } else {
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="TZRCoster_Rapor_\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.body.split('\r\n')[0]).toBe(csvHeader);
    expect(response.body.split('\r\n')).toHaveLength(rows.length + 1);
    for (const row of rows) expect(response.body).toContain('"' + row.title + '"');
  }
}

function removeMembership(db: any, userId = 'manager') {
  db.delete(projectMemberships).where(and(eq(projectMemberships.userId, userId), eq(projectMemberships.projectId, 'site one'))).run();
}

// Execute a deterministic auth -> read mutation inside the actual read transaction,
// immediately before the original freshness check. No sleeps or concurrent writers.
async function duringFresh(mutate: (tx: any, uid: string, sid: string, expiry: number) => void, run: () => Promise<any>) {
  const original = app.projectAccess.requireFreshActor;
  let calls = 0;
  app.projectAccess.requireFreshActor = function (tx: any, uid: string, sid: string, expiry: number) {
    calls++; expect(tx).not.toBe(app.db);
    mutate(tx, uid, sid, expiry);
    return original.call(this, tx, uid, sid, expiry);
  };
  try { const response = await run(); expect(calls).toBe(1); return response; }
  finally { app.projectAccess.requireFreshActor = original; }
}

describe('report HTTP project scope', () => {
  it.each(endpoints)('%s uses current memberships for every valid role and keeps admin null-project legacy', async (endpoint) => {
    const s = await setup();
    expectRows(endpoint, await get(endpoint, s.tokens.admin), s.all);
    for (const role of ['manager', 'accountant', 'auditor', 'viewer']) {
      const r = await get(endpoint, s.tokens[role]); expectRows(endpoint, r, s.visible);
      for (const text of ['Foreign contributor', 'Legacy contributor', 'Foreign category', 'Legacy category', 'Foreign expense', 'Legacy expense', 'Deleted visible', 'Deleted foreign']) expect(r.body).not.toContain(text);
    }
    expectRows(endpoint, await get(endpoint, s.tokens.other), s.foreign);
    const empty = await get(endpoint, s.tokens.unassigned); expectRows(endpoint, empty, []);
    if (endpoint === 'export/csv') expect(empty.body).toBe(csvHeader);
    if (endpoint === 'balance') expect(JSON.parse(empty.body).personContributions).toEqual([]);
  });

  it.each(endpoints)('%s intersects explicit projects with the membership union and never trims opaque IDs', async (endpoint) => {
    const s = await setup();
    s.db.insert(projectMemberships).values({ userId: 'manager', projectId: 'site2', createdAt: new Date().toISOString() }).run();
    expectRows(endpoint, await get(endpoint, s.tokens.manager), [...s.visible, ...s.foreign]);
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?projectId=site%20one'), s.visible);
    expectRows(endpoint, await get(endpoint, s.tokens.admin, '?projectId=site2'), s.foreign);
    for (const project of ['missing', '%20site%20one%20', 'null', 'undefined']) {
      const r = await get(endpoint, s.tokens.manager, '?projectId=' + project);
      expect(r.statusCode).toBe(404); expect(JSON.parse(r.body)).toEqual({ error: 'Bulunamadı.' });
    }
    expect((await get(endpoint, s.tokens.viewer, '?projectId=site2')).body).toBe((await get(endpoint, s.tokens.viewer, '?projectId=missing')).body);
    expect((await get(endpoint, s.tokens.unassigned, '?projectId=site%20one')).statusCode).toBe(404);
    expect((await get(endpoint, s.tokens.admin, '?projectId=missing')).statusCode).toBe(404);
    for (const project of ['', '%20%20', 'x'.repeat(129), 'site2&projectId=site%20one', 'site%20one&projectId=site%20one']) expect((await get(endpoint, s.tokens.admin, '?projectId=' + project)).statusCode).toBe(400);
  });

  it.each(endpoints)('%s ignores untrusted scope and repository-only query filters, including deleted/type/status', async (endpoint) => {
    const s = await setup();
    const attack = '?role=admin&userId=admin&scope=all&scope[all]=true&projectIds=site2&includeDeleted=true&type=income&status=rejected&isPaid=false&categoryId=missing&searchTitle=Foreign';
    expectRows(endpoint, await get(endpoint, s.tokens.manager, attack), s.visible);
    expectRows(endpoint, await get(endpoint, s.tokens.unassigned, attack), []);
    expectRows(endpoint, await get(endpoint, s.tokens.admin, attack), s.all);
    expect((await get(endpoint, s.tokens.manager, attack + '&projectId=site2')).statusCode).toBe(404);
  });

  it.each(endpoints)('%s shares inclusive UTC day and timestamp filters, with SQL filtering before decrypt', async (endpoint) => {
    const s = await setup();
    const first = s.create('site one', 'Day first', 2, { date: '2026-10-12T00:00:00.000Z' }).transaction;
    const last = s.create('site one', 'Day last', 3, { date: '2026-10-12T23:59:59.999Z' }).transaction;
    const dayOnly = s.create('site one', 'Legacy day only', 4, { date: '2026-10-12' }).transaction;
    const next = s.create('site one', 'Next day', 5, { date: '2026-10-13T00:00:00.000Z' }).transaction;
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?endDate=2026-10-10'), [s.a]);
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-13'), [next]);
    s.db.update(transactions).set({ amountEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, s.a.id)).run();
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12&endDate=2026-10-12'), [first, last, dayOnly]);
    // Stored date-only values are UTC midnight instants, even with timestamp bounds.
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12T00:00:00Z&endDate=2026-10-12T23:59:59.999Z'), [first, last, dayOnly]);
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12T23:59:59.999Z&endDate=2026-10-13T00:00:00.000Z'), [last, next]);
    expect((await get(endpoint, s.tokens.manager, '?startDate=2026-10-12&endDate=2026-10-12&projectId=site2')).statusCode).toBe(404);
  });

  it.each(endpoints)('%s rejects malformed, repeated, impossible and inverted dates', async (endpoint) => {
    const s = await setup();
    for (const value of ['', 'bad', '2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-10T24:00:00Z', '2026-10-10T10:00:00', '2026-10-10T10:00:00%2B01:00', '2026-02-30T12:00:00Z']) {
      for (const field of ['startDate', 'endDate']) expect((await get(endpoint, s.tokens.manager, '?' + field + '=' + value)).statusCode).toBe(400);
    }
    for (const query of ['?startDate=2026-10-12&endDate=2026-10-11', '?startDate=2026-10-12T01:00:00Z&endDate=2026-10-12T00:00:00Z', '?startDate=2026-10-10&startDate=2026-10-10', '?endDate=2026-10-10&endDate=2026-10-11']) expect((await get(endpoint, s.tokens.manager, query)).statusCode).toBe(400);
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2024-02-29&endDate=2024-02-29'), []);
  });

  it.each(endpoints)('%s selects all equivalent second spellings with exact instant bounds before decrypt and ignores client dateComparison', async (endpoint) => {
    const s = await setup();
    const rows = ['', '.0', '.00', '.000'].map((fraction, index) => s.create('site one', 'Same instant ' + index, index + 1, { type: 'income', date: `2026-10-12T12:00:00${fraction}Z`, party: 'Same instant contributor' }).transaction);
    const before = s.create('site one', 'Corrupt one millisecond before', 100, { date: '2026-10-12T11:59:59.999Z' }).transaction;
    const after = s.create('site one', 'Corrupt one millisecond after', 200, { date: '2026-10-12T12:00:00.001Z' }).transaction;
    const foreign = s.create('site2', 'Corrupt foreign same instant', 300, { date: '2026-10-12T12:00:00Z' }).transaction;
    for (const row of [before, after, foreign]) s.db.update(transactions).set({ titleEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, row.id)).run();
    for (const fraction of ['', '.0', '.00', '.000']) {
      const instant = `2026-10-12T12:00:00${fraction}Z`;
      const query = `?startDate=${instant}&endDate=${instant}`;
      expectRows(endpoint, await get(endpoint, s.tokens.manager, query), rows);
      // A client must not restore lexical ordering or supply a SQL expression.
      for (const attack of ['&dateComparison=lexical', '&dateComparison=instant&dateComparison=lexical', '&dateComparison=' + encodeURIComponent("instant'); SELECT 1; --")]) {
        expectRows(endpoint, await get(endpoint, s.tokens.manager, query + attack), rows);
      }
    }
    // Prove the excluded ciphertext is actually invalid, not a harmless fixture.
    for (const query of [
      '?startDate=2026-10-12T11:59:59.999Z&endDate=2026-10-12T12:00:00Z',
      '?startDate=2026-10-12T12:00:00Z&endDate=2026-10-12T12:00:00.001Z',
    ]) {
      const response = await get(endpoint, s.tokens.manager, query);
      expect(response.statusCode).toBe(500); expect(JSON.parse(response.body)).toEqual(genericError);
    }
    const response = await get(endpoint, s.tokens.admin, '?startDate=2026-10-12T12:00:00Z&endDate=2026-10-12T12:00:00Z');
    expect(response.statusCode).toBe(500); expect(JSON.parse(response.body)).toEqual(genericError);
  });

  it.each(endpoints)('%s preserves adjacent milliseconds and inclusive fractional instant boundaries', async (endpoint) => {
    const s = await setup();
    const rows = ['.099', '.1', '.10', '.100', '.101'].map((fraction, index) => s.create('site one', 'Fraction boundary ' + index, index + 1, { date: `2026-10-12T12:00:00${fraction}Z` }).transaction);
    for (const fraction of ['.1', '.10', '.100']) {
      const instant = `2026-10-12T12:00:00${fraction}Z`;
      expectRows(endpoint, await get(endpoint, s.tokens.manager, `?startDate=${instant}&endDate=${instant}`), rows.slice(1, 4));
    }
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12T12:00:00.099Z&endDate=2026-10-12T12:00:00.101Z'), rows);
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12T12:00:00.100Z&endDate=2026-10-12T12:00:00.101Z'), rows.slice(1));
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12T12:00:00.099Z&endDate=2026-10-12T12:00:00.100Z'), rows.slice(0, 4));
  });

  it.each(endpoints)('%s treats stored dates as UTC midnight and covers all last-second forms through a date-only end day', async (endpoint) => {
    const s = await setup();
    const dates = [
      '2026-10-12', ...['', '.0', '.00', '.000'].map(f => `2026-10-12T00:00:00${f}Z`),
      ...['', '.0', '.00', '.000', '.9', '.99', '.999'].map(f => `2026-10-12T23:59:59${f}Z`),
    ];
    const rows = dates.map((date, index) => s.create('site one', 'UTC day boundary ' + index, index + 1, { date }).transaction);
    const before = s.create('site one', 'Corrupt previous day', 1000, { date: '2026-10-11T23:59:59.999Z' }).transaction;
    const next = s.create('site one', 'Corrupt next day', 2000, { date: '2026-10-13T00:00:00Z' }).transaction;
    for (const row of [before, next]) s.db.update(transactions).set({ amountEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, row.id)).run();
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12&endDate=2026-10-12'), rows);
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12T00:00:00Z&endDate=2026-10-12T23:59:59.999Z'), rows);
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12T00:00:00.000Z&endDate=2026-10-12T00:00:00Z'), rows.slice(0, 5));
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12T23:59:59Z&endDate=2026-10-12T23:59:59.000Z'), rows.slice(5, 9));
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?startDate=2026-10-12T23:59:59.990Z&endDate=2026-10-12T23:59:59.999Z'), rows.slice(10));
    for (const [fraction, count] of [['.9', 10], ['.99', 11], ['.999', 12]] as const) {
      expectRows(endpoint, await get(endpoint, s.tokens.manager, `?startDate=2026-10-12&endDate=2026-10-12T23:59:59${fraction}Z`), rows.slice(0, count));
    }
  });

  it.each(endpoints)('%s applies membership revoke to the same token and again after authentication', async (endpoint) => {
    const s = await setup();
    expectRows(endpoint, await get(endpoint, s.tokens.manager), s.visible);
    removeMembership(s.db);
    expectRows(endpoint, await get(endpoint, s.tokens.manager), []);
    expect((await get(endpoint, s.tokens.manager, '?projectId=site%20one')).statusCode).toBe(404);
    s.db.insert(projectMemberships).values({ userId: 'manager', projectId: 'site one', createdAt: new Date().toISOString() }).run();
    expectRows(endpoint, await duringFresh(tx => removeMembership(tx), () => get(endpoint, s.tokens.manager)), []);
  });

  it.each(endpoints)('%s rechecks an admin downgrade after authentication in the same read transaction', async (endpoint) => {
    const s = await setup();
    s.db.insert(projectMemberships).values({ userId: 'admin', projectId: 'site one', createdAt: new Date().toISOString() }).run();
    const r = await duringFresh((tx, uid) => { expect(uid).toBe('admin'); tx.update(users).set({ role: 'viewer' }).where(eq(users.id, uid)).run(); }, () => get(endpoint, s.tokens.admin));
    expectRows(endpoint, r, s.visible);
    expect(r.body).not.toContain('Foreign contributor'); expect(r.body).not.toContain('Legacy contributor');
  });

  for (const state of ['revoked', 'inactive', 'invalid-role', 'missing-session', 'changed-expiry'] as const) {
    it.each(endpoints)(`%s rejects ${state} after authentication with SESSION_INVALID`, async (endpoint) => {
      const s = await setup();
      const r = await duringFresh((tx, uid, sid, expiry) => {
        if (state === 'revoked') tx.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, sid)).run();
        if (state === 'inactive') tx.update(users).set({ isActive: false }).where(eq(users.id, uid)).run();
        if (state === 'invalid-role') tx.update(users).set({ role: 'invalid' }).where(eq(users.id, uid)).run();
        if (state === 'missing-session') tx.delete(authSessions).where(eq(authSessions.id, sid)).run();
        if (state === 'changed-expiry') tx.update(authSessions).set({ expiresAt: expiry + 1 }).where(eq(authSessions.id, sid)).run();
      }, () => get(endpoint, s.tokens.manager));
      expect(r.statusCode).toBe(401); expect(JSON.parse(r.body)).toMatchObject({ code: 'SESSION_INVALID' });
      expect(r.body).not.toContain('Visible');
    });
  }

  for (const secondsPastExpiry of [0, 1]) {
    it.each(endpoints)(`%s rejects expiry at boundary +${secondsPastExpiry}s after authentication`, async (endpoint) => {
      const s = await setup(); let clock: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const r = await duringFresh((_tx, _uid, _sid, expiry) => { expect(expiry).toBe(s.sessions.manager.expiresAt); clock = vi.spyOn(Date, 'now').mockReturnValue((expiry + secondsPastExpiry) * 1000); }, () => get(endpoint, s.tokens.manager));
        expect(r.statusCode).toBe(401); expect(JSON.parse(r.body).code).toBe('SESSION_INVALID');
      } finally { clock?.mockRestore(); }
    });
  }

  it.each(endpoints)('%s requires authentication and rejects a revoked session on the next request', async (endpoint) => {
    const s = await setup();
    expect((await get(endpoint)).statusCode).toBe(401);
    expect((await get(endpoint, 'not-a-token')).statusCode).toBe(401);
    s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, s.sessions.manager.id)).run();
    const r = await get(endpoint, s.tokens.manager); expect(r.statusCode).toBe(401); expect(JSON.parse(r.body).code).toBe('SESSION_INVALID');
  });

  it.each(endpoints)('%s never decrypts foreign/deleted ciphertext, but fails generically on authorized corruption', async (endpoint) => {
    const s = await setup();
    for (const row of [s.b, s.bi, s.trash, s.trashB, s.legacy, s.li]) s.db.update(transactions).set({ amountEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, row.id)).run();
    expectRows(endpoint, await get(endpoint, s.tokens.manager, '?includeDeleted=true'), s.visible);
    expectRows(endpoint, await get(endpoint, s.tokens.unassigned), []);
    expectRows(endpoint, await get(endpoint, s.tokens.admin, '?projectId=site%20one'), s.visible);
    expect((await get(endpoint, s.tokens.manager, '?projectId=site2')).statusCode).toBe(404);
    const global = await get(endpoint, s.tokens.admin); expect(global.statusCode).toBe(500); expect(JSON.parse(global.body)).toEqual(genericError);
    s.db.update(transactions).set({ titleEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, s.a.id)).run();
    const own = await get(endpoint, s.tokens.manager); expect(own.statusCode).toBe(500); expect(JSON.parse(own.body)).toEqual(genericError);
    for (const text of ['enc:v1', 'corrupt', 'Visible expense', 'Foreign expense', config.masterKey]) expect(own.body).not.toContain(text);
  });

  it('checks fresh actor, current scope and scoped repository on the identical synchronous transaction for all three endpoints', async () => {
    const s = await setup();
    const originalFresh = app.projectAccess.requireFreshActor, originalScope = app.projectAccess.resolveScopeInTx;
    const originalList = TransactionRepository.prototype.listTransactionsInScope;
    let currentTx: any; const order: string[] = [];
    app.projectAccess.requireFreshActor = function (tx: any, ...args: any[]) { currentTx = tx; order.push('fresh'); return originalFresh.call(this, tx, ...args); };
    app.projectAccess.resolveScopeInTx = function (tx: any, ...args: any[]) { expect(tx).toBe(currentTx); order.push('scope'); return originalScope.call(this, tx, ...args); };
    const listSpy = vi.spyOn(TransactionRepository.prototype, 'listTransactionsInScope').mockImplementation(function (this: any, ...args) { expect(this.db).toBe(currentTx); expect(args[0]).toEqual({ dateComparison: 'instant', startDate: undefined, endDate: undefined }); order.push('scoped-read'); return originalList.apply(this, args); });
    try {
      for (const endpoint of endpoints) { order.length = 0; expectRows(endpoint, await get(endpoint, s.tokens.manager), s.visible); expect(order).toEqual(['fresh', 'scope', 'scoped-read']); }
    } finally { listSpy.mockRestore(); app.projectAccess.requireFreshActor = originalFresh; app.projectAccess.resolveScopeInTx = originalScope; }
  });

  it.each(endpoints)('%s returns only the generic body for unexpected sensitive exceptions', async (endpoint) => {
    const s = await setup();
    const spy = vi.spyOn(TransactionRepository.prototype, 'listTransactionsInScope').mockImplementation(() => { throw new Error('synthetic-sensitive-title / enc:v1:synthetic-payload'); });
    try {
      const r = await get(endpoint, s.tokens.manager);
      expect(r.statusCode).toBe(500); expect(JSON.parse(r.body)).toEqual(genericError);
      expect(r.body).not.toContain('synthetic-sensitive-title'); expect(r.body).not.toContain('enc:v1');
    } finally { spy.mockRestore(); }
  });

  it('isolates Oto-Kasa/person identities and does not traverse a foreign corrupted link', async () => {
    const s = await setup();
    const own = s.create('site one', 'Own personal expense', 25, { paymentSource: 'person_out_of_pocket', payerPersonName: 'Visible person' });
    const foreign = s.create('site2', 'Foreign personal expense', 65, { paymentSource: 'person_out_of_pocket', payerPersonName: 'Hidden person' });
    const sameName = s.create('site2', 'Same name foreign income', 80, { type: 'income', payerPersonName: 'Visible person' }).transaction;
    const expected = [...s.visible, own.transaction, own.otoKasaTransaction];
    s.db.update(transactions).set({ otoKasaTransactionId: foreign.otoKasaTransaction.id }).where(eq(transactions.id, own.transaction.id)).run();
    for (const row of [foreign.transaction, foreign.otoKasaTransaction, sameName]) s.db.update(transactions).set({ amountEncrypted: 'enc:v1:corrupt' }).where(eq(transactions.id, row.id)).run();
    for (const endpoint of endpoints) {
      const r = await get(endpoint, s.tokens.manager); expectRows(endpoint, r, expected);
      for (const text of ['Hidden person', 'Foreign personal expense', 'Same name foreign income']) expect(r.body).not.toContain(text);
      if (endpoint === 'balance') expect(JSON.parse(r.body).personContributions.find((p: any) => p.personName === 'Visible person')).toEqual({ personName: 'Visible person', directKasaAmount: 0, otoKasaAmount: 25, totalAmount: 25, transactionCount: 1 });
    }
  });

  it('preserves scoped CSV BOM, header, quoting, delimiter, numeric amounts and text neutralization', async () => {
    const s = await setup();
    const dangerCategory = await app.categoryRepo.createCategory({ name: '=Danger; "cat"' });
    const title = '=2+5; "x"\r\nline2';
    s.create('site one', title, 123.5, { type: 'income', categoryId: dangerCategory.id, currency: '=TX', party: '\t@party', description: ' \uFF1Dfull' });
    const r = await get('export/csv', s.tokens.manager);
    expect(r.statusCode).toBe(200); expect(r.body.charCodeAt(0)).toBe(0xFEFF);
    expect(r.body).toContain('"Metin: =2+5; ""x""\r\nline2";123.5;"Metin: =TX";"Metin: =Danger; ""cat""";"Metin: \t@party";"Metin:  \uFF1Dfull"');
    expect(r.body.split('\r\n')[0]).toBe(csvHeader);
    expect(r.body).not.toContain('Foreign expense'); expect(r.body).not.toContain('Legacy expense');
    const stored = app.transactionRepo.listTransactionsInScope({ projectId: 'site one' }, { all: true }, config.masterKey, config.blindIndexPepper);
    expect(stored.find((row: any) => row.title === title).currency).toBe('=TX');
  });
});
