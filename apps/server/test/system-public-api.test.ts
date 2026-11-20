import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogRepository, auditLogs, projects, users, whiteLabelSettings } from '@cost-core/database';
import { buildApp } from '../src/app.js';

// All rows, tokens, headers and error strings below are synthetic. The app is
// built with explicit test configuration and an in-memory database only.
const config = {
  jwtSecret: 'test-jwt-secret-very-long-and-secure-1234',
  masterKey: 'test-master-key-32-bytes-long-1234',
  blindIndexPepper: 'test-pepper-for-blind-index-1234',
  bootstrapToken: 'synthetic-bootstrap-token-32chars',
};
const now = '2026-01-01T00:00:00.000Z';
const publicKeys = ['needsSetup', 'isFirstRun', 'hasUsers', 'companyName', 'baseCurrency'];
const genericError = { error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' };
const defaults = { needsSetup: true, isFirstRun: true, hasUsers: false, companyName: 'TZRCoster Finance', baseCurrency: 'TRY' };
const templates = [
  { id: 'construction', title: '🏗️ İnşaat, Taahhüt & Şantiye', description: 'Kaba yapı, ince işler, elektrik-mekanik, taşeron hakedişleri ve şantiye genel giderleri', categoryCount: 16 },
  { id: 'manufacturing', title: '🏭 İmalat, Üretim & Fabrika', description: 'Hammadde, makine bakım, lojistik, ambalaj, üretim işçiliği ve enerji giderleri', categoryCount: 12 },
  { id: 'software', title: '💻 Yazılım, Teknoloji & SaaS', description: 'Bulut sunucu (AWS/GCP), SaaS yazılım lisansları, freelance geliştirici ve reklam bütçeleri', categoryCount: 10 },
  { id: 'general', title: '🏢 Genel İşletme & Hizmet', description: 'Ofis kirası, personel maaşları, muhasebe/hukuk, faturalar ve genel operasyonel maliyetler', categoryCount: 10 },
  { id: 'blank', title: '⚪ Sıfırdan Boş Başlangıç', description: 'Kendi özel kategori ağacını sıfırdan tamamen kendin oluştur', categoryCount: 1 },
];
let app: any;
afterEach(async () => { vi.restoreAllMocks(); if (app) { await app.close(); app = undefined; } });

function tableName(table: any) {
  if (table === users) return 'users';
  if (table === whiteLabelSettings) return 'white_label_settings';
  if (table === projects) return 'projects';
  return String(table?.[Symbol.for('drizzle:Name')] ?? 'unknown');
}

// Observe the SQL actually executed inside the read transaction, every write
// attempt, whether the transaction callback is synchronous, and whether the
// transaction really committed (the driver returned after COMMIT) before the
// response was emitted.
function instrument() {
  const state: any = {
    txCalls: 0, open: 0, commits: 0, rolledBack: 0, callbackReturns: [] as any[], callbackReturnedPromise: false,
    sends: 0, respondOpen: null, committedBeforeSend: null,
    tables: [] as string[], selections: [] as any[], writes: [] as string[],
  };
  const original = app.db.transaction;
  vi.spyOn(app.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => {
    state.txCalls++;
    let result: any;
    try {
      result = original.call(app.db, (tx: any) => {
        state.open++;
        try {
          const select = tx.select;
          tx.select = function (this: any, ...selection: any[]) {
            const builder = select.apply(this, selection);
            const from = builder.from;
            builder.from = function (this: any, table: any) {
              const name = tableName(table);
              state.tables.push(name);
              const query = from.call(this, table);
              for (const method of ['get', 'all'] as const) {
                const execute = query[method];
                if (typeof execute === 'function') {
                  query[method] = function (this: any, ...params: any[]) {
                    const built = this.toSQL();
                    state.selections.push({ table: name, method, keys: Object.keys(selection[0] ?? {}), sql: built.sql, params: built.params });
                    return execute.apply(this, params);
                  };
                }
              }
              return query;
            };
            return builder;
          };
          for (const method of ['insert', 'update', 'delete'] as const) {
            const execute = tx[method];
            tx[method] = function (this: any, table: any, ...rest: any[]) {
              state.writes.push(method + ':' + tableName(table));
              return execute.call(this, table, ...rest);
            };
          }
          const value = callback(tx);
          state.callbackReturns.push(value);
          if (value !== null && typeof value?.then === 'function') state.callbackReturnedPromise = true;
          return value;
        } finally {
          state.open--;
        }
      }, ...args);
    } catch (error) {
      state.rolledBack++;
      throw error;
    }
    // The synchronous better-sqlite3 driver has COMMITed by the time the call returns.
    state.commits++;
    return result;
  });
  app.addHook('onSend', async (request: any, _reply: any, payload: any) => {
    if (request.url.startsWith('/api/system/status')) {
      state.sends++;
      state.respondOpen = state.open;
      state.committedBeforeSend = state.commits;
    }
    return payload;
  });
  return state;
}

async function setup(options: { instrument?: boolean } = {}) {
  app = await buildApp({ config, dbPath: ':memory:' });
  const state = options.instrument ? instrument() : undefined;
  await app.ready();
  return state;
}
function status(options: { query?: string; headers?: Record<string, any> } = {}) {
  return app.inject({ method: 'GET', url: '/api/system/status' + (options.query ?? ''), headers: options.headers ?? {} });
}
function seedUser(id: string, extra: Record<string, any> = {}) {
  app.db.insert(users).values({
    id, username: id, email: id + '@example.test', fullName: 'Synthetic User', passwordHash: 'synthetic-hash',
    role: 'viewer', isActive: true, createdAt: now, updatedAt: now, ...extra,
  }).run();
}
function seedSettings(id: string, extra: Record<string, any> = {}) {
  app.db.insert(whiteLabelSettings).values({ id, updatedAt: now, ...extra }).run();
}
function seedProject(id: string) {
  app.db.insert(projects).values({ id, name: id, createdAt: now, updatedAt: now }).run();
}
function expectPublicShape(body: any) {
  expect(Object.keys(body).sort()).toEqual([...publicKeys].sort());
  for (const removed of ['userCount', 'projectCount', 'id', 'updatedAt']) expect(body).not.toHaveProperty(removed);
}
function setupPayload(username = 'setup_admin') {
  return {
    companyName: 'Synthetic Setup Co', baseCurrency: 'TRY',
    admin: { username, fullName: 'Setup Admin', email: username + '@example.test', password: 'Synthetic-Pass-1234', pin: '1234' },
    industryTemplate: 'blank',
  };
}

describe('public system status contract', () => {
  it('returns exactly the five public fields on an empty database without seeding', async () => {
    const state = (await setup({ instrument: true }))!;
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    const listUsers = vi.spyOn(app.userRepo, 'listUsers');
    const listProjects = vi.spyOn(app.projectRepo, 'listProjects');
    const getSettings = vi.spyOn(app.whiteLabelRepo, 'getSettings');

    const first = await status();
    expect(first.statusCode).toBe(200);
    const body = JSON.parse(first.body);
    expect(body).toEqual(defaults);
    expectPublicShape(body);

    expect(state.txCalls).toBe(1);
    expect(state.commits).toBe(1);
    expect(state.callbackReturns).toHaveLength(1);
    expect(state.callbackReturnedPromise).toBe(false);
    expect(state.sends).toBe(1);
    expect(state.respondOpen).toBe(0);
    expect(state.committedBeforeSend).toBe(1);
    expect(state.open).toBe(0);
    expect(state.tables).toEqual(['users', 'white_label_settings']);
    expect(state.writes).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();

    const userProbe = state.selections[0];
    expect(userProbe.table).toBe('users');
    expect(userProbe.method).toBe('get');
    expect(userProbe.keys).toEqual(['exists']);
    expect(userProbe.sql.replace(/\s+/g, ' ').trim()).toBe('select 1 from "users" limit ?');
    expect(userProbe.params).toEqual([1]);
    for (const column of ['count(', 'username', 'email', 'full_name', 'password_hash', 'role', 'is_active', 'two_factor']) {
      expect(userProbe.sql.toLowerCase()).not.toContain(column);
    }

    const settingsProbe = state.selections[1];
    expect(settingsProbe.table).toBe('white_label_settings');
    expect(settingsProbe.method).toBe('get');
    expect(settingsProbe.keys.sort()).toEqual(['baseCurrency', 'companyName']);
    expect(settingsProbe.sql).toContain('"company_name"');
    expect(settingsProbe.sql).toContain('"base_currency"');
    expect(settingsProbe.sql).toContain('"id"');
    for (const column of ['app_title', 'logo_url', 'favicon_url', 'background_url', 'primary_color', 'secondary_color', 'default_theme', 'date_format', 'updated_at']) {
      expect(settingsProbe.sql).not.toContain(column);
    }

    const second = await status();
    expect(JSON.parse(second.body)).toEqual(body);
    expect(state.commits).toBe(2);
    expect(state.committedBeforeSend).toBe(2);
    expect(state.writes).toEqual([]);
    expect(app.db.select().from(users).all()).toHaveLength(0);
    expect(app.db.select().from(whiteLabelSettings).all()).toHaveLength(0);
    expect(app.db.select().from(projects).all()).toHaveLength(0);
    expect(app.db.select().from(auditLogs).all()).toHaveLength(0);
  });

  it('treats an inactive-only user as already bootstrapped and keeps setup fail-closed', async () => {
    await setup();
    seedUser('inactive-user', { isActive: false });
    const perform = vi.spyOn(app.setupRepo, 'performSetup');

    const res = await status();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ needsSetup: false, isFirstRun: false, hasUsers: true, companyName: 'TZRCoster Finance', baseCurrency: 'TRY' });
    expectPublicShape(body);

    const setupRes = await app.inject({ method: 'POST', url: '/api/system/setup', headers: { 'x-setup-token': config.bootstrapToken }, payload: setupPayload() });
    expect(setupRes.statusCode).toBe(403);
    const setupBody = JSON.parse(setupRes.body);
    expect(setupBody.token).toBeUndefined();
    expect(setupRes.body).not.toContain(config.bootstrapToken);
    expect(perform).not.toHaveBeenCalled();
    expect(app.db.select().from(users).all()).toHaveLength(1);
    expect(app.db.select().from(projects).all()).toHaveLength(0);
    expect(app.db.select().from(whiteLabelSettings).all()).toHaveLength(0);
    expect(app.db.select().from(auditLogs).all()).toHaveLength(0);
  });

  it('reports hasUsers for active and multiple users without counts or personal fields', async () => {
    await setup();
    seedUser('active-one');
    seedUser('active-two', { role: 'admin' });
    seedUser('active-three', { isActive: false });

    const res = await status();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ needsSetup: false, isFirstRun: false, hasUsers: true, companyName: 'TZRCoster Finance', baseCurrency: 'TRY' });
    expectPublicShape(body);
    expect(res.body).not.toContain('active-one');
    expect(res.body).not.toContain('@example.test');
    expect(res.body).not.toContain('viewer');
  });

  it('never reads projects and stays in bootstrap mode when only projects exist', async () => {
    const state = (await setup({ instrument: true }))!;
    seedProject('project-one');
    seedProject('project-two');
    const listProjects = vi.spyOn(app.projectRepo, 'listProjects');
    const requireFresh = vi.spyOn(app.projectAccess, 'requireFreshAdmin');

    const res = await status();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(defaults);
    expect(state.tables).toEqual(['users', 'white_label_settings']);
    expect(state.tables).not.toContain('projects');
    expect(state.writes).toEqual([]);
    expect(listProjects).not.toHaveBeenCalled();
    expect(requireFresh).not.toHaveBeenCalled();
  });

  it('reads only the global settings row and defaults in memory when it is missing', async () => {
    const state = (await setup({ instrument: true }))!;
    seedSettings('site-one', { companyName: 'Other Co', baseCurrency: 'EUR' });

    const before = await status();
    expect(JSON.parse(before.body)).toEqual(defaults);
    expect(app.db.select().from(whiteLabelSettings).all()).toHaveLength(1);

    seedSettings('global', { companyName: 'Synthetic Global Co', baseCurrency: 'USD' });
    const after = await status();
    expect(JSON.parse(after.body)).toEqual({ needsSetup: true, isFirstRun: true, hasUsers: false, companyName: 'Synthetic Global Co', baseCurrency: 'USD' });
    expectPublicShape(JSON.parse(after.body));

    const queried = state.selections.filter((selection: any) => selection.table === 'white_label_settings');
    expect(queried).toHaveLength(2);
    expect(state.writes).toEqual([]);
    expect(app.db.select().from(whiteLabelSettings).all()).toHaveLength(2);
    expect(app.db.select().from(auditLogs).all()).toHaveLength(0);
  });

  it('stays public and unchanged for invalid bearer and query/header smuggling', async () => {
    await setup();
    seedSettings('global', { companyName: 'Synthetic Global Co', baseCurrency: 'USD' });
    const query = '?role=admin&userId=emp&scope=all&fields=id,userCount,projectCount&companyName=Injected';
    const res = await status({
      query,
      headers: {
        authorization: 'Bearer synthetic-invalid-token',
        'x-user-role': 'admin',
        'x-user-id': 'emp',
        'x-setup-token': 'synthetic-smuggled-token',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ needsSetup: true, isFirstRun: true, hasUsers: false, companyName: 'Synthetic Global Co', baseCurrency: 'USD' });
    expectPublicShape(body);
    expect(res.body).not.toContain('Injected');
    expect(res.body).not.toContain('userCount');
    expect(res.body).not.toContain('projectCount');
  });

  it('keeps users and settings reads inside one synchronous transaction that commits before the response', async () => {
    const state = (await setup({ instrument: true }))!;
    seedUser('active-user');
    seedSettings('global', { companyName: 'Synthetic Global Co', baseCurrency: 'USD' });

    const res = await status();
    expect(res.statusCode).toBe(200);
    expect(state.txCalls).toBe(1);
    expect(state.selections).toHaveLength(2);
    expect(state.selections.map((selection: any) => selection.table)).toEqual(['users', 'white_label_settings']);
    expect(state.callbackReturns).toHaveLength(1);
    expect(state.callbackReturnedPromise).toBe(false);
    expect(state.rolledBack).toBe(0);
    expect(state.commits).toBe(1);
    expect(state.sends).toBe(1);
    expect(state.respondOpen).toBe(0);
    expect(state.committedBeforeSend).toBe(1);
    expect(state.open).toBe(0);
  });

  it('returns a safe generic 500 on database failure and recovers on retry', async () => {
    await setup();
    seedSettings('global', { companyName: 'Synthetic Global Co', baseCurrency: 'USD' });
    const original = app.db.transaction;

    const throwAtCall = vi.spyOn(app.db, 'transaction').mockImplementationOnce(() => {
      throw new Error('SQLITE_IOERR synthetic private database path');
    });
    const failed = await status();
    expect(failed.statusCode).toBe(500);
    expect(JSON.parse(failed.body)).toEqual(genericError);
    expect(failed.body).not.toContain('SQLITE');
    expect(failed.body).not.toContain('synthetic private');
    throwAtCall.mockRestore();

    const throwInside = vi.spyOn(app.db, 'transaction').mockImplementationOnce((callback: any, ...args: any[]) =>
      original.call(app.db, (tx: any) => {
        callback(tx);
        throw new Error('SQLITE_BUSY synthetic');
      }, ...args));
    const failedInside = await status();
    expect(failedInside.statusCode).toBe(500);
    expect(JSON.parse(failedInside.body)).toEqual(genericError);
    expect(failedInside.body).not.toContain('SQLITE_BUSY');
    throwInside.mockRestore();

    const retry = await status();
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(retry.body)).toEqual({ needsSetup: true, isFirstRun: true, hasUsers: false, companyName: 'Synthetic Global Co', baseCurrency: 'USD' });
  });

  it('serves the static templates without touching the database', async () => {
    await setup();
    const transaction = vi.spyOn(app.db, 'transaction');
    const listUsers = vi.spyOn(app.userRepo, 'listUsers');
    const listProjects = vi.spyOn(app.projectRepo, 'listProjects');
    const getSettings = vi.spyOn(app.whiteLabelRepo, 'getSettings');
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');

    const res = await app.inject({ method: 'GET', url: '/api/system/templates' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(templates);
    expect(transaction).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(app.db.select().from(whiteLabelSettings).all()).toHaveLength(0);
  });

  it('keeps the setup route token and empty-database guard behavior', async () => {
    await setup();
    const wrong = await app.inject({ method: 'POST', url: '/api/system/setup', headers: { 'x-setup-token': 'synthetic-wrong-bootstrap-token-32x' }, payload: setupPayload() });
    expect(wrong.statusCode).toBe(403);
    expect(app.db.select().from(users).all()).toHaveLength(0);

    const accepted = await app.inject({ method: 'POST', url: '/api/system/setup', headers: { 'x-setup-token': config.bootstrapToken }, payload: setupPayload() });
    expect(accepted.statusCode).toBe(201);
    const acceptedBody = JSON.parse(accepted.body);
    expect(acceptedBody.token).toBeDefined();
    expect(app.db.select().from(users).all()).toHaveLength(1);

    const replay = await app.inject({ method: 'POST', url: '/api/system/setup', headers: { 'x-setup-token': config.bootstrapToken }, payload: setupPayload('setup_admin_two') });
    expect(replay.statusCode).toBe(403);
    expect(app.db.select().from(users).all()).toHaveLength(1);
  });
});
