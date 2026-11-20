import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { AuditLogRepository, users, projects, whiteLabelSettings, auditLogs, authSessions, projectMemberships } from '@cost-core/database';
import { buildApp } from '../src/app.js';

// All users, sessions, tokens, branding rows and encryption inputs are synthetic.
// buildApp receives explicit configuration and an in-memory database only.
const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
const nonadmins = ['manager', 'accountant', 'auditor', 'viewer'].flatMap(role => [role, 'unassigned-' + role]);
const roles = ['admin', ...nonadmins];
const now = '2026-01-01T00:00:00.000Z';
const publicKeys = ['companyName', 'appTitle', 'logoUrl', 'faviconUrl', 'backgroundUrl', 'primaryColor', 'secondaryColor', 'defaultTheme', 'baseCurrency', 'dateFormat'].sort();
const sqlColumns = ['company_name', 'app_title', 'logo_url', 'favicon_url', 'background_url', 'primary_color', 'secondary_color', 'default_theme', 'base_currency', 'date_format'];
const globalSeed = {
  id: 'global', companyName: 'Synthetic Global Co', appTitle: 'Synthetic App',
  logoUrl: 'https://example.test/logo.png', faviconUrl: null, backgroundUrl: '',
  primaryColor: '#112233', secondaryColor: '#445566', defaultTheme: 'light' as const,
  baseCurrency: 'USD', dateFormat: 'YYYY-MM-DD', updatedAt: now,
};
const otherSeed = {
  id: 'site1', companyName: 'Synthetic Other Co', appTitle: 'Other App',
  logoUrl: 'https://example.test/other.png', faviconUrl: 'https://example.test/favicon.ico',
  backgroundUrl: 'https://example.test/background.png', primaryColor: '#000000', secondaryColor: '#FFFFFF',
  defaultTheme: 'system' as const, baseCurrency: 'EUR', dateFormat: 'DD/MM/YYYY', updatedAt: now,
};
const repositoryDefaults = {
  companyName: 'TZRCoster Finance', appTitle: 'TZRCoster Maliyet & Finans',
  logoUrl: undefined, faviconUrl: undefined, backgroundUrl: undefined,
  primaryColor: '#2563EB', secondaryColor: '#1E40AF', defaultTheme: 'dark',
  baseCurrency: 'TRY', dateFormat: 'DD.MM.YYYY',
};
const genericError = { error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' };
let app: any;
afterEach(async () => { vi.restoreAllMocks(); if (app) { await app.close(); app = undefined; } });

async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const db = app.db, tokens: Record<string, string> = {}, sessions: Record<string, any> = {};
  for (const id of ['site1', 'site2']) db.insert(projects).values({ id, name: id, createdAt: now, updatedAt: now }).run();
  for (const id of roles) {
    const role = id.replace('unassigned-', '');
    db.insert(users).values({ id, username: id, email: id + '@example.test', fullName: 'Synthetic user', passwordHash: 'synthetic-hash', role, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(id); sessions[id] = session;
    tokens[id] = app.jwt.sign({ id, username: id, role, sid: session.id, exp: session.expiresAt });
    if (id !== 'admin' && !id.startsWith('unassigned-')) db.insert(projectMemberships).values({ userId: id, projectId: 'site1', createdAt: now }).run();
  }
  db.insert(whiteLabelSettings).values(globalSeed).run();
  db.insert(whiteLabelSettings).values(otherSeed).run();
  app.auditRepo.logAction({ userId: 'admin', action: 'CREATE', entity: 'synthetic', entityId: 'fixture', newState: { synthetic: true } }, config.masterKey);
  return { db, tokens, sessions };
}
function snapshot() {
  return {
    settings: app.db.select().from(whiteLabelSettings).orderBy(whiteLabelSettings.id).all(),
    auditLogs: app.db.select().from(auditLogs).orderBy(auditLogs.id).all(),
    users: app.db.select().from(users).orderBy(users.id).all(),
    sessions: app.db.select().from(authSessions).orderBy(authSessions.id).all(),
    memberships: app.db.select().from(projectMemberships).orderBy(projectMemberships.userId, projectMemberships.projectId).all(),
    projects: app.db.select().from(projects).orderBy(projects.id).all(),
  };
}
// Mirrors WhiteLabelRepository.getSettings public fields: null/empty URL values
// become undefined; id and updatedAt are never part of the public projection.
function publicDto(row: any) {
  return {
    companyName: row.companyName, appTitle: row.appTitle,
    logoUrl: row.logoUrl || undefined, faviconUrl: row.faviconUrl || undefined,
    backgroundUrl: row.backgroundUrl || undefined, primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor, defaultTheme: row.defaultTheme,
    baseCurrency: row.baseCurrency, dateFormat: row.dateFormat,
  };
}
function fullDto(row: any) { return { ...publicDto(row), updatedAt: row.updatedAt }; }
// Decrypted/JSON-serialized DTOs never carry undefined-valued keys.
function plain(value: any) { return JSON.parse(JSON.stringify(value)); }
function globalRow() { return app.db.select().from(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).get(); }
function send(kind: 'get' | 'put', token?: string, payload?: any) {
  const smuggling = 'role=admin&userId=admin&projectId=site2&scope=all&fields=id,updatedAt,updated_at';
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  if (kind === 'get') return app.inject({ method: 'GET', url: '/api/settings/white-label?' + smuggling, headers });
  return app.inject({ method: 'PUT', url: '/api/settings/white-label?' + smuggling, headers, payload: payload ?? { companyName: 'Synthetic updated name' } });
}
function denied(response: any, status: number) {
  expect(response.statusCode).toBe(status); const body = JSON.parse(response.body);
  if (status === 401) expect(body.code).toBe('SESSION_INVALID');
  if (status === 500) expect(body).toEqual(genericError);
  if (status === 400) expect(body).toEqual({ error: 'Geçersiz veri.' });
  if (status === 403) expect(typeof body.error).toBe('string');
  for (const text of ['Synthetic private', 'enc:v1:', 'SQLITE_', 'attacker', 'Hijack']) expect(response.body).not.toContain(text);
}
// Observe the executed branding SQL, not just the final response payload.
function workSpies() {
  const transaction = app.db.transaction, selections = vi.fn(), writes = vi.fn();
  vi.spyOn(app.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => transaction.call(app.db, (tx: any) => {
    const select = tx.select;
    tx.select = function (this: any, ...selection: any[]) {
      const builder = select.apply(this, selection), from = builder.from;
      builder.from = function (table: any) {
        const query = from.call(this, table);
        if (table === whiteLabelSettings) for (const method of ['all', 'get'] as const) {
          const execute = query[method];
          query[method] = function (...params: any[]) { selections(selection[0], this.toSQL().sql); return execute.apply(this, params); };
        }
        return query;
      };
      return builder;
    };
    for (const method of ['insert', 'update', 'delete'] as const) {
      const original = tx[method];
      tx[method] = function (this: any, table: any, ...rest: any[]) {
        if (table === whiteLabelSettings) writes(method);
        return original.call(this, table, ...rest);
      };
    }
    return callback(tx);
  }, ...args));
  return { selections, writes, audit: vi.spyOn(AuditLogRepository.prototype, 'logAction') };
}
function noWork(spies: ReturnType<typeof workSpies>) {
  expect(spies.selections).not.toHaveBeenCalled(); expect(spies.writes).not.toHaveBeenCalled(); expect(spies.audit).not.toHaveBeenCalled();
}
async function duringFresh(mutate: (tx: any, uid: string, sid: string, expiry: number) => void, run: () => Promise<any>) {
  const fresh = app.projectAccess.requireFreshActor; let calls = 0;
  app.projectAccess.requireFreshActor = function (tx: any, uid: string, sid: string, expiry: number) {
    calls++; expect(tx).not.toBe(app.db); mutate(tx, uid, sid, expiry); return fresh.call(this, tx, uid, sid, expiry);
  };
  try { const response = await run(); expect(calls).toBe(1); return response; }
  finally { app.projectAccess.requireFreshActor = fresh; }
}
function expectPublicProjection(spies: ReturnType<typeof workSpies>, times = 1) {
  expect(spies.selections).toHaveBeenCalledTimes(times);
  const [selection, statement] = spies.selections.mock.calls[0];
  expect(Object.keys(selection).sort()).toEqual(publicKeys);
  const projection = statement.slice(0, statement.indexOf(' from '));
  for (const column of sqlColumns) expect(projection).toContain('"' + column + '"');
  expect(projection).not.toContain('"updated_at"'); expect(projection).not.toContain('"id"');
}
function expectKeys(body: any, keys: string[]) { expect(Object.keys(body).sort()).toEqual([...keys].sort()); }
const definedPublicKeys = ['companyName', 'appTitle', 'logoUrl', 'primaryColor', 'secondaryColor', 'defaultTheme', 'baseCurrency', 'dateFormat'];
const definedDefaultKeys = ['companyName', 'appTitle', 'primaryColor', 'secondaryColor', 'defaultTheme', 'baseCurrency', 'dateFormat'];

describe('white label settings: public branding read and atomic admin update', () => {
  it.each([...roles, 'anonymous'])('%s GET returns only the ten public fields regardless of role or client claims', async who => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    const response = await send('get', who === 'anonymous' ? undefined : s.tokens[who]);
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual(publicDto(globalSeed));
    expectKeys(body, definedPublicKeys);
    expect(body).not.toHaveProperty('id'); expect(body).not.toHaveProperty('updatedAt');
    expectPublicProjection(spies); expect(spies.audit).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('GET ignores invalid/forged bearer tokens and stays public after session revocation', async () => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    const forged = app.jwt.sign({ id: 'site1', username: 'ghost', role: 'admin', sid: 'forged-session', exp: 9999999999 });
    for (const token of ['invalid-token', forged, s.tokens.admin]) {
      const response = await send('get', token);
      expect(response.statusCode).toBe(200); expect(JSON.parse(response.body)).toEqual(publicDto(globalSeed));
    }
    s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, s.sessions.admin.id)).run();
    const revoked = await send('get', s.tokens.admin);
    expect(revoked.statusCode).toBe(200); expect(JSON.parse(revoked.body)).toEqual(publicDto(globalSeed));
    expectPublicProjection(spies, 4); expect(spies.audit).not.toHaveBeenCalled();
    expect(snapshot().settings).toEqual(before.settings); expect(snapshot().auditLogs).toEqual(before.auditLogs);
    expect(snapshot().users).toEqual(before.users); expect(snapshot().projects).toEqual(before.projects);
  });

  it('GET returns repository defaults in memory for a missing global row without inserts, audit or timestamps', async () => {
    const s = await setup();
    s.db.delete(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).run();
    const before = snapshot(), spies = workSpies();
    expect(app.db.select().from(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).get()).toBeUndefined();
    const response = await send('get');
    expect(response.statusCode).toBe(200); const body = JSON.parse(response.body);
    expect(body).toEqual(repositoryDefaults); expectKeys(body, definedDefaultKeys);
    expect(body).not.toHaveProperty('updatedAt'); expect(body).not.toHaveProperty('id');
    // The remaining non-global row is never used as a fallback.
    expect(body.companyName).not.toBe(otherSeed.companyName);
    expectPublicProjection(spies); expect(spies.writes).not.toHaveBeenCalled(); expect(spies.audit).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('GET keeps the existing generic 500 contract and rolls back on read failure', async () => {
    await setup(); const before = snapshot();
    vi.spyOn(app.db, 'transaction').mockImplementation(() => { throw new Error('Synthetic private SQLITE_ failure enc:v1:payload'); });
    denied(await send('get'), 500); expect(snapshot()).toEqual(before);
  });

  it.each(nonadmins)('%s PUT is denied before validation, branding query or audit', async who => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send('put', s.tokens[who]), 403);
    denied(await send('put', s.tokens[who], {}), 403);
    denied(await send('put', s.tokens[who], { companyName: null, primaryColor: 'red', role: 'admin', userId: 'admin', scope: 'all' }), 403);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('PUT rejects missing or invalid authentication before branding work', async () => {
    await setup(); const before = snapshot(), spies = workSpies();
    denied(await send('put'), 401); denied(await send('put', 'invalid-token'), 401);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('PUT uses the fresh database role for a same-token demotion and forged admin claims', async () => {
    const s = await setup();
    s.db.update(users).set({ role: 'manager' }).where(eq(users.id, 'admin')).run();
    const forged = app.jwt.sign({ id: 'manager', username: 'manager', role: 'admin', sid: s.sessions.manager.id, exp: s.sessions.manager.expiresAt });
    const before = snapshot(), spies = workSpies();
    for (const token of [s.tokens.admin, forged]) denied(await send('put', token), 403);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('PUT rechecks admin before malformed input validation in the transaction', async () => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await duringFresh((tx, uid) => tx.update(users).set({ role: 'manager' }).where(eq(users.id, uid)).run(), () => send('put', s.tokens.admin, { primaryColor: 'red' })), 403);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  for (const state of ['revoked', 'inactive', 'missing-user', 'invalid-role', 'missing-session', 'changed-expiry', 'wrong-session-owner'] as const) {
    it(`PUT rejects ${state} between authentication and transaction`, async () => {
      const s = await setup(), before = snapshot(), spies = workSpies();
      denied(await duringFresh((tx, uid, sid, expiry) => {
        if (state === 'revoked') tx.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, sid)).run();
        if (state === 'inactive') tx.update(users).set({ isActive: false }).where(eq(users.id, uid)).run();
        if (state === 'missing-user') tx.delete(users).where(eq(users.id, uid)).run();
        if (state === 'invalid-role') tx.update(users).set({ role: 'invalid' }).where(eq(users.id, uid)).run();
        if (state === 'missing-session') tx.delete(authSessions).where(eq(authSessions.id, sid)).run();
        if (state === 'changed-expiry') tx.update(authSessions).set({ expiresAt: expiry + 1 }).where(eq(authSessions.id, sid)).run();
        if (state === 'wrong-session-owner') tx.update(authSessions).set({ userId: 'manager' }).where(eq(authSessions.id, sid)).run();
      }, () => send('put', s.tokens.admin)), 401);
      noWork(spies); expect(snapshot()).toEqual(before);
    });
  }

  for (const offset of [0, 1]) it(`PUT rejects exact/elapsed expiry +${offset}s inside transaction`, async () => {
    const s = await setup(), before = snapshot(), spies = workSpies(); let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      denied(await duringFresh((_tx, _uid, _sid, expiry) => { clock = vi.spyOn(Date, 'now').mockReturnValue((expiry + offset) * 1000); }, () => send('put', s.tokens.admin)), 401);
      noWork(spies); expect(snapshot()).toEqual(before);
    } finally { clock?.mockRestore(); }
  });

  it('PUT rejects an already revoked session before validation', async () => {
    const s = await setup();
    s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, s.sessions.admin.id)).run();
    const before = snapshot(), spies = workSpies();
    denied(await send('put', s.tokens.admin, { primaryColor: 'red' }), 401);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  const badFields = [
    { companyName: '' }, { companyName: 5 }, { companyName: 'x'.repeat(101) },
    { appTitle: '' }, { appTitle: null }, { appTitle: 'x'.repeat(101) },
    { logoUrl: 'not-a-url' }, { logoUrl: 5 }, { logoUrl: '' },
    { faviconUrl: 'not-a-url' }, { backgroundUrl: 'not-a-url' },
    { primaryColor: 'red' }, { primaryColor: '#12345' }, { primaryColor: '#GGGGGG' },
    { secondaryColor: 'blue' }, { secondaryColor: 5 },
    { defaultTheme: 'blue' }, { defaultTheme: null }, { defaultTheme: 'Dark' },
    { baseCurrency: 'TR' }, { baseCurrency: 'TRYY' }, { baseCurrency: null },
    { dateFormat: 5 }, { dateFormat: null },
    { companyName: 'Synthetic valid name', primaryColor: 'red' },
  ];
  it.each(badFields)('PUT rejects invalid schema field %j before branding query/write/audit', async fields => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send('put', s.tokens.admin, fields), 400);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('PUT rejects non-object payloads without branding work', async () => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    for (const payload of [[], ['companyName'], { companyName: ['x'] }, { defaultTheme: {} }]) denied(await send('put', s.tokens.admin, payload), 400);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('PUT strips unknown/server fields and never trusts client id/timestamp', async () => {
    const s = await setup(), before = snapshot();
    const response = await send('put', s.tokens.admin, {
      companyName: 'Synthetic stripped', id: 'attacker-id', updatedAt: 'attacker-time', role: 'admin',
      userId: 'admin', scope: 'all', unknown: 'ignored', logoUrl: 'https://example.test/new-logo.png',
    });
    expect(response.statusCode).toBe(200); const body = JSON.parse(response.body);
    expect(body.companyName).toBe('Synthetic stripped'); expect(body.logoUrl).toBe('https://example.test/new-logo.png');
    expect(body).not.toHaveProperty('id'); expect(body.updatedAt).not.toBe('attacker-time');
    const stored = globalRow();
    expect(stored.id).toBe('global'); expect(stored.companyName).toBe('Synthetic stripped'); expect(stored.updatedAt).toBe(body.updatedAt);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({ userId: 'admin', action: 'SETTINGS_UPDATE', entity: 'white_label', entityId: 'global', newState: body });
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('PUT applies a partial update, preserves omitted fields and leaves non-global rows untouched', async () => {
    const s = await setup(), before = snapshot();
    const response = await send('put', s.tokens.admin, { primaryColor: '#AABBCC' });
    expect(response.statusCode).toBe(200); const body = JSON.parse(response.body), stored = globalRow();
    expect(body).toEqual(fullDto(stored)); expect(body).not.toHaveProperty('id');
    expectKeys(body, [...definedPublicKeys, 'updatedAt']);
    expect(stored.primaryColor).toBe('#AABBCC');
    for (const key of ['companyName', 'appTitle', 'logoUrl', 'faviconUrl', 'backgroundUrl', 'secondaryColor', 'defaultTheme', 'baseCurrency', 'dateFormat'] as const) {
      expect(stored[key]).toEqual((globalSeed as any)[key]);
    }
    expect(stored.updatedAt).not.toBe(now); expect(new Date(stored.updatedAt).toISOString()).toBe(stored.updatedAt);
    expect(s.db.select().from(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'site1')).get()).toEqual(before.settings.find((row: any) => row.id === 'site1'));
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({
      userId: 'admin', action: 'SETTINGS_UPDATE', entity: 'white_label', entityId: 'global',
      previousState: plain(fullDto(globalSeed)), newState: body,
    });
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('PUT clears nullable URLs while preserving the repository undefined DTO shape', async () => {
    const s = await setup(), before = snapshot();
    const response = await send('put', s.tokens.admin, { logoUrl: null, faviconUrl: null });
    expect(response.statusCode).toBe(200); const body = JSON.parse(response.body);
    expect(body).not.toHaveProperty('logoUrl'); expect(body).not.toHaveProperty('faviconUrl');
    const stored = globalRow(); expect(stored.logoUrl).toBeNull(); expect(stored.faviconUrl).toBeNull();
    const logged = app.auditRepo.listAuditLogs(1, config.masterKey)[0];
    expect(logged.previousState.logoUrl).toBe(globalSeed.logoUrl);
    expect(logged.newState).not.toHaveProperty('logoUrl'); expect(logged.newState).not.toHaveProperty('faviconUrl');
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
  });

  it('PUT keeps an empty dateFormat as a legacy no-op while still auditing the timestamp change', async () => {
    const s = await setup(), before = snapshot();
    const response = await send('put', s.tokens.admin, { dateFormat: '' });
    expect(response.statusCode).toBe(200); const body = JSON.parse(response.body), stored = globalRow();
    expect(stored.dateFormat).toBe(globalSeed.dateFormat); expect(body.dateFormat).toBe(globalSeed.dateFormat);
    expect(stored.updatedAt).not.toBe(now); expect(body.updatedAt).toBe(stored.updatedAt);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
  });

  it('PUT with an empty body preserves legacy timestamp and audit behavior without resetting fields', async () => {
    const s = await setup(), before = snapshot();
    const response = await send('put', s.tokens.admin, {});
    expect(response.statusCode).toBe(200); const body = JSON.parse(response.body), stored = globalRow();
    expect(body).toEqual(fullDto(stored)); expect(stored.updatedAt).not.toBe(now);
    for (const key of ['companyName', 'appTitle', 'logoUrl', 'faviconUrl', 'backgroundUrl', 'primaryColor', 'secondaryColor', 'defaultTheme', 'baseCurrency', 'dateFormat'] as const) {
      expect(stored[key]).toEqual((globalSeed as any)[key]);
    }
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({ previousState: plain(fullDto({ ...globalSeed, updatedAt: now })), newState: body });
  });

  it('PUT seeds repository defaults for a missing global row, then updates and audits atomically', async () => {
    const s = await setup();
    s.db.delete(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).run();
    const before = snapshot();
    const response = await send('put', s.tokens.admin, { appTitle: 'Fresh App' });
    expect(response.statusCode).toBe(200); const body = JSON.parse(response.body), stored = globalRow();
    expect(stored).toEqual({
      id: 'global', companyName: 'TZRCoster Finance', appTitle: 'Fresh App', logoUrl: null, faviconUrl: null, backgroundUrl: null,
      primaryColor: '#2563EB', secondaryColor: '#1E40AF', defaultTheme: 'dark', baseCurrency: 'TRY', dateFormat: 'DD.MM.YYYY',
      updatedAt: body.updatedAt,
    });
    expect(body).toEqual(fullDto(stored)); expect(body).not.toHaveProperty('id');
    expect(s.db.select().from(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'site1')).get()).toEqual(otherSeed);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({
      userId: 'admin', action: 'SETTINGS_UPDATE', entity: 'white_label', entityId: 'global', previousState: null, newState: body,
    });
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('PUT validation failure on a missing global row inserts nothing', async () => {
    const s = await setup();
    s.db.delete(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).run();
    const before = snapshot(), spies = workSpies();
    denied(await send('put', s.tokens.admin, { primaryColor: 'red' }), 400);
    expect(globalRow()).toBeUndefined(); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('rolls back a real white_label_settings insert failure for a missing row and retries', async () => {
    const s = await setup();
    s.db.delete(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).run();
    const before = snapshot();
    s.db.run(sql`CREATE TRIGGER synthetic_settings_insert_failure BEFORE INSERT ON white_label_settings BEGIN SELECT RAISE(ABORT, 'Synthetic private row failure'); END`);
    denied(await send('put', s.tokens.admin), 500);
    expect(snapshot()).toEqual(before); expect(globalRow()).toBeUndefined();
    s.db.run(sql`DROP TRIGGER synthetic_settings_insert_failure`);
    expect((await send('put', s.tokens.admin)).statusCode).toBe(200);
    expect(globalRow()).toBeDefined(); expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('rolls back the seeded default insert when the following update fails, then retries', async () => {
    const s = await setup();
    s.db.delete(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).run();
    const before = snapshot();
    s.db.run(sql`CREATE TRIGGER synthetic_settings_missing_update_failure BEFORE UPDATE ON white_label_settings BEGIN SELECT RAISE(ABORT, 'Synthetic private update failure'); END`);
    denied(await send('put', s.tokens.admin, { companyName: 'Synthetic missing update rollback' }), 500);
    // The default INSERT happened before the failing UPDATE and must roll back with it.
    expect(globalRow()).toBeUndefined(); expect(snapshot()).toEqual(before);
    s.db.run(sql`DROP TRIGGER synthetic_settings_missing_update_failure`);
    expect((await send('put', s.tokens.admin, { companyName: 'Synthetic missing update rollback' })).statusCode).toBe(200);
    expect(globalRow()).toMatchObject({
      id: 'global', companyName: 'Synthetic missing update rollback', primaryColor: '#2563EB', baseCurrency: 'TRY',
    });
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('rolls back the seeded default row when audit insert fails AFTER the real insert, then retries', async () => {
    const s = await setup();
    s.db.delete(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).run();
    const before = snapshot();
    s.db.run(sql`CREATE TRIGGER synthetic_settings_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'Synthetic private audit failure'); END`);
    denied(await send('put', s.tokens.admin, { companyName: 'Synthetic audit rollback' }), 500);
    expect(globalRow()).toBeUndefined(); expect(snapshot()).toEqual(before);
    s.db.run(sql`DROP TRIGGER synthetic_settings_audit_failure`);
    expect((await send('put', s.tokens.admin, { companyName: 'Synthetic audit rollback' })).statusCode).toBe(200);
    expect(globalRow()?.companyName).toBe('Synthetic audit rollback');
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('rolls back a real white_label_settings update failure and retries', async () => {
    const s = await setup(), before = snapshot();
    s.db.run(sql`CREATE TRIGGER synthetic_settings_update_failure BEFORE UPDATE ON white_label_settings BEGIN SELECT RAISE(ABORT, 'Synthetic private update failure'); END`);
    denied(await send('put', s.tokens.admin, { companyName: 'Synthetic update rollback' }), 500);
    expect(snapshot()).toEqual(before);
    s.db.run(sql`DROP TRIGGER synthetic_settings_update_failure`);
    expect((await send('put', s.tokens.admin, { companyName: 'Synthetic update rollback' })).statusCode).toBe(200);
    expect(globalRow()?.companyName).toBe('Synthetic update rollback');
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('rolls back the real update when audit insert fails AFTER it, then retries', async () => {
    const s = await setup(), before = snapshot();
    s.db.run(sql`CREATE TRIGGER synthetic_settings_existing_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'Synthetic private audit failure'); END`);
    denied(await send('put', s.tokens.admin, { companyName: 'Synthetic existing rollback' }), 500);
    expect(snapshot()).toEqual(before);
    s.db.run(sql`DROP TRIGGER synthetic_settings_existing_audit_failure`);
    expect((await send('put', s.tokens.admin, { companyName: 'Synthetic existing rollback' })).statusCode).toBe(200);
    expect(globalRow()?.companyName).toBe('Synthetic existing rollback');
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it.each(['existing', 'missing'] as const)('rolls back AFTER a real audit insert for a %s global row, with safe errors, and retries', async variant => {
    const s = await setup();
    if (variant === 'missing') s.db.delete(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).run();
    const before = snapshot(), original = AuditLogRepository.prototype.logAction;
    expect(before.settings.some((row: any) => row.id === 'global')).toBe(variant === 'existing');
    let inserted = false;
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args: any[]) {
      const logged = original.apply(this, args); expect(this.db).not.toBe(s.db);
      expect(this.db.select().from(auditLogs).where(eq(auditLogs.id, logged.id)).get()).toBeDefined();
      expect(this.db.select().from(whiteLabelSettings).where(eq(whiteLabelSettings.id, 'global')).get()?.companyName).toBe('Synthetic audit-after-insert');
      inserted = true; throw new Error('Synthetic private failure enc:v1:payload SQLITE_failure');
    });
    denied(await send('put', s.tokens.admin, { companyName: 'Synthetic audit-after-insert' }), 500);
    expect(inserted).toBe(true); expect(audit).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(before);
    if (variant === 'missing') expect(globalRow()).toBeUndefined();
    audit.mockRestore();
    expect((await send('put', s.tokens.admin, { companyName: 'Synthetic audit-after-insert' })).statusCode).toBe(200);
    expect(globalRow()?.companyName).toBe('Synthetic audit-after-insert');
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it.each(['get', 'put'] as const)('%s keeps synchronous work in one transaction and commits before serialization', async endpoint => {
    const s = await setup(); let currentTx: any, committed = false, serializations = 0, settingsQueries = 0, settingsWrites = 0, freshCalls = 0;
    const order: string[] = [], transaction = s.db.transaction, fresh = app.projectAccess.requireFreshActor, log = AuditLogRepository.prototype.logAction;
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation((value: any, replacer?: any, space?: any) => {
      const responsePayload = endpoint === 'get'
        ? value?.companyName === globalSeed.companyName && value?.updatedAt === undefined && value?.appTitle === globalSeed.appTitle
        : value?.companyName === 'Synthetic serialized update' && typeof value?.updatedAt === 'string';
      if (responsePayload) { serializations++; expect(committed).toBe(true); expect(currentTx).toBeUndefined(); }
      return stringify(value, replacer, space);
    });
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, options: any) => {
      // Exact options per endpoint: the public read passes none, the admin write is immediate.
      expect(options).toEqual(endpoint === 'put' ? { behavior: 'immediate' } : undefined);
      const result = transaction.call(s.db, (tx: any) => {
        currentTx = tx;
        const select = tx.select;
        tx.select = function (this: any, ...args: any[]) {
          expect(currentTx).toBe(tx); const builder = select.apply(this, args), from = builder.from;
          builder.from = function (table: any) {
            if (table === whiteLabelSettings) {
              // GET never authenticates or runs a fresh-actor check before reading.
              if (endpoint === 'put') expect(order[0]).toBe('fresh');
              settingsQueries++;
            }
            return from.call(this, table);
          };
          return builder;
        };
        for (const method of ['insert', 'update', 'delete'] as const) {
          const original = tx[method];
          tx[method] = function (this: any, table: any, ...rest: any[]) {
            expect(currentTx).toBe(tx); expect(order[0]).toBe('fresh');
            if (table === whiteLabelSettings) settingsWrites++;
            return original.call(this, table, ...rest);
          };
        }
        try { const value = callback(tx); expect(value).not.toBeInstanceOf(Promise); return value; }
        finally { currentTx = undefined; }
      }, options);
      committed = true; return result;
    });
    app.projectAccess.requireFreshActor = function (tx: any, ...args: any[]) {
      freshCalls++; expect(tx).toBe(currentTx); const result = fresh.call(this, tx, ...args); order.push('fresh'); return result;
    };
    vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args: any[]) {
      expect(this.db).toBe(currentTx); expect(order).toEqual(['fresh']); order.push('audit'); return log.apply(this, args);
    });
    try {
      // GET is exercised without an Authorization header and must stay public.
      const response = await send(endpoint, endpoint === 'put' ? s.tokens.admin : undefined, endpoint === 'put' ? { companyName: 'Synthetic serialized update' } : undefined);
      expect(response.statusCode).toBe(200);
      expect(serializations).toBe(1); expect(committed).toBe(true); expect(currentTx).toBeUndefined();
      expect(freshCalls).toBe(endpoint === 'put' ? 1 : 0);
      expect(order).toEqual(endpoint === 'put' ? ['fresh', 'audit'] : []);
      expect(settingsQueries).toBe(endpoint === 'put' ? 2 : 1);
      expect(settingsWrites).toBe(endpoint === 'put' ? 1 : 0);
    } finally { app.projectAccess.requireFreshActor = fresh; }
  });
});
