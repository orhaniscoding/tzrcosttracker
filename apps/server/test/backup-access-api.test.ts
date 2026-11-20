import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as crypto from '@cost-core/crypto';
import {
  AuditLogRepository, users, projects, parties, accounts, categories, customFields,
  transactions, whiteLabelSettings, auditLogs, authSessions, projectMemberships,
} from '@cost-core/database';
import { buildApp } from '../src/app.js';
import * as backupV2 from '../src/services/backup-v2-export.service.js';
const { readFullBackupV2 } = backupV2;

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
describe('retired V1 backup HTTP operations', () => {
  it.each(endpoints)('rejects %s after revocation between authentication and the fresh admin check', async endpoint => {
    const { db, tokens, sessions } = await setup();
    const body = payload(endpoint);
    const original = app.projectAccess.requireFreshAdmin;
    const freshAdmin = vi.spyOn(app.projectAccess, 'requireFreshAdmin').mockImplementation(function (this: any, ...args: any[]) {
      db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) })
        .where(eq(authSessions.id, sessions.admin.id)).run();
      return original.apply(this, args);
    });
    const spies = workSpies();
    denied(await post(endpoint, tokens.admin, body), 401);
    expect(freshAdmin).toHaveBeenCalledTimes(1);
    noWork(spies);
  });
  it.each(endpoints)('rejects %s without reading or changing ledger data', async endpoint => {
    const s = await setup();
    const body = payload(endpoint);
    const before = snapshot();
    const spies = workSpies();
    denied(await post(endpoint, undefined, body), 401);
    denied(await post(endpoint, s.tokens.manager, body), 403);
    const result = await post(endpoint, s.tokens.admin, body);
    denied(result, 410);
    expect(result.json().code).toBe('BACKUP_V1_RETIRED');
    const invalidBody = await app.inject({ method: 'POST', url: `/api/backup/${endpoint}`,
      headers: { authorization: `Bearer ${s.tokens.admin}`, 'content-type': 'application/json' }, payload: '{' });
    expect(invalidBody.statusCode).toBe(410);
    expect(invalidBody.json().code).toBe('BACKUP_V1_RETIRED');
    noWork(spies);
    expect(snapshot()).toEqual(before);
  });
});
describe('full backup v2 HTTP export', () => {
  it('returns 413 without vault data or audit when the export row budget is exhausted', async () => {
    const { tokens } = await setup();
    const original = backupV2.buildFullBackupV2;
    vi.spyOn(backupV2, 'buildFullBackupV2').mockImplementation(input => original({ ...input, limits: { maxTotalRows: 1 } }));
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    const before = snapshot();
    const response = await app.inject({
      method: 'POST', url: '/api/backup/export-v2',
      headers: { authorization: 'Bearer ' + tokens.admin }, payload: { backupPassword: password },
    });
    denied(response, 413);
    expect(response.json()).toHaveProperty('code', 'BACKUP_V2_LIMIT_EXCEEDED');
    expect(response.json()).not.toHaveProperty('manifest');
    expect(audit).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });
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
