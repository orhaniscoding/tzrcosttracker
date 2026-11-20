import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as crypto from '@cost-core/crypto';
import { PartyTypeSchema } from '@cost-core/types';
import { AuditLogRepository, users, projects, parties, auditLogs, authSessions, projectMemberships } from '@cost-core/database';
import { buildApp } from '../src/app.js';

// Spyable ESM wrapper, retaining real blind indexing and audit encryption.
vi.mock('@cost-core/crypto', async importOriginal => ({
  ...await importOriginal<typeof import('@cost-core/crypto')>(),
}));

// Synthetic memory-only fixtures; no files, network or production data.
const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
const endpoints = ['list', 'create', 'delete'] as const;
type Endpoint = typeof endpoints[number];
const nonadmins = ['manager', 'accountant', 'auditor', 'viewer'].flatMap(role => [role, 'unassigned-' + role]);
const genericError = { error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' };
let app: any;
afterEach(async () => { vi.restoreAllMocks(); if (app) { await app.close(); app = undefined; } });

async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' });
  await app.ready();
  const db = app.db, now = '2026-01-01T00:00:00.000Z';
  for (const id of ['site1', 'site2']) db.insert(projects).values({ id, name: id, createdAt: now, updatedAt: now }).run();
  const tokens: Record<string, string> = {}, sessions: Record<string, any> = {};
  for (const id of ['admin', ...nonadmins]) {
    const role = id.replace('unassigned-', '');
    db.insert(users).values({ id, username: id, email: id + '@example.test', fullName: 'Synthetic user', passwordHash: 'synthetic-hash', role, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(id); sessions[id] = session;
    tokens[id] = app.jwt.sign({ id, username: id, role, sid: session.id, exp: session.expiresAt });
    if (id !== 'admin' && !id.startsWith('unassigned-')) db.insert(projectMemberships).values({ userId: id, projectId: 'site1', createdAt: now }).run();
  }
  for (const type of PartyTypeSchema.options) db.insert(parties).values({
    id: type, name: 'Synthetic private ' + type, nameBlindIndex: crypto.createBlindIndex(type, config.blindIndexPepper), type,
    phone: 'synthetic-phone', email: 'synthetic@example.test', iban: 'synthetic-iban', taxNo: 'synthetic-tax', taxOffice: 'synthetic-office', notes: 'Synthetic private notes',
    isActive: type !== 'client', createdAt: now, updatedAt: now,
  }).run();
  app.auditRepo.logAction({ userId: 'admin', action: 'CREATE', entity: 'synthetic', entityId: 'fixture', newState: { name: 'Synthetic private audit' } }, config.masterKey);
  return { db, tokens, sessions };
}
function snapshot() {
  return {
    parties: app.db.select().from(parties).orderBy(parties.id).all(),
    auditLogs: app.db.select().from(auditLogs).orderBy(auditLogs.id).all(),
    users: app.db.select().from(users).orderBy(users.id).all(),
    sessions: app.db.select().from(authSessions).orderBy(authSessions.id).all(),
    memberships: app.db.select().from(projectMemberships).orderBy(projectMemberships.userId, projectMemberships.projectId).all(),
  };
}
function send(endpoint: Endpoint, token?: string, value?: any) {
  const smuggling = 'role=admin&userId=admin&projectId=site2&scope=all';
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  if (endpoint === 'list') return app.inject({ method: 'GET', url: '/api/parties?' + (value ?? '') + '&' + smuggling, headers });
  if (endpoint === 'delete') return app.inject({ method: 'DELETE', url: '/api/parties/' + encodeURIComponent(value ?? 'supplier') + '?' + smuggling, headers });
  return app.inject({ method: 'POST', url: '/api/parties?' + smuggling, headers, payload: value ?? { name: 'Synthetic private new party', role: 'admin', userId: 'admin', projectId: 'site2', scope: { all: true } } });
}
function denied(response: any, status: number) {
  expect(response.statusCode).toBe(status);
  const body = JSON.parse(response.body);
  if (status === 401) expect(body.code).toBe('SESSION_INVALID');
  if (status === 500) expect(body).toEqual(genericError);
  expect(Array.isArray(body)).toBe(false);
  for (const text of ['Synthetic private', 'synthetic-iban', 'synthetic-tax', 'synthetic-phone', 'bidx:v1:', 'enc:v1:', 'SQLITE_']) expect(response.body).not.toContain(text);
}
function workSpies() {
  const transaction = app.db.transaction, reads = vi.fn();
  vi.spyOn(app.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => transaction.call(app.db, (tx: any) => {
    const select = tx.select;
    // Actor/session selects are narrow projections, unlike directory/audit reads.
    tx.select = function (this: any, ...selection: any[]) { if (!selection.length) reads(); return select.apply(this, selection); };
    return callback(tx);
  }, ...args));
  return { reads, index: vi.spyOn(crypto, 'createBlindIndex'), audit: vi.spyOn(AuditLogRepository.prototype, 'logAction') };
}
function noWork(spies: ReturnType<typeof workSpies>) {
  expect(spies.reads).not.toHaveBeenCalled(); expect(spies.index).not.toHaveBeenCalled(); expect(spies.audit).not.toHaveBeenCalled();
}
async function duringFresh(mutate: (tx: any, uid: string, sid: string, expiry: number) => void, run: () => Promise<any>) {
  const fresh = app.projectAccess.requireFreshAdmin; let calls = 0;
  app.projectAccess.requireFreshAdmin = function (tx: any, uid: string, sid: string, expiry: number) {
    calls++; expect(tx).not.toBe(app.db); mutate(tx, uid, sid, expiry); return fresh.call(this, tx, uid, sid, expiry);
  };
  try { const response = await run(); expect(calls).toBe(1); return response; }
  finally { app.projectAccess.requireFreshAdmin = fresh; }
}

describe('global party directory: fresh admin only and synchronous atomic audit', () => {
  it.each(endpoints)('%s denies assigned and unassigned nonadmins, even malformed/smuggled inputs, before directory/index/audit', async endpoint => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    for (const role of nonadmins) {
      denied(await send(endpoint, s.tokens[role]), 403);
      denied(await send(endpoint, s.tokens[role], endpoint === 'list' ? 'type=&type=unknown' : endpoint === 'delete' ? '   ' : { name: null, role: 'admin', userId: 'admin', scope: 'all', projectId: 'site1' }), 403);
    }
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s rejects absent/invalid authentication without work', async endpoint => {
    await setup(); const before = snapshot(), spies = workSpies();
    denied(await send(endpoint), 401); denied(await send(endpoint, 'invalid-token'), 401);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s rejects a same-token role downgrade and a forged admin role claim', async endpoint => {
    const s = await setup();
    s.db.update(users).set({ role: 'manager' }).where(eq(users.id, 'admin')).run();
    const forged = app.jwt.sign({ id: 'manager', username: 'manager', role: 'admin', sid: s.sessions.manager.id, exp: s.sessions.manager.expiresAt });
    const before = snapshot(), spies = workSpies();
    denied(await send(endpoint, s.tokens.admin), 403); denied(await send(endpoint, forged), 403);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s rechecks auth-to-transaction downgrade before validation', async endpoint => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    const malformed = endpoint === 'list' ? 'type=' : endpoint === 'delete' ? ' ' : {};
    denied(await duringFresh((tx, uid) => tx.update(users).set({ role: 'manager' }).where(eq(users.id, uid)).run(), () => send(endpoint, s.tokens.admin, malformed)), 403);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  for (const state of ['revoked', 'inactive', 'missing-user', 'invalid-role', 'missing-session', 'changed-expiry'] as const) {
    it.each(endpoints)(`%s rejects ${state} after authentication without directory or mutation`, async endpoint => {
      const s = await setup(), before = snapshot(), spies = workSpies();
      denied(await duringFresh((tx, uid, sid, expiry) => {
        if (state === 'revoked') tx.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, sid)).run();
        if (state === 'inactive') tx.update(users).set({ isActive: false }).where(eq(users.id, uid)).run();
        if (state === 'missing-user') tx.delete(users).where(eq(users.id, uid)).run();
        if (state === 'invalid-role') tx.update(users).set({ role: 'invalid' }).where(eq(users.id, uid)).run();
        if (state === 'missing-session') tx.delete(authSessions).where(eq(authSessions.id, sid)).run();
        if (state === 'changed-expiry') tx.update(authSessions).set({ expiresAt: expiry + 1 }).where(eq(authSessions.id, sid)).run();
      }, () => send(endpoint, s.tokens.admin)), 401);
      noWork(spies); expect(snapshot()).toEqual(before);
    });
  }

  for (const offset of [0, 1]) {
    it.each(endpoints)(`%s rejects exact/elapsed expiry +${offset}s after authentication`, async endpoint => {
      const s = await setup(), before = snapshot(), spies = workSpies(); let clock: ReturnType<typeof vi.spyOn> | undefined;
      try {
        denied(await duringFresh((_tx, _uid, _sid, expiry) => { clock = vi.spyOn(Date, 'now').mockReturnValue((expiry + offset) * 1000); }, () => send(endpoint, s.tokens.admin)), 401);
        noWork(spies); expect(snapshot()).toEqual(before);
      } finally { clock?.mockRestore(); }
    });
  }

  it.each(endpoints)('%s rejects already-revoked sessions before work', async endpoint => {
    const s = await setup();
    s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, s.sessions.admin.id)).run();
    const before = snapshot(), spies = workSpies();
    denied(await send(endpoint, s.tokens.admin), 401); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('lists all existing fields including inactive rows, or strictly filters each enum type', async () => {
    const s = await setup(), before = snapshot();
    const all = await send('list', s.tokens.admin); expect(all.statusCode).toBe(200);
    expect(JSON.parse(all.body).sort((a: any, b: any) => a.id.localeCompare(b.id))).toEqual(before.parties);
    for (const type of PartyTypeSchema.options) {
      const response = await send('list', s.tokens.admin, 'type=' + type);
      expect(response.statusCode).toBe(200); expect(JSON.parse(response.body)).toEqual(before.parties.filter((row: any) => row.type === type));
    }
    expect(snapshot()).toEqual(before);
  });

  it.each(['type=', 'type=unknown', 'type=Supplier', 'type=%20supplier', 'type=supplier%20', 'type=supplier&type=person', 'type=supplier&type=supplier', 'type=null'])('rejects malformed admin query %s without directory work', async query => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send('list', s.tokens.admin, query), 400); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('creates default fields and server metadata while stripping unknown and smuggled server fields', async () => {
    const s = await setup(), before = snapshot();
    const response = await send('create', s.tokens.admin, { name: 'Synthetic private new party', id: 'attacker-id', isActive: false, createdAt: 'attacker-time', updatedAt: 'attacker-time', nameBlindIndex: 'attacker-index', role: 'viewer', userId: 'viewer', scope: { all: true }, projectId: 'site1', unknown: 'ignored' });
    expect(response.statusCode).toBe(201); const row = JSON.parse(response.body);
    expect(row).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'Synthetic private new party', type: 'supplier', phone: null, email: null, iban: null, taxNo: null, taxOffice: null, notes: null, isActive: true, createdAt: expect.any(String), updatedAt: expect.any(String), nameBlindIndex: crypto.createBlindIndex('Synthetic private new party', config.blindIndexPepper) });
    expect(row.id).not.toBe('attacker-id'); expect(row.createdAt).toBe(row.updatedAt); expect(new Date(row.createdAt).toISOString()).toBe(row.createdAt);
    expect(s.db.select().from(parties).where(eq(parties.id, row.id)).get()).toEqual(row);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({ userId: 'admin', action: 'CREATE', entity: 'party', entityId: row.id, previousState: null, newState: row });
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('preserves every accepted field and normalized exact blind-index parity', async () => {
    const s = await setup();
    const input = { name: '  Synthetic private İŞ  ', type: 'subcontractor', phone: 'synthetic-phone', email: 'synthetic@example.test', iban: 'synthetic-iban', taxNo: 'synthetic-tax', taxOffice: 'synthetic-office', notes: 'Synthetic private notes' };
    const response = await send('create', s.tokens.admin, input); expect(response.statusCode).toBe(201);
    const row = JSON.parse(response.body); expect(row).toMatchObject(input);
    expect(row.nameBlindIndex).toBe(crypto.createBlindIndex('synthetic private is', config.blindIndexPepper));
    expect(s.db.select().from(parties).where(eq(parties.id, row.id)).get()).toEqual(row);
    const empty = await send('create', s.tokens.admin, { name: 'Empty optional fields', phone: '', iban: '', taxNo: '', taxOffice: '', notes: '', email: null });
    expect(empty.statusCode).toBe(201); expect(JSON.parse(empty.body)).toMatchObject({ phone: null, iban: null, taxNo: null, taxOffice: null, notes: null, email: null });
  });

  it.each([{}, { name: '' }, { name: null }, { name: [] }, { name: 'x'.repeat(151) }, { name: 'Synthetic private invalid', type: 'unknown' }, { name: 'Synthetic private invalid', email: 'not-email' }, { name: 'Synthetic private invalid', phone: 'x'.repeat(31) }, { name: 'Synthetic private invalid', iban: 'x'.repeat(35) }])('rejects malformed create %j before indexing or audit', async body => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send('create', s.tokens.admin, body), 400); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('deletes with full previousState audit and preserves the success body; missing ID has no audit', async () => {
    const s = await setup(), before = snapshot(), previousState = before.parties.find((row: any) => row.id === 'supplier');
    const response = await send('delete', s.tokens.admin); expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ success: true, message: 'Cari kaydı silindi.' });
    expect(snapshot().parties).toEqual(before.parties.filter((row: any) => row.id !== 'supplier'));
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({ userId: 'admin', action: 'DELETE', entity: 'party', entityId: 'supplier', previousState, newState: null });
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
    const after = snapshot(), audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    denied(await send('delete', s.tokens.admin), 404); denied(await send('delete', s.tokens.admin, 'unknown-party'), 404);
    expect(audit).not.toHaveBeenCalled(); expect(snapshot()).toEqual(after);
  });

  it('accepts a non-UUID opaque 128-character ID and preserves significant surrounding spaces', async () => {
    const s = await setup(), now = '2026-01-01T00:00:00.000Z', boundary = 'opaque_' + 'x'.repeat(121);
    expect(boundary).toHaveLength(128);
    for (const id of [boundary, ' opaque_id ']) {
      s.db.insert(parties).values({ id, name: 'Synthetic private opaque', nameBlindIndex: 'synthetic-index', createdAt: now, updatedAt: now }).run();
      if (id !== id.trim()) {
        const before = snapshot(); denied(await send('delete', s.tokens.admin, id.trim()), 404); expect(snapshot()).toEqual(before);
      }
      expect((await send('delete', s.tokens.admin, id)).statusCode).toBe(200);
      expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0].entityId).toBe(id);
    }
  });

  it.each([' ', '   ', '\t'])('rejects blank ID %j before directory access', async id => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send('delete', s.tokens.admin, id), 400); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('leaves overlong IDs to the existing router 414 guard without directory work', async () => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    expect((await send('delete', s.tokens.admin, 'x'.repeat(129))).statusCode).toBe(414); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(['create', 'delete'] as const)('%s rolls back a real row failure and retries cleanly', async endpoint => {
    const s = await setup(), before = snapshot(), audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    if (endpoint === 'create') s.db.run(sql`CREATE TRIGGER synthetic_party_failure BEFORE INSERT ON parties BEGIN SELECT RAISE(ABORT, 'Synthetic private row failure'); END`);
    else s.db.run(sql`CREATE TRIGGER synthetic_party_failure BEFORE DELETE ON parties BEGIN SELECT RAISE(ABORT, 'Synthetic private row failure'); END`);
    denied(await send(endpoint, s.tokens.admin), 500); expect(snapshot()).toEqual(before); expect(audit).not.toHaveBeenCalled();
    s.db.run(sql`DROP TRIGGER synthetic_party_failure`);
    expect((await send(endpoint, s.tokens.admin)).statusCode).toBe(endpoint === 'create' ? 201 : 200);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
  });

  it.each(['create', 'delete'] as const)('%s rolls back a real audit insert constraint failure and retries', async endpoint => {
    const s = await setup(), before = snapshot();
    s.db.run(sql`CREATE TRIGGER synthetic_party_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'Synthetic private audit failure'); END`);
    denied(await send(endpoint, s.tokens.admin), 500); expect(snapshot()).toEqual(before);
    s.db.run(sql`DROP TRIGGER synthetic_party_audit_failure`);
    expect((await send(endpoint, s.tokens.admin)).statusCode).toBe(endpoint === 'create' ? 201 : 200);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1); expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it.each(['create', 'delete'] as const)('%s rolls back AFTER an actual audit insert with no reflected PII or application error logs, then retries', async endpoint => {
    const s = await setup(), before = snapshot(), original = AuditLogRepository.prototype.logAction;
    const applicationLogs: unknown[] = [];
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...args) => { applicationLogs.push(args); });
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) vi.spyOn(app.log, level).mockImplementation((...args: any[]) => {
      // Ignore only exact Fastify lifecycle envelopes, not arbitrary info calls.
      const keys = args[0] && Object.keys(args[0]).sort().join(',');
      if (level === 'info' && args.length === 2 && ((args[1] === 'incoming request' && keys === 'req') || (args[1] === 'request completed' && keys === 'res,responseTime'))) return;
      applicationLogs.push(args);
    });
    let inserted = false;
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args) {
      const logged = original.apply(this, args);
      expect(this.db.select().from(auditLogs).where(eq(auditLogs.id, logged.id)).get()).toBeDefined();
      const rows = this.db.select().from(parties).all();
      expect(rows).toHaveLength(before.parties.length + (endpoint === 'create' ? 1 : -1));
      inserted = true; throw new Error('Synthetic private failure synthetic-iban synthetic-tax enc:v1:payload');
    });
    denied(await send(endpoint, s.tokens.admin), 500); expect(inserted).toBe(true); expect(audit).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(before); expect(applicationLogs).toEqual([]);
    // logger:false: application call assertions are not enabled-Pino redaction proof.
    audit.mockRestore(); expect((await send(endpoint, s.tokens.admin)).statusCode).toBe(endpoint === 'create' ? 201 : 200);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1); expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('returns a generic list failure without changing parties/audit', async () => {
    const s = await setup(), before = snapshot(), transaction = s.db.transaction;
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => transaction.call(s.db, (tx: any) => {
      const select = tx.select;
      tx.select = function (this: any, ...selection: any[]) { if (!selection.length) throw new Error('Synthetic private directory failure'); return select.apply(this, selection); };
      return callback(tx);
    }, ...args));
    denied(await send('list', s.tokens.admin), 500); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s keeps fresh auth, directory work, index and audit in one synchronous transaction and commits before response', async endpoint => {
    let currentTx: any, committed = false, serializations = 0, reads = 0, writes = 0;
    const order: string[] = [];
    const s = await setup();
    const transaction = s.db.transaction, fresh = app.projectAccess.requireFreshAdmin, log = AuditLogRepository.prototype.logAction, index = crypto.createBlindIndex;
    // These routes have no response schemas: Fastify serializes their payload
    // through JSON.stringify. Observe the actual response serialization, not
    // merely the point at which inject() eventually resolves.
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation((value: any, replacer?: any, space?: any) => {
      const responsePayload = endpoint === 'list'
        ? Array.isArray(value) && value.some(row => row?.id === 'supplier' && row?.name === 'Synthetic private supplier')
        : endpoint === 'create'
          ? value?.name === 'Synthetic private new party' && typeof value?.id === 'string' && typeof value?.createdAt === 'string'
          : value?.success === true && value?.message === 'Cari kaydı silindi.';
      if (responsePayload) { serializations++; expect(committed).toBe(true); expect(currentTx).toBeUndefined(); }
      return stringify(value, replacer, space);
    });
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, options: any) => {
      expect(options).toEqual(endpoint === 'list' ? undefined : { behavior: 'immediate' });
      const value = transaction.call(s.db, (tx: any) => {
        currentTx = tx;
        const select = tx.select, insert = tx.insert, remove = tx.delete;
        // Audit's nested transaction is a savepoint on this connection and
        // inherits these methods; its JS receiver need not be the outer tx.
        tx.select = function (this: any, ...args: any[]) { expect(currentTx).toBe(tx); if (!args.length) { expect(order[0]).toBe('fresh'); reads++; } return select.apply(this, args); };
        tx.insert = function (this: any, ...args: any[]) { expect(currentTx).toBe(tx); expect(order[0]).toBe('fresh'); writes++; return insert.apply(this, args); };
        tx.delete = function (this: any, ...args: any[]) { expect(currentTx).toBe(tx); expect(order[0]).toBe('fresh'); writes++; return remove.apply(this, args); };
        try { const result = callback(tx); expect(result).not.toBeInstanceOf(Promise); return result; }
        finally { currentTx = undefined; }
      }, options);
      committed = true; return value;
    });
    app.projectAccess.requireFreshAdmin = function (tx: any, ...args: any[]) { expect(tx).toBe(currentTx); const result = fresh.call(this, tx, ...args); order.push('fresh'); return result; };
    const indexing = vi.spyOn(crypto, 'createBlindIndex').mockImplementation((...args) => { expect(currentTx).toBeDefined(); expect(order).toEqual(['fresh']); return index(...args); });
    vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args) { expect(this.db).toBe(currentTx); expect(order).toEqual(['fresh']); order.push('audit'); return log.apply(this, args); });
    try {
      const response = await send(endpoint, s.tokens.admin); expect(response.statusCode).toBe(endpoint === 'create' ? 201 : 200);
      expect(serializations).toBe(1); expect(committed).toBe(true); expect(currentTx).toBeUndefined();
      expect(order).toEqual(endpoint === 'list' ? ['fresh'] : ['fresh', 'audit']);
      expect(reads).toBe(endpoint === 'delete' ? 2 : 1); expect(writes).toBe(endpoint === 'list' ? 0 : 2);
      expect(indexing).toHaveBeenCalledTimes(endpoint === 'create' ? 1 : 0);
    } finally { app.projectAccess.requireFreshAdmin = fresh; }
  });
});
