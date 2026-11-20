import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as crypto from '@cost-core/crypto';
import {
  AuditLogRepository, users, projects, parties, accounts, categories, customFields,
  transactions, whiteLabelSettings, auditLogs, authSessions, projectMemberships,
} from '@cost-core/database';
import { buildApp } from '../src/app.js';
import { readFullBackupV2 } from '../src/services/backup-v2-export.service.js';

// Keep real authenticated crypto, but expose a spyable namespace even when the
// installed package is native ESM. No encryption/decryption result is stubbed.
vi.mock('@cost-core/crypto', async importOriginal => ({
  ...await importOriginal<typeof import('@cost-core/crypto')>(),
}));

// Synthetic keys, rows and authenticated envelopes only. No files or network.
const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
const password = 'synthetic-vault-password';
const endpoints = ['export', 'import'] as const;
type Endpoint = typeof endpoints[number];
const nine = { users, projects, parties, accounts, categories, customFields, transactions, whiteLabelSettings, auditLogs };
const genericError = { error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' };
let app: any;
afterEach(async () => { vi.restoreAllMocks(); if (app) { await app.close(); app = undefined; } });

function snapshot() {
  const result: Record<string, any[]> = {};
  for (const [name, table] of Object.entries(nine)) result[name] = app.db.select().from(table).orderBy(table.id).all();
  result.authSessions = app.db.select().from(authSessions).orderBy(authSessions.id).all();
  result.projectMemberships = app.db.select().from(projectMemberships).orderBy(projectMemberships.userId, projectMemberships.projectId).all();
  return result;
}
function vault(value: unknown) { return crypto.encryptField(JSON.stringify(value), password).replace('enc:v1:', 'TZRVAULT:v1:'); }
function v1(tables: any = {}) { return { app: 'TZRCoster', format: 'tzrvault', version: '1.0', tables }; }
function payload(endpoint: Endpoint) { return endpoint === 'export' ? { backupPassword: password } : { backupPassword: password, vaultData: vault(v1()) }; }
function post(endpoint: Endpoint, token?: string, body: any = payload(endpoint)) {
  return app.inject({ method: 'POST', url: '/api/backup/' + endpoint + '?role=admin&scope=all&userId=admin&projectId=site2', headers: token ? { authorization: 'Bearer ' + token } : {}, payload: body });
}
function denied(response: any, status: number) {
  expect(response.statusCode).toBe(status);
  const body = JSON.parse(response.body);
  if (status === 401) expect(body.code).toBe('SESSION_INVALID');
  if (status === 500) expect(body).toEqual(genericError);
  for (const key of ['vaultData', 'tables', 'recordCounts', 'filename', 'exportedAt']) expect(body).not.toHaveProperty(key);
  for (const text of [password, 'Synthetic private', 'TZRVAULT:v1:', 'enc:v1:', 'SQLITE_']) expect(response.body).not.toContain(text);
}
async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const db = app.db, now = '2026-01-01T00:00:00.000Z';
  for (const id of ['site1', 'site2']) db.insert(projects).values({ id, name: id, createdAt: now, updatedAt: now }).run();
  const tokens: Record<string, string> = {}, sessions: Record<string, any> = {};
  for (const id of ['admin', 'manager', 'accountant', 'auditor', 'viewer', 'unassigned-manager', 'unassigned-accountant']) {
    const role = id.replace('unassigned-', '');
    db.insert(users).values({ id, username: id, email: id + '@example.test', fullName: 'Synthetic private user', passwordHash: 'synthetic-hash', role, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(id); sessions[id] = session;
    tokens[id] = app.jwt.sign({ id, username: id, role, sid: session.id, exp: session.expiresAt });
    if (id !== 'admin' && !id.startsWith('unassigned-')) db.insert(projectMemberships).values({ userId: id, projectId: 'site1', createdAt: now }).run();
  }
  db.insert(categories).values({ id: 'cat', name: 'Synthetic category', createdAt: now, updatedAt: now }).run();
  db.insert(parties).values({ id: 'party', name: 'Synthetic private party', nameBlindIndex: 'synthetic-party-index', createdAt: now, updatedAt: now }).run();
  db.insert(accounts).values({ id: 'wallet', name: crypto.encryptField('Synthetic wallet', config.masterKey), nameBlindIndex: 'synthetic-wallet-index', balanceEncrypted: crypto.encryptField(120, config.masterKey), projectId: 'site1', createdAt: now, updatedAt: now }).run();
  db.insert(customFields).values({ id: 'field', name: 'synthetic_field', label: 'Synthetic field', type: 'text', createdAt: now }).run();
  db.insert(transactions).values({ id: 'movement', projectId: 'site1', date: now, amountEncrypted: crypto.encryptField(20, config.masterKey), baseAmountEncrypted: crypto.encryptField(20, config.masterKey), titleEncrypted: crypto.encryptField('Synthetic private movement', config.masterKey), titleBlindIndex: 'synthetic-title-index', categoryId: 'cat', createdById: 'admin', createdAt: now, updatedAt: now }).run();
  db.insert(whiteLabelSettings).values({ id: 'global', companyName: 'Synthetic company', updatedAt: now }).run();
  app.auditRepo.logAction({ userId: 'admin', action: 'CREATE', entity: 'synthetic', entityId: 'fixture', newState: { title: 'Synthetic private audit' } }, config.masterKey);
  return { db, tokens, sessions };
}

// Capture full-table snapshot reads separately from the narrow fresh actor reads.
function workSpies() {
  const originalTransaction = app.db.transaction;
  const reads = vi.fn();
  vi.spyOn(app.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => originalTransaction.call(app.db, (tx: any) => {
    const select = tx.select;
    tx.select = function (this: any, ...selection: any[]) { if (!selection.length) reads(); return select.apply(this, selection); };
    return callback(tx);
  }, ...args));
  return { reads, encrypt: vi.spyOn(crypto, 'encryptField'), decrypt: vi.spyOn(crypto, 'decryptField'), audit: vi.spyOn(AuditLogRepository.prototype, 'logAction') };
}
function noWork(spies: ReturnType<typeof workSpies>) {
  expect(spies.reads).not.toHaveBeenCalled(); expect(spies.encrypt).not.toHaveBeenCalled();
  expect(spies.decrypt).not.toHaveBeenCalled(); expect(spies.audit).not.toHaveBeenCalled();
}
function captureLogArgs(args: unknown[]) {
  const seen = new WeakSet<object>();
  return JSON.stringify(args, (_key, value) => {
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      // JSON.stringify(Error) alone hides its non-enumerable message/stack/cause.
      if (value instanceof Error) return { name: value.name, ...Object.fromEntries(Object.getOwnPropertyNames(value).map(key => [key, (value as any)[key]])) };
    }
    return value;
  });
}
async function duringFresh(mutate: (tx: any, uid: string, sid: string, expiry: number) => void, run: () => Promise<any>) {
  const fresh = app.projectAccess.requireFreshAdmin; let calls = 0;
  app.projectAccess.requireFreshAdmin = function (tx: any, uid: string, sid: string, expiry: number) {
    calls++; expect(tx).not.toBe(app.db); mutate(tx, uid, sid, expiry);
    return fresh.call(this, tx, uid, sid, expiry);
  };
  try { const response = await run(); expect(calls).toBe(1); return response; }
  finally { app.projectAccess.requireFreshAdmin = fresh; }
}

describe('legacy v1 backup fresh admin boundary and atomic operations', () => {
  it.each(endpoints)('%s forbids every non-admin before schema, crypto, snapshots or audit', async endpoint => {
    const s = await setup(), body = { ...payload(endpoint), userId: 'admin', role: 'admin', scope: { all: true }, projectId: 'site2' }, before = snapshot(), spies = workSpies();
    for (const role of ['manager', 'accountant', 'auditor', 'viewer', 'unassigned-manager', 'unassigned-accountant']) {
      denied(await post(endpoint, s.tokens[role], body), 403);
      denied(await post(endpoint, s.tokens[role], { backupPassword: null, vaultData: null, role: 'admin' }), 403);
    }
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s rejects noauth/invalid tokens before any backup work', async endpoint => {
    await setup(); const body = payload(endpoint), before = snapshot(), spies = workSpies();
    denied(await post(endpoint, undefined, body), 401); denied(await post(endpoint, 'invalid-token', body), 401);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s uses current DB role rather than stale or smuggled JWT claims', async endpoint => {
    const s = await setup(), body = payload(endpoint);
    s.db.update(users).set({ role: 'manager' }).where(eq(users.id, 'admin')).run();
    const forged = app.jwt.sign({ id: 'manager', username: 'manager', role: 'admin', sid: s.sessions.manager.id, exp: s.sessions.manager.expiresAt });
    const before = snapshot(), spies = workSpies();
    denied(await post(endpoint, s.tokens.admin, body), 403); denied(await post(endpoint, forged, body), 403);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s rechecks an auth-to-transaction role downgrade before malformed body validation', async endpoint => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    const response = await duringFresh((tx, uid) => tx.update(users).set({ role: 'manager' }).where(eq(users.id, uid)).run(), () => post(endpoint, s.tokens.admin, {}));
    denied(response, 403); noWork(spies); expect(snapshot()).toEqual(before);
  });

  for (const state of ['revoked', 'inactive', 'invalid-role', 'missing-session', 'changed-expiry'] as const) {
    it.each(endpoints)(`%s rechecks ${state} after auth before crypto/snapshot/audit`, async endpoint => {
      const s = await setup(), body = payload(endpoint), before = snapshot(), spies = workSpies();
      const response = await duringFresh((tx, uid, sid, expiry) => {
        if (state === 'revoked') tx.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, sid)).run();
        if (state === 'inactive') tx.update(users).set({ isActive: false }).where(eq(users.id, uid)).run();
        if (state === 'invalid-role') tx.update(users).set({ role: 'invalid' }).where(eq(users.id, uid)).run();
        if (state === 'missing-session') tx.delete(authSessions).where(eq(authSessions.id, sid)).run();
        if (state === 'changed-expiry') tx.update(authSessions).set({ expiresAt: expiry + 1 }).where(eq(authSessions.id, sid)).run();
      }, () => post(endpoint, s.tokens.admin, body));
      denied(response, 401); noWork(spies); expect(snapshot()).toEqual(before);
    });
  }

  for (const offset of [0, 1]) {
    it.each(endpoints)(`%s rejects exact/elapsed expiry +${offset}s after auth`, async endpoint => {
      const s = await setup(), body = payload(endpoint), before = snapshot(), spies = workSpies();
      let clock: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const response = await duringFresh((_tx, _uid, _sid, expiry) => { clock = vi.spyOn(Date, 'now').mockReturnValue((expiry + offset) * 1000); }, () => post(endpoint, s.tokens.admin, body));
        denied(response, 401); noWork(spies); expect(snapshot()).toEqual(before);
      } finally { clock?.mockRestore(); }
    });
  }

  it.each(endpoints)('%s rejects an already revoked session before work', async endpoint => {
    const s = await setup(), body = payload(endpoint);
    s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, s.sessions.admin.id)).run();
    const before = snapshot(), spies = workSpies();
    denied(await post(endpoint, s.tokens.admin, body), 401); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s rejects malformed admin body without work or reflected validation values', async endpoint => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    for (const body of [{}, { backupPassword: null }, { backupPassword: '' }, { backupPassword: [], vaultData: {} }]) denied(await post(endpoint, s.tokens.admin, body), 400);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('exports exactly nine tables from one snapshot and appends the export audit only after snapshot capture', async () => {
    const s = await setup(), before = snapshot();
    const response = await post('export', s.tokens.admin, { ...payload('export'), role: 'viewer', userId: 'viewer' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body), decoded = crypto.decryptField<any>(body.vaultData.replace('TZRVAULT:v1:', 'enc:v1:'), password);
    expect(body.vaultData.startsWith('TZRVAULT:v1:')).toBe(true); expect(body.filename).toMatch(/\.tzrvault$/);
    expect(decoded).toMatchObject({ app: 'TZRCoster', format: 'tzrvault', version: '1.0', exportedAt: body.exportedAt, recordCounts: body.recordCounts });
    expect(Object.keys(decoded.tables).sort()).toEqual(Object.keys(nine).sort());
    for (const name of Object.keys(nine)) expect([...decoded.tables[name]].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...before[name]].sort((a, b) => a.id.localeCompare(b.id)));
    expect(body.recordCounts).toEqual({ users: before.users.length, projects: 2, transactions: 1, categories: 1, parties: 1, auditLogs: 1 });
    const after = snapshot(); expect(after.auditLogs).toHaveLength(before.auditLogs.length + 1);
    for (const name of Object.keys(before).filter(name => name !== 'auditLogs')) expect(after[name]).toEqual(before[name]);
    const log = app.auditRepo.listAuditLogs(1, config.masterKey)[0];
    expect(log).toMatchObject({ userId: 'admin', action: 'EXPORT', entity: 'system_backup', entityId: 'tzrvault', previousState: null, newState: { filename: body.filename, recordCounts: body.recordCounts } });
    expect(JSON.stringify(log)).not.toContain(password); expect(JSON.stringify(log)).not.toContain(body.vaultData);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('restores an existing exported v1 with the same master key, only upserting the five legacy tables', async () => {
    const s = await setup(), exported = JSON.parse((await post('export', s.tokens.admin)).body), original = snapshot();
    s.db.update(categories).set({ name: 'Changed category' }).where(eq(categories.id, 'cat')).run();
    s.db.update(projects).set({ name: 'Changed project' }).where(eq(projects.id, 'site1')).run();
    s.db.update(parties).set({ name: 'Changed party' }).where(eq(parties.id, 'party')).run();
    s.db.update(transactions).set({ titleEncrypted: crypto.encryptField('Changed title', config.masterKey) }).where(eq(transactions.id, 'movement')).run();
    s.db.update(whiteLabelSettings).set({ companyName: 'Changed company' }).run();
    s.db.update(accounts).set({ balanceEncrypted: crypto.encryptField(999, config.masterKey) }).run();
    s.db.update(customFields).set({ label: 'Changed field' }).run();
    s.db.update(users).set({ fullName: 'Changed user' }).where(eq(users.id, 'viewer')).run();
    s.db.insert(categories).values({ id: 'keep-local', name: 'Local row is not deleted', createdAt: '2026-01-01', updatedAt: '2026-01-01' }).run();
    const before = snapshot(), response = await post('import', s.tokens.admin, { backupPassword: password, vaultData: exported.vaultData });
    expect(response.statusCode).toBe(200); expect(JSON.parse(response.body)).toMatchObject({ success: true, recordCounts: exported.recordCounts });
    expect(JSON.parse(response.body).message).toContain('kısmi');
    const after = snapshot();
    for (const name of ['projects', 'parties', 'transactions', 'whiteLabelSettings']) expect(after[name]).toEqual(original[name]);
    expect(after.categories).toEqual([...original.categories, ...before.categories.filter(row => row.id === 'keep-local')].sort((a, b) => a.id.localeCompare(b.id)));
    for (const name of ['users', 'accounts', 'customFields', 'authSessions', 'projectMemberships']) expect(after[name]).toEqual(before[name]);
    expect(after.auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(crypto.decryptField(after.transactions[0].titleEncrypted, config.masterKey)).toBe('Synthetic private movement');
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({ userId: 'admin', action: 'RESTORE', entity: 'system_backup', newState: { recordCounts: exported.recordCounts } });
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it.each(['wrong-password', 'tamper', 'plaintext', 'enc-alias', 'leading-junk', 'trailing-newline', 'bad-hex', 'truncated'] as const)('rejects %s without changing any table', async mode => {
    const s = await setup(); let vaultData = vault(v1({ categories: [{ id: 'new', name: 'Synthetic private category' }] }));
    let backupPassword = password;
    if (mode === 'wrong-password') backupPassword = 'synthetic-wrong-password';
    if (mode === 'tamper') vaultData = vaultData.slice(0, -1) + (vaultData.endsWith('0') ? '1' : '0');
    if (mode === 'plaintext') vaultData = JSON.stringify(v1());
    if (mode === 'enc-alias') vaultData = vaultData.replace('TZRVAULT:v1:', 'enc:v1:');
    if (mode === 'leading-junk') vaultData = 'junk' + vaultData;
    if (mode === 'trailing-newline') vaultData += '\n';
    if (mode === 'bad-hex') vaultData = vaultData.slice(0, -1) + 'g';
    if (mode === 'truncated') vaultData = 'TZRVAULT:v1:1234567890';
    const before = snapshot(), audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    denied(await post('import', s.tokens.admin, { backupPassword, vaultData }), 400);
    expect(snapshot()).toEqual(before); expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    null, [], 'not an object', { tables: {} }, { ...v1(), app: 'other' }, { ...v1(), format: 'other' },
    { ...v1(), version: 1 }, { ...v1(), version: '2.0' }, { ...v1(), format: undefined },
    v1(null), v1([]), v1('bad'),
    ...Object.keys(nine).flatMap(name => [v1({ [name]: null }), v1({ [name]: {} }), v1({ [name]: [null] }), v1({ [name]: [[]] }), v1({ [name]: ['bad'] })]),
  ].map((value, index) => ({ value, index })))('rejects authenticated invalid snapshot $index, including un-restored table shapes', async ({ value }) => {
    const s = await setup(), body = { backupPassword: password, vaultData: vault(value) }, before = snapshot();
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    denied(await post('import', s.tokens.admin, body), 400); expect(snapshot()).toEqual(before); expect(audit).not.toHaveBeenCalled();
  });

  it('rolls back earlier rows on a real second-table insert failure and permits a successful retry', async () => {
    const s = await setup(), before = snapshot();
    const tables = { categories: [{ ...before.categories[0], name: 'Updated category' }, { ...before.categories[0], id: 'new-category' }], projects: [{ ...before.projects[0], id: 'new-project', name: 'New project' }] };
    const body = { backupPassword: password, vaultData: vault(v1(tables)) };
    s.db.run(sql`CREATE TRIGGER synthetic_backup_failure BEFORE INSERT ON projects WHEN NEW.id = 'new-project' BEGIN SELECT RAISE(ABORT, 'Synthetic private failure'); END`);
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    denied(await post('import', s.tokens.admin, body), 500); expect(snapshot()).toEqual(before); expect(audit).not.toHaveBeenCalled();
    s.db.run(sql`DROP TRIGGER synthetic_backup_failure`);
    expect((await post('import', s.tokens.admin, body)).statusCode).toBe(200);
    expect(snapshot().categories.find(row => row.id === 'cat').name).toBe('Updated category');
    expect(snapshot().categories.some(row => row.id === 'new-category')).toBe(true);
    expect(snapshot().projects.some(row => row.id === 'new-project')).toBe(true);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
  });

  it.each(endpoints)('%s rolls back even an audit inserted before failure, exposes no vault, and can retry', async endpoint => {
    const s = await setup(), before = snapshot();
    const body = endpoint === 'export' ? payload(endpoint) : { backupPassword: password, vaultData: vault(v1({ categories: [{ ...before.categories[0], name: 'Changed on restore' }], projects: [{ ...before.projects[0], name: 'Changed on restore' }], parties: [{ ...before.parties[0], name: 'Changed on restore' }], transactions: [{ ...before.transactions[0], date: '2026-02-01' }], whiteLabelSettings: [{ ...before.whiteLabelSettings[0], companyName: 'Changed on restore' }] })) };
    const original = AuditLogRepository.prototype.logAction;
    const applicationLogs: { level: string; args: string }[] = [], consoleLogs: string[] = [], frameworkMetadata: string[] = [];
    const incomingRequests = new Set<any>();
    for (const method of ['log', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleLogs.push(captureLogArgs(args)); });
    }
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
      vi.spyOn(app.log, level).mockImplementation((...args: any[]) => {
        const fields = args[0];
        // Fastify owns these two exact lifecycle envelopes. The incoming req is
        // logged BEFORE parsing, but mock.calls retains it AFTER body/raw inject
        // payload mutation. It is not serialized logger output. Capture only
        // lifecycle metadata now, never recursively serialize req/raw or res.
        // Any extra field, Error, later req log or other message is application
        // logging and must satisfy the zero-call assertion below.
        if (level === 'info' && args.length === 2 && args[1] === 'incoming request' &&
          fields && Object.keys(fields).sort().join(',') === 'req' &&
          fields.req && typeof fields.req.id === 'string' && fields.req.body === undefined) {
          incomingRequests.add(fields.req);
          frameworkMetadata.push(captureLogArgs([{ method: fields.req.method, url: fields.req.url }, args[1]]));
        } else if (level === 'info' && args.length === 2 && args[1] === 'request completed' &&
          fields && Object.keys(fields).sort().join(',') === 'res,responseTime' &&
          fields.res && incomingRequests.has(fields.res.request)) {
          frameworkMetadata.push(captureLogArgs([{ statusCode: fields.res.statusCode, responseTime: fields.responseTime }, args[1]]));
        } else {
          applicationLogs.push({ level, args: captureLogArgs(args) });
        }
      });
    }
    const failure = new Error('Synthetic private failure ' + password + ' enc:v1:payload ' + (body.vaultData ?? 'TZRVAULT:v1:synthetic-output'));
    // Prove that the capture would detect the injected Error, not silently {} it.
    expect(captureLogArgs([failure])).toContain(failure.message);
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args) {
      original.apply(this, args); throw failure;
    });
    denied(await post(endpoint, s.tokens.admin, body), 500); expect(snapshot()).toEqual(before);
    expect(audit).toHaveBeenCalledTimes(1);
    // buildApp has logger:false: this tests application arguments, not Pino
    // output/redaction or the safety of any future enabled-logger configuration.
    expect(applicationLogs).toEqual([]);
    for (const output of [...consoleLogs, ...frameworkMetadata, ...applicationLogs.map(log => log.args)]) {
      for (const sensitive of [password, 'TZRVAULT:v1:', 'enc:v1:payload', 'Synthetic private failure']) expect(output).not.toContain(sensitive);
    }
    audit.mockRestore(); expect((await post(endpoint, s.tokens.admin, body)).statusCode).toBe(200);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('returns generic 500 on snapshot failure before encryption/audit, without leaking partial results', async () => {
    const s = await setup(), before = snapshot(), transaction = s.db.transaction;
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => transaction.call(s.db, (tx: any) => {
      const select = tx.select; let reads = 0;
      tx.select = function (this: any, ...args: any[]) {
        if (!args.length && ++reads === 5) throw new Error('Synthetic private snapshot failure');
        return select.apply(this, args);
      };
      return callback(tx);
    }, ...args));
    const encrypt = vi.spyOn(crypto, 'encryptField'), audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    denied(await post('export', s.tokens.admin, { backupPassword: password }), 500);
    expect(encrypt).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s keeps fresh authorization, crypto, all reads/writes and audit in one synchronous immediate transaction', async endpoint => {
    let currentTx: any, committed = false, readCount = 0, writeCount = 0; const order: string[] = [];
    const s = await setup();
    const before = snapshot(), body = endpoint === 'export' ? payload(endpoint) : { backupPassword: password, vaultData: vault(v1({ categories: [{ ...before.categories[0], name: 'Restored synchronously' }] })) };
    const transaction = s.db.transaction, fresh = app.projectAccess.requireFreshAdmin, log = AuditLogRepository.prototype.logAction;
    const encrypt = crypto.encryptField, decrypt = crypto.decryptField;
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, options: any) => {
      expect(options).toEqual({ behavior: 'immediate' });
      const result = transaction.call(s.db, (tx: any) => {
        currentTx = tx;
        const select = tx.select, insert = tx.insert;
        tx.select = function (this: any, ...args: any[]) { expect(currentTx).toBe(tx); if (!args.length) { expect(order[0]).toBe('fresh'); readCount++; } return select.apply(this, args); };
        tx.insert = function (this: any, ...args: any[]) { expect(currentTx).toBe(tx); expect(order[0]).toBe('fresh'); writeCount++; return insert.apply(this, args); };
        try { const value = callback(tx); expect(value).not.toBeInstanceOf(Promise); return value; }
        finally { currentTx = undefined; }
      }, options);
      committed = true; return result;
    });
    app.projectAccess.requireFreshAdmin = function (tx: any, ...args: any[]) { expect(tx).toBe(currentTx); const result = fresh.call(this, tx, ...args); order.push('fresh'); return result; };
    vi.spyOn(crypto, 'encryptField').mockImplementation((...args) => { expect(currentTx).toBeDefined(); expect(order[0]).toBe('fresh'); return encrypt(...args); });
    vi.spyOn(crypto, 'decryptField').mockImplementation(<T = string>(cipherText: string, key: string | Buffer): T => { expect(currentTx).toBeDefined(); expect(order[0]).toBe('fresh'); return decrypt<T>(cipherText, key); });
    vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args) {
      expect(this.db).toBe(currentTx); expect(order).toEqual(['fresh']); order.push('audit'); return log.apply(this, args);
    });
    try {
      const response = await post(endpoint, s.tokens.admin, body); expect(response.statusCode).toBe(200);
      expect(order).toEqual(['fresh', 'audit']); expect(committed).toBe(true); expect(currentTx).toBeUndefined();
      // Audit's own latest-row read/write also use the outer transaction connection.
      expect(readCount).toBe(endpoint === 'export' ? 10 : 1); expect(writeCount).toBe(endpoint === 'export' ? 1 : 2);
    } finally { app.projectAccess.requireFreshAdmin = fresh; }
  });
});


