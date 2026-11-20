import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { accounts, auditLogs, authSessions, categories, projectMemberships, projects, TransactionRepository, transactions, users } from '@cost-core/database';
import { buildApp } from '../src/app.js';
import * as source from '../src/import-source.js';

// Every fixture, session, workbook and failure trigger is synthetic/in-memory.
const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
const endpoints = ['analyze', 'execute'] as const;
type Endpoint = typeof endpoints[number];
const mapping = { dateCol: 0, titleCol: 1, amountCol: 2, categoryCol: 3, subCategoryCol: 4, partyCol: 5, isPaidCol: 6, payerPersonCol: 7 };
const rows = [
  ['Date', 'Title', 'Amount', 'Category', 'Subcategory', 'Party', 'Paid', 'Payer'],
  ['2026-01-01', ' Synthetic company expense ', 'TRY 10.50', 'Synthetic root', 'Synthetic child', ' Synthetic supplier ', 'true', ''],
  ['2026-01-02', 'Synthetic personal expense', 20, 'Synthetic second', '', '', 'bekliyor', '✅🔗 Synthetic payer'],
];
function workbook(data: any[][] = rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), 'Synthetic');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
const genericError = { error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' };
let app: any;
afterEach(async () => { vi.restoreAllMocks(); if (app) { await app.close(); app = undefined; } });
const post = (endpoint: Endpoint | 'karaelmas', token?: string, extra: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/api/import/' + endpoint, headers: token ? { authorization: 'Bearer ' + token } : {}, payload: { base64: workbook().toString('base64'), projectId: 'site2', mapping, ...extra } });
function snapshot() {
  return {
    projects: app.db.select().from(projects).orderBy(projects.id).all(),
    categories: app.db.select().from(categories).orderBy(categories.id).all(),
    transactions: app.db.select().from(transactions).orderBy(transactions.id).all(),
    accounts: app.db.select().from(accounts).orderBy(accounts.id).all(),
    audit: app.db.select().from(auditLogs).orderBy(auditLogs.id).all(),
  };
}
async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const db = app.db, now = new Date().toISOString();
  for (const id of ['site1', 'site2']) db.insert(projects).values({ id, name: id, budget: 0, currency: 'TRY', status: 'active', createdAt: now, updatedAt: now }).run();
  const tokens: Record<string, string> = {}, sessions: Record<string, any> = {};
  for (const id of ['admin', 'manager', 'accountant', 'auditor', 'viewer', 'unassigned-manager', 'unassigned-accountant']) {
    const role = id.replace('unassigned-', '');
    db.insert(users).values({ id, username: id, email: id + '@example.test', fullName: 'Synthetic', passwordHash: 'synthetic-hash', role, isActive: true, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(id); sessions[id] = session;
    tokens[id] = app.jwt.sign({ id, username: id, role, sid: session.id, exp: session.expiresAt });
    if (id !== 'admin' && !id.startsWith('unassigned-')) db.insert(projectMemberships).values({ userId: id, projectId: 'site2', createdAt: now }).run();
  }
  return { db, tokens, sessions };
}
function sourceSpies() {
  return { resolve: vi.spyOn(source, 'resolveImportSource'), parse: vi.spyOn(source, 'readWorkbookBounded'), rows: vi.spyOn(source, 'sheetRows'), fetch: vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected synthetic network call')) };
}
function expectNoSource(spies: ReturnType<typeof sourceSpies>) {
  expect(spies.resolve).not.toHaveBeenCalled(); expect(spies.parse).not.toHaveBeenCalled(); expect(spies.rows).not.toHaveBeenCalled(); expect(spies.fetch).not.toHaveBeenCalled();
}
function denied(response: any, status: number) {
  expect(response.statusCode).toBe(status);
  const body = JSON.parse(response.body);
  if (status === 401) expect(body.code).toBe('SESSION_INVALID');
  for (const key of ['sheets', 'preview', 'importedCount', 'project']) expect(body).not.toHaveProperty(key);
  for (const text of ['Synthetic company', 'Synthetic personal', 'Synthetic payer', 'enc:v1']) expect(response.body).not.toContain(text);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('import admin authorization and explicit project boundary', () => {
  it.each(endpoints)('%s denies all non-admins, including assigned managers/accountants, before source work', async endpoint => {
    const s = await setup(), before = snapshot(), spies = sourceSpies();
    const create = vi.spyOn(TransactionRepository.prototype, 'createTransaction');
    for (const role of ['manager', 'accountant', 'auditor', 'viewer', 'unassigned-manager', 'unassigned-accountant']) {
      denied(await post(endpoint, s.tokens[role], { role: 'admin', userId: 'admin', createdById: 'admin', scope: { all: true }, projectIds: ['site2'] }), 403);
      denied(await post(endpoint, s.tokens[role], { projectId: null, mapping: null, base64: null }), 403);
    }
    expectNoSource(spies); expect(create).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s denies noauth and invalid tokens without fetching or parsing', async endpoint => {
    await setup(); const before = snapshot(), spies = sourceSpies();
    denied(await post(endpoint), 401); denied(await post(endpoint, 'invalid-token'), 401);
    expectNoSource(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s ignores stale signed roles and same-token admin downgrade', async endpoint => {
    const s = await setup(), spies = sourceSpies();
    s.db.update(users).set({ role: 'manager' }).where(eq(users.id, 'admin')).run();
    s.db.insert(projectMemberships).values({ userId: 'admin', projectId: 'site2', createdAt: new Date().toISOString() }).run();
    const forged = app.jwt.sign({ id: 'manager', role: 'admin', username: 'manager', sid: s.sessions.manager.id, exp: s.sessions.manager.expiresAt });
    const before = snapshot();
    denied(await post(endpoint, s.tokens.admin), 403); denied(await post(endpoint, forged), 403);
    expectNoSource(spies); expect(snapshot()).toEqual(before);
  });

  it.each([undefined, null, '', ' \t\n', [], ['site2'], {}, 42, false, 'x'.repeat(129)].map(projectId => ({ projectId })))('execute rejects malformed/missing target $projectId before any source work', async ({ projectId }) => {
    const s = await setup(), before = snapshot(), spies = sourceSpies();
    denied(await post('execute', s.tokens.admin, { projectId }), 400);
    expectNoSource(spies); expect(snapshot()).toEqual(before);
  });

  it.each(['missing-project', ' site2 '])('execute never falls back from unknown opaque target %j', async projectId => {
    const s = await setup(), before = snapshot(), spies = sourceSpies();
    denied(await post('execute', s.tokens.admin, { projectId }), 404);
    expectNoSource(spies); expect(snapshot()).toEqual(before);
  });

  it('does not auto-create a project in an empty project store', async () => {
    const s = await setup(); s.db.delete(projects).run();
    const before = snapshot(), spies = sourceSpies();
    denied(await post('execute', s.tokens.admin), 404);
    denied(await post('execute', s.tokens.admin, { projectId: undefined }), 400);
    expectNoSource(spies); expect(snapshot()).toEqual(before);
  });

  it('admin analyzes without mutations and executes only the explicit target with existing conversion/OTO semantics', async () => {
    const s = await setup(), before = snapshot(), spies = sourceSpies();
    const analyze = await post('analyze', s.tokens.admin);
    expect(analyze.statusCode).toBe(200);
    expect(JSON.parse(analyze.body)).toEqual({ success: true, sheets: [{ sheetName: 'Synthetic', headers: rows[0], totalRows: 2, preview: rows.slice(1) }] });
    expect(snapshot()).toEqual(before);
    const response = await post('execute', s.tokens.admin, { role: 'viewer', userId: 'manager', createdById: 'manager', scope: { all: false, projectIds: ['site1'] }, projectIds: ['site1'], targetProjectId: 'site1' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ success: true, importedCount: 2, project: { id: 'site2' } });
    const imported = app.transactionRepo.listTransactionsInScope({}, { all: true }, config.masterKey, config.blindIndexPepper);
    expect(imported).toHaveLength(3);
    expect(imported.every((r: any) => r.projectId === 'site2' && r.createdById === 'admin')).toBe(true);
    const company = imported.find((r: any) => r.title === 'Synthetic company expense');
    const personal = imported.find((r: any) => r.title === 'Synthetic personal expense');
    const oto = imported.find((r: any) => r.type === 'income');
    expect(company).toMatchObject({ date: '2026-01-01T00:00:00.000Z', amount: 10.5, currency: 'TRY', exchangeRate: 1, paymentMethod: 'Banka', party: 'Synthetic supplier', isPaid: true, status: 'approved', paymentSource: 'company_account' });
    expect(personal).toMatchObject({ amount: 20, isPaid: false, status: 'pending', paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic payer', otoKasaTransactionId: oto.id });
    expect(oto).toMatchObject({ title: '🔗 Oto-Kasa: Synthetic personal expense', amount: 20, otoKasaTransactionId: personal.id });
    const cats = s.db.select().from(categories).all(), root = cats.find((c: any) => c.name === 'Synthetic root'), child = cats.find((c: any) => c.name === 'Synthetic child');
    expect(child).toMatchObject({ parentId: root.id, code: null, description: null, budget: 0, color: '#2563EB', icon: 'folder', orderIndex: 0, customFieldIds: '[]', isActive: true });
    expect(company.categoryId).toBe(child.id);
    expect(snapshot().projects).toEqual(before.projects); expect(spies.fetch).not.toHaveBeenCalled();
  });

  it('accepts an opaque 128-character target verbatim, without trimming', async () => {
    const s = await setup(), id = ' ' + 'x'.repeat(126) + ' ', now = new Date().toISOString();
    s.db.insert(projects).values({ id, name: 'Synthetic opaque', createdAt: now, updatedAt: now }).run();
    const before = snapshot().projects, response = await post('execute', s.tokens.admin, { projectId: id });
    expect(response.statusCode).toBe(200); expect(JSON.parse(response.body).project.id).toBe(id);
    expect(snapshot().transactions.every((r: any) => r.projectId === id)).toBe(true); expect(snapshot().projects).toEqual(before);
  });

  it('retains legacy karaelmas 403 without effects', async () => {
    const s = await setup(), before = snapshot(), spies = sourceSpies();
    const response = await post('karaelmas', s.tokens.admin);
    expect(response.statusCode).toBe(403); expect(JSON.parse(response.body).error).toContain('dosya');
    expectNoSource(spies); expect(snapshot()).toEqual(before);
  });
});

describe('fresh authorization across asynchronous source loading', () => {
  for (const state of ['revoked', 'downgraded', 'inactive', 'expired', 'past-expiry', 'missing-session', 'changed-expiry'] as const) {
    it.each(endpoints)(`%s rejects ${state} while source is awaited, without preview or writes`, async endpoint => {
      const s = await setup(), entered = deferred<void>(), release = deferred<Buffer>(), before = snapshot();
      const resolve = vi.spyOn(source, 'resolveImportSource').mockImplementation(() => { entered.resolve(); return release.promise; });
      const create = vi.spyOn(TransactionRepository.prototype, 'createTransaction');
      const responsePromise = Promise.resolve(post(endpoint, s.tokens.admin));
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      try {
        await entered.promise;
        if (state === 'revoked') s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, s.sessions.admin.id)).run();
        if (state === 'downgraded') s.db.update(users).set({ role: 'accountant' }).where(eq(users.id, 'admin')).run();
        if (state === 'inactive') s.db.update(users).set({ isActive: false }).where(eq(users.id, 'admin')).run();
        if (state === 'expired' || state === 'past-expiry') clock = vi.spyOn(Date, 'now').mockReturnValue((s.sessions.admin.expiresAt + (state === 'past-expiry' ? 1 : 0)) * 1000);
        if (state === 'missing-session') s.db.delete(authSessions).where(eq(authSessions.id, s.sessions.admin.id)).run();
        if (state === 'changed-expiry') s.db.update(authSessions).set({ expiresAt: s.sessions.admin.expiresAt + 1 }).where(eq(authSessions.id, s.sessions.admin.id)).run();
        release.resolve(workbook());
        denied(await responsePromise, state === 'downgraded' ? 403 : 401);
        expect(resolve).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
      } finally { release.resolve(workbook()); clock?.mockRestore(); }
    });
  }

  it('rechecks a target deleted during source await instead of falling back', async () => {
    const s = await setup(), entered = deferred<void>(), release = deferred<Buffer>();
    vi.spyOn(source, 'resolveImportSource').mockImplementation(() => { entered.resolve(); return release.promise; });
    const create = vi.spyOn(TransactionRepository.prototype, 'createTransaction');
    const responsePromise = Promise.resolve(post('execute', s.tokens.admin));
    await entered.promise; s.db.delete(projects).where(eq(projects.id, 'site2')).run(); const before = snapshot();
    release.resolve(workbook()); denied(await responsePromise, 404);
    expect(create).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
  });

  for (const state of ['revoked', 'downgraded'] as const) {
    it.each(endpoints)(`%s performs genuine initial fresh check after authentication (${state})`, async endpoint => {
      const s = await setup(), before = snapshot(), spies = sourceSpies();
      const original = app.projectAccess.requireFreshAdmin;
      const fresh = vi.spyOn(app.projectAccess, 'requireFreshAdmin').mockImplementation(function (this: any, tx: any, ...args: any[]) {
        expect(tx).not.toBe(s.db);
        if (state === 'revoked') tx.update(authSessions).set({ revokedAt: 1 }).where(eq(authSessions.id, s.sessions.admin.id)).run();
        else tx.update(users).set({ role: 'manager' }).where(eq(users.id, 'admin')).run();
        return original.call(this, tx, ...args);
      });
      denied(await post(endpoint, s.tokens.admin), state === 'revoked' ? 401 : 403);
      expect(fresh).toHaveBeenCalledTimes(1); expectNoSource(spies); expect(snapshot()).toEqual(before);
    });
  }

  it.each(endpoints)('%s uses synchronous initial/final transactions; source/parser outside, execute writes in the final immediate tx', async endpoint => {
    const s = await setup(), originalTransaction = s.db.transaction, originalFresh = app.projectAccess.requireFreshAdmin;
    const originalCreate = TransactionRepository.prototype.createTransaction, originalTarget = app.projectRepo.getProjectByIdInTx;
    const originalResolve = source.resolveImportSource, originalParse = source.readWorkbookBounded;
    let currentTx: any, finalTx: any; const events: string[] = [], options: any[] = [];
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => originalTransaction.call(s.db, (tx: any) => {
      expect(currentTx).toBeUndefined(); currentTx = tx; options.push(args[0]);
      try { const result = callback(tx); expect(result).not.toBeInstanceOf(Promise); return result; }
      finally { currentTx = undefined; }
    }, ...args));
    vi.spyOn(app.projectAccess, 'requireFreshAdmin').mockImplementation(function (this: any, tx: any, ...args: any[]) {
      expect(tx).toBe(currentTx); expect(tx).not.toBe(s.db); finalTx = tx;
      events.push('fresh'); return originalFresh.call(this, tx, ...args);
    });
    vi.spyOn(app.projectRepo, 'getProjectByIdInTx').mockImplementation(function (this: any, tx: any, ...args: any[]) {
      expect(tx).toBe(currentTx); events.push('target'); return originalTarget.call(this, tx, ...args);
    });
    vi.spyOn(source, 'resolveImportSource').mockImplementation((...args) => {
      expect(currentTx).toBeUndefined(); events.push('source'); return originalResolve(...args);
    });
    vi.spyOn(source, 'readWorkbookBounded').mockImplementation((...args) => {
      expect(currentTx).toBeUndefined(); return originalParse(...args);
    });
    const create = vi.spyOn(TransactionRepository.prototype, 'createTransaction').mockImplementation(function (this: any, ...args) {
      expect(this.db).toBe(currentTx); expect(this.db).toBe(finalTx); expect(events.slice(-2)).toEqual(['fresh', 'target']);
      return originalCreate.apply(this, args);
    });
    expect((await post(endpoint, s.tokens.admin)).statusCode).toBe(200);
    expect(options).toHaveLength(2);
    expect(events).toEqual(endpoint === 'execute' ? ['fresh', 'target', 'source', 'fresh', 'target'] : ['fresh', 'source', 'fresh']);
    if (endpoint === 'execute') { expect(options[1]).toEqual({ behavior: 'immediate' }); expect(create).toHaveBeenCalledTimes(2); }
    else expect(create).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'downgraded', 'deleted-target'] as const)('execute rechecks %s inside the actual write transaction before categories or records', async state => {
    const s = await setup(), before = snapshot(), originalFresh = app.projectAccess.requireFreshAdmin;
    const resolve = vi.spyOn(source, 'resolveImportSource'), create = vi.spyOn(TransactionRepository.prototype, 'createTransaction');
    let calls = 0;
    vi.spyOn(app.projectAccess, 'requireFreshAdmin').mockImplementation(function (this: any, tx: any, ...args: any[]) {
      calls++; expect(tx).not.toBe(s.db);
      if (calls === 2) {
        if (state === 'revoked') tx.update(authSessions).set({ revokedAt: 1 }).where(eq(authSessions.id, s.sessions.admin.id)).run();
        if (state === 'downgraded') tx.update(users).set({ role: 'accountant' }).where(eq(users.id, 'admin')).run();
        if (state === 'deleted-target') tx.delete(projects).where(eq(projects.id, 'site2')).run();
      }
      return originalFresh.call(this, tx, ...args);
    });
    denied(await post('execute', s.tokens.admin), state === 'deleted-target' ? 404 : state === 'downgraded' ? 403 : 401);
    expect(calls).toBe(2); expect(resolve).toHaveBeenCalledTimes(1); expect(create).not.toHaveBeenCalled();
    // Hook mutations also roll back, demonstrating a real transaction rather
    // than a check against an unbound/global database handle.
    expect(snapshot()).toEqual(before);
    expect(s.db.select().from(users).where(eq(users.id, 'admin')).get().role).toBe('admin');
    expect(s.db.select().from(authSessions).where(eq(authSessions.id, s.sessions.admin.id)).get().revokedAt).toBeNull();
  });
});

describe('import source errors and whole-batch rollback', () => {
  it('execute checks source errors with an explicit VALID target (not project-validation short circuits)', async () => {
    const s = await setup(), before = snapshot(), spies = sourceSpies();
    const valid = workbook().toString('base64');
    const cases = [
      { base64: undefined },
      { base64: '!!!' },
      { base64: valid, sheetsUrl: 'https://docs.google.com/spreadsheets/d/synthetic/export?format=csv' },
      { base64: Buffer.alloc(source.MAX_SOURCE_BYTES + 1, 65).toString('base64') },
      { base64: undefined, sheetsUrl: 'https://example.test/not-google' },
      { base64: valid, sheetName: 'Missing' },
      { base64: workbook([['header']]).toString('base64') },
      { base64: workbook([Array.from({ length: 101 }, (_, i) => 'h' + i), ['v']]).toString('base64') },
    ];
    for (const extra of cases) { denied(await post('execute', s.tokens.admin, extra), 400); expect(snapshot()).toEqual(before); }
    // The oversized encoded payload remains below the route's 8MiB body limit.
    expect(spies.resolve).toHaveBeenCalledTimes(cases.length); expect(spies.fetch).not.toHaveBeenCalled();
  });

  it('a second-row repository failure rolls back preceding main/OTO rows and all categories', async () => {
    const s = await setup(), before = snapshot(), original = TransactionRepository.prototype.createTransaction;
    let calls = 0;
    vi.spyOn(TransactionRepository.prototype, 'createTransaction').mockImplementation(function (this: any, ...args) {
      calls++;
      const result = original.apply(this, args);
      if (calls === 2) {
        expect(this.db.select().from(transactions).all()).toHaveLength(3);
        throw new Error('Synthetic private person / enc:v1:payload');
      }
      return result;
    });
    const response = await post('execute', s.tokens.admin);
    expect(response.statusCode).toBe(500); expect(JSON.parse(response.body)).toEqual(genericError);
    expect(calls).toBe(2); expect(snapshot()).toEqual(before);
  });

  it.each([
    { calls: 1, trigger: sql`CREATE TRIGGER synthetic_import_category_failure BEFORE INSERT ON categories WHEN NEW.name = 'Synthetic second' BEGIN SELECT RAISE(ABORT, 'synthetic category failure'); END;` },
    { calls: 2, trigger: sql`CREATE TRIGGER synthetic_import_oto_failure BEFORE INSERT ON transactions WHEN NEW.type = 'income' BEGIN SELECT RAISE(ABORT, 'synthetic OTO failure'); END;` },
  ])('a real mid-batch category/OTO insert failure rolls back the entire import %#', async ({ trigger, calls }) => {
    const s = await setup(), before = snapshot(); s.db.run(trigger);
    const create = vi.spyOn(TransactionRepository.prototype, 'createTransaction');
    const response = await post('execute', s.tokens.admin);
    expect(response.statusCode).toBe(500); expect(JSON.parse(response.body)).toEqual(genericError);
    expect(create).toHaveBeenCalledTimes(calls); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s masks unexpected fresh-check exceptions as generic 500', async endpoint => {
    const s = await setup(), before = snapshot(), spies = sourceSpies();
    vi.spyOn(app.projectAccess, 'requireFreshAdmin').mockImplementation(() => { throw new Error('Synthetic private person / enc:v1:payload'); });
    const response = await post(endpoint, s.tokens.admin);
    expect(response.statusCode).toBe(500); expect(JSON.parse(response.body)).toEqual(genericError);
    expectNoSource(spies); expect(snapshot()).toEqual(before);
  });
});