describe('full backup v2 HTTP export', () => {
  it('requires a fresh admin session and a password of at least 12 UTF-8 bytes', async () => {
    const { tokens } = await setup();
    const unauthenticated = await app.inject({ method: 'POST', url: '/api/backup/export-v2', payload: { backupPassword: password } });
    expect(unauthenticated.statusCode).toBe(401);

    const short = await app.inject({
      method: 'POST', url: '/api/backup/export-v2',
      headers: { authorization: 'Bearer ' + tokens.admin },
      payload: { backupPassword: '12345678901' },
    });
    expect(short.statusCode).toBe(400);
    expect(JSON.parse(short.body)).toEqual({ error: 'Geçersiz v2 yedek parametreleri.' });
  });

  it.each([{ backupPassword: 'ç'.repeat(129) }, { backupPassword: 123 }, { backupPassword: null }, {}])(
    'rejects an invalid v2 request without producing a vault or logging an export (%j)',
    async (payload) => {
      const { tokens } = await setup();
      const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
      const response = await app.inject({
        method: 'POST', url: '/api/backup/export-v2',
        headers: { authorization: 'Bearer ' + tokens.admin }, payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'Geçersiz v2 yedek parametreleri.' });
      expect(audit).not.toHaveBeenCalled();
    },
  );

  it('rejects an authenticated non-admin before producing or auditing a v2 vault', async () => {
    const { tokens } = await setup();
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    const response = await app.inject({
      method: 'POST', url: '/api/backup/export-v2',
      headers: { authorization: 'Bearer ' + tokens.manager },
      payload: { backupPassword: password },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('TZRVAULT:v2:');
    expect(audit).not.toHaveBeenCalled();
  });

  it('returns a decryptable v2 vault for all eleven tables and records the export after the snapshot', async () => {
    const { tokens } = await setup();
    const before = snapshot();
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    const backupPassword = 'ç'.repeat(6); // exactly 12 UTF-8 bytes
    const response = await app.inject({
      method: 'POST', url: '/api/backup/export-v2',
      headers: { authorization: 'Bearer ' + tokens.admin },
      payload: { backupPassword },
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body);
    expect(result.vaultData).toMatch(/^TZRVAULT:v2:/);
    expect(result.filename).toMatch(/^TZRCoster_Tam_Yedek_.*\.tzrvault$/);
    expect(Object.keys(result.manifest.tableCounts)).toHaveLength(11);
    expect(result.manifest.tableCounts.users).toBe(7);
    expect(result.manifest.tableCounts.auth_sessions).toBe(7);
    expect(result.manifest.tableCounts.audit_logs).toBe(before.auditLogs.length);

    const decoded = await readFullBackupV2(result.vaultData, backupPassword);
    try {
      expect(Object.fromEntries(decoded.payload.tables.map(table => [table.name, table.rowCount])))
        .toEqual(result.manifest.tableCounts);
      expect(decoded.payload.documents).toEqual({ present: false, count: 0 });
      const account = decoded.payload.tables.find(table => table.name === 'accounts')?.rows[0];
      expect(account?.id).toBe('wallet');
      expect(crypto.decryptField(account?.balance_encrypted as string, decoded.keys.masterKey)).toBe(120);
      expect(decoded.keys.blindIndexPepper.toString('utf8')).toBe(config.blindIndexPepper);
    } finally {
      decoded.keys.masterKey.fill(0);
      decoded.keys.blindIndexPepper.fill(0);
    }

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][0]).toMatchObject({
      action: 'EXPORT', entity: 'system_backup', entityId: 'tzrvault-v2',
      newState: { filename: result.filename, manifest: result.manifest },
    });
    expect(JSON.stringify(audit.mock.calls[0][0])).not.toContain(backupPassword);
    expect(JSON.stringify(audit.mock.calls[0][0])).not.toContain(result.vaultData);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
    expect(response.body).not.toContain('Synthetic private');
  });

  it('returns only a generic error when the export audit cannot be committed', async () => {
    const { tokens } = await setup();
    vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(() => { throw new Error('synthetic audit failure'); });
    const response = await app.inject({
      method: 'POST', url: '/api/backup/export-v2',
      headers: { authorization: 'Bearer ' + tokens.admin },
      payload: { backupPassword: password },
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual(genericError);
    expect(response.body).not.toContain('TZRVAULT:v2:');
    expect(response.body).not.toContain('synthetic audit failure');
  });

  it('returns a generic error without auditing when the snapshot schema is unsupported', async () => {
    const { tokens } = await setup();
    app.sqlite.exec('CREATE TABLE synthetic_unsupported_table (id INTEGER)');
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    const response = await app.inject({
      method: 'POST', url: '/api/backup/export-v2',
      headers: { authorization: 'Bearer ' + tokens.admin },
      payload: { backupPassword: password },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(genericError);
    expect(audit).not.toHaveBeenCalled();
  });

  it('withholds a snapshot if the session is revoked before the export audit', async () => {
    const { db, tokens, sessions } = await setup();
    const original = app.projectAccess.requireFreshAdmin;
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    let calls = 0;
    app.projectAccess.requireFreshAdmin = function (tx: any, uid: string, sid: string, expiry: number) {
      const result = original.call(this, tx, uid, sid, expiry);
      if (++calls === 2) {
        // The snapshot reads synchronously, then scrypt yields before the audit.
        queueMicrotask(() => db.update(authSessions)
          .set({ revokedAt: Math.floor(Date.now() / 1000) })
          .where(eq(authSessions.id, sessions.admin.id)).run());
      }
      return result;
    };

    const response = await app.inject({
      method: 'POST', url: '/api/backup/export-v2',
      headers: { authorization: 'Bearer ' + tokens.admin },
      payload: { backupPassword: password },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
    expect(audit).not.toHaveBeenCalled();
  });

  it('rechecks admin state inside the snapshot transaction before reading tables', async () => {
    const { tokens } = await setup();
    const original = app.projectAccess.requireFreshAdmin;
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    let calls = 0;
    app.projectAccess.requireFreshAdmin = function (tx: any, uid: string, sid: string, expiry: number) {
      calls++;
      const result = original.call(this, tx, uid, sid, expiry);
      if (calls === 1) tx.update(users).set({ role: 'manager' }).where(eq(users.id, 'admin')).run();
      return result;
    };

    const response = await app.inject({
      method: 'POST', url: '/api/backup/export-v2',
      headers: { authorization: 'Bearer ' + tokens.admin },
      payload: { backupPassword: password },
    });

    expect(calls).toBe(2);
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'Yasak.' });
    expect(response.body).not.toContain('TZRVAULT:v2:');
    expect(audit).not.toHaveBeenCalled();
  });
});
