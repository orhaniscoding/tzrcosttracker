import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { AuditLogRepository, users, projects, customFields, auditLogs, authSessions, projectMemberships } from '@cost-core/database';
import { buildApp } from '../src/app.js';

// All users, sessions, tokens, definitions and encryption inputs are synthetic.
// buildApp receives explicit configuration and an in-memory database only.
const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
const nonadmins = ['manager', 'accountant', 'auditor', 'viewer'].flatMap(role => [role, 'unassigned-' + role]);
const roles = ['admin', ...nonadmins];
const definitionKeys = ['id', 'name', 'label', 'type', 'optionsJson', 'unit', 'required', 'placeholder', 'defaultValue'].sort();
const responseKeys = ['id', 'name', 'label', 'type', 'options', 'unit', 'required', 'placeholder', 'defaultValue'].sort();
const sqlColumns = ['id', 'name', 'label', 'type', 'options_json', 'unit', 'required', 'placeholder', 'default_value'];
const genericError = { error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' };
const now = '2026-01-01T00:00:00.000Z';
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
  db.insert(customFields).values({
    id: 'full', name: 'plaka_no', label: 'Plaka No', type: 'select', optionsJson: JSON.stringify(['A', 'B']),
    unit: 'adet', required: true, placeholder: 'Plaka', defaultValue: '34ABC', createdAt: now,
  }).run();
  db.insert(customFields).values({
    id: 'minimal', name: 'notlar', label: 'Notlar', type: 'text', optionsJson: null,
    unit: null, required: false, placeholder: null, defaultValue: null, createdAt: now,
  }).run();
  app.auditRepo.logAction({ userId: 'admin', action: 'CREATE', entity: 'synthetic', entityId: 'fixture', newState: { synthetic: true } }, config.masterKey);
  return { db, tokens, sessions };
}
function snapshot() {
  return {
    customFields: app.db.select().from(customFields).orderBy(customFields.id).all(),
    auditLogs: app.db.select().from(auditLogs).orderBy(auditLogs.id).all(),
    users: app.db.select().from(users).orderBy(users.id).all(),
    sessions: app.db.select().from(authSessions).orderBy(authSessions.id).all(),
    memberships: app.db.select().from(projectMemberships).orderBy(projectMemberships.userId, projectMemberships.projectId).all(),
    projects: app.db.select().from(projects).orderBy(projects.id).all(),
  };
}
// Mirrors CustomFieldRepository.listCustomFields exactly: JSON options and
// null-to-undefined fallbacks, no createdAt, repository row order preserved.
function dto(row: any) {
  return {
    id: row.id, name: row.name, label: row.label, type: row.type,
    options: row.optionsJson ? JSON.parse(row.optionsJson) : undefined,
    unit: row.unit || undefined, required: row.required,
    placeholder: row.placeholder || undefined, defaultValue: row.defaultValue || undefined,
  };
}
function send(kind: 'get' | 'create', token?: string, payload?: any) {
  const smuggling = 'role=admin&userId=admin&projectId=site2&scope=all&fields=createdAt,created_at';
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  if (kind === 'get') return app.inject({ method: 'GET', url: '/api/custom-fields?' + smuggling, headers });
  return app.inject({ method: 'POST', url: '/api/custom-fields?' + smuggling, headers, payload: payload ?? { name: 'Synthetic custom field', label: 'Synthetic label', type: 'text' } });
}
function denied(response: any, status: number) {
  expect(response.statusCode).toBe(status); const body = JSON.parse(response.body);
  if (status === 401) expect(body.code).toBe('SESSION_INVALID');
  if (status === 500) expect(body).toEqual(genericError);
  for (const text of ['Synthetic private', 'enc:v1:', 'SQLITE_', 'not-json']) expect(response.body).not.toContain(text);
}
// Observe the executed definition SQL, not just the final response payload.
function workSpies() {
  const transaction = app.db.transaction, selections = vi.fn();
  vi.spyOn(app.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => transaction.call(app.db, (tx: any) => {
    const select = tx.select;
    tx.select = function (this: any, ...selection: any[]) {
      const builder = select.apply(this, selection), from = builder.from;
      builder.from = function (table: any) {
        const query = from.call(this, table);
        if (table === customFields) for (const method of ['all', 'get'] as const) {
          const execute = query[method];
          query[method] = function (...params: any[]) { selections(selection[0], this.toSQL().sql); return execute.apply(this, params); };
        }
        return query;
      };
      return builder;
    };
    return callback(tx);
  }, ...args));
  return { selections, audit: vi.spyOn(AuditLogRepository.prototype, 'logAction') };
}
function noWork(spies: ReturnType<typeof workSpies>) { expect(spies.selections).not.toHaveBeenCalled(); expect(spies.audit).not.toHaveBeenCalled(); }
async function duringFresh(mutate: (tx: any, uid: string, sid: string, expiry: number) => void, run: () => Promise<any>) {
  const fresh = app.projectAccess.requireFreshActor; let calls = 0;
  app.projectAccess.requireFreshActor = function (tx: any, uid: string, sid: string, expiry: number) {
    calls++; expect(tx).not.toBe(app.db); mutate(tx, uid, sid, expiry); return fresh.call(this, tx, uid, sid, expiry);
  };
  try { const response = await run(); expect(calls).toBe(1); return response; }
  finally { app.projectAccess.requireFreshActor = fresh; }
}
function expectProjection(spies: ReturnType<typeof workSpies>) {
  expect(spies.selections).toHaveBeenCalledTimes(1);
  const [selection, statement] = spies.selections.mock.calls[0];
  expect(Object.keys(selection).sort()).toEqual(definitionKeys);
  const projection = statement.slice(0, statement.indexOf(' from '));
  for (const column of sqlColumns) expect(projection).toContain('"' + column + '"');
  expect(projection).not.toContain('"created_at"');
}

describe('custom field definitions: shared reads and atomic admin creation', () => {
  it.each(roles)('%s GET uses fresh SQL projection regardless of membership or client claims', async role => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    const response = await send('get', s.tokens[role]);
    expect(response.statusCode).toBe(200);
    const rows = JSON.parse(response.body), full = before.customFields.find((row: any) => row.id === 'full');
    expect(rows).toEqual([dto(full), dto(before.customFields.find((row: any) => row.id === 'minimal'))]);
    expect(Object.keys(rows[0]).sort()).toEqual(responseKeys);
    for (const row of rows) expect(row).not.toHaveProperty('createdAt');
    expectProjection(spies); expect(spies.audit).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
  });

  it('GET rejects missing or invalid authentication before any definition query', async () => {
    await setup(); const before = snapshot(), spies = workSpies();
    denied(await send('get'), 401); denied(await send('get', 'invalid-token'), 401);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('GET ignores forged JWT/client admin claims and follows a same-token database role change', async () => {
    const s = await setup();
    s.db.update(users).set({ role: 'manager' }).where(eq(users.id, 'admin')).run();
    const forged = app.jwt.sign({ id: 'manager', username: 'manager', role: 'admin', sid: s.sessions.manager.id, exp: s.sessions.manager.expiresAt });
    const spies = workSpies();
    for (const token of [s.tokens.admin, forged]) {
      const before = snapshot();
      spies.selections.mockClear();
      const response = await send('get', token); expect(response.statusCode).toBe(200);
      const rows = JSON.parse(response.body);
      expect(Object.keys(rows[0]).sort()).toEqual(responseKeys);
      expectProjection(spies); expect(snapshot()).toEqual(before);
    }
  });

  it('GET rechecks an auth-to-tx downgrade in the same read transaction', async () => {
    const s = await setup(), spies = workSpies();
    const response = await duringFresh((tx, uid) => tx.update(users).set({ role: 'manager' }).where(eq(users.id, uid)).run(), () => send('get', s.tokens.admin));
    expect(response.statusCode).toBe(200);
    for (const row of JSON.parse(response.body)) expect(row).not.toHaveProperty('createdAt');
    expectProjection(spies);
  });

  for (const state of ['revoked', 'inactive', 'missing-user', 'invalid-role', 'missing-session', 'changed-expiry', 'wrong-session-owner'] as const) {
    it(`GET rejects ${state} between authentication and transaction`, async () => {
      const s = await setup(), before = snapshot(), spies = workSpies();
      denied(await duringFresh((tx, uid, sid, expiry) => {
        if (state === 'revoked') tx.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, sid)).run();
        if (state === 'inactive') tx.update(users).set({ isActive: false }).where(eq(users.id, uid)).run();
        if (state === 'missing-user') tx.delete(users).where(eq(users.id, uid)).run();
        if (state === 'invalid-role') tx.update(users).set({ role: 'invalid' }).where(eq(users.id, uid)).run();
        if (state === 'missing-session') tx.delete(authSessions).where(eq(authSessions.id, sid)).run();
        if (state === 'changed-expiry') tx.update(authSessions).set({ expiresAt: expiry + 1 }).where(eq(authSessions.id, sid)).run();
        if (state === 'wrong-session-owner') tx.update(authSessions).set({ userId: 'manager' }).where(eq(authSessions.id, sid)).run();
      }, () => send('get', s.tokens.admin)), 401);
      noWork(spies); expect(snapshot()).toEqual(before);
    });
  }

  for (const offset of [0, 1]) it(`GET rejects exact/elapsed expiry +${offset}s inside transaction`, async () => {
    const s = await setup(), before = snapshot(), spies = workSpies(); let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      denied(await duringFresh((_tx, _uid, _sid, expiry) => { clock = vi.spyOn(Date, 'now').mockReturnValue((expiry + offset) * 1000); }, () => send('get', s.tokens.admin)), 401);
      noWork(spies); expect(snapshot()).toEqual(before);
    } finally { clock?.mockRestore(); }
  });

  it('GET rejects an already revoked session before definition work', async () => {
    const s = await setup();
    s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, s.sessions.viewer.id)).run();
    const before = snapshot(), spies = workSpies();
    denied(await send('get', s.tokens.viewer), 401); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('GET returns a generic 500 for malformed stored options JSON with no reflection or writes', async () => {
    const s = await setup();
    s.db.insert(customFields).values({
      id: 'broken', name: 'broken', label: 'Broken', type: 'select', optionsJson: '{not-json',
      unit: null, required: false, placeholder: null, defaultValue: null, createdAt: now,
    }).run();
    const before = snapshot(), spies = workSpies();
    denied(await send('get', s.tokens.viewer), 500);
    expect(spies.audit).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
  });

  it('POST denies every nonadmin before validation, definition query or audit', async () => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    for (const role of nonadmins) {
      denied(await send('create', s.tokens[role]), 403);
      denied(await send('create', s.tokens[role], { name: null, label: null, type: 'garbage', role: 'admin', userId: 'admin', scope: 'all' }), 403);
    }
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('POST rejects missing or invalid authentication before definition work', async () => {
    await setup(); const before = snapshot(), spies = workSpies();
    denied(await send('create'), 401); denied(await send('create', 'invalid-token'), 401);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('POST ignores forged JWT/client admin claims and follows the fresh database role', async () => {
    const s = await setup();
    s.db.update(users).set({ role: 'manager' }).where(eq(users.id, 'admin')).run();
    const forged = app.jwt.sign({ id: 'manager', username: 'manager', role: 'admin', sid: s.sessions.manager.id, exp: s.sessions.manager.expiresAt });
    const before = snapshot(), spies = workSpies();
    for (const token of [s.tokens.admin, forged]) denied(await send('create', token), 403);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('POST rechecks admin before malformed input validation in the transaction', async () => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await duringFresh((tx, uid) => tx.update(users).set({ role: 'manager' }).where(eq(users.id, uid)).run(), () => send('create', s.tokens.admin, {})), 403);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  for (const state of ['revoked', 'inactive', 'missing-user', 'invalid-role', 'missing-session', 'changed-expiry', 'wrong-session-owner'] as const) {
    it(`POST rejects ${state} between authentication and transaction`, async () => {
      const s = await setup(), before = snapshot(), spies = workSpies();
      denied(await duringFresh((tx, uid, sid, expiry) => {
        if (state === 'revoked') tx.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, sid)).run();
        if (state === 'inactive') tx.update(users).set({ isActive: false }).where(eq(users.id, uid)).run();
        if (state === 'missing-user') tx.delete(users).where(eq(users.id, uid)).run();
        if (state === 'invalid-role') tx.update(users).set({ role: 'invalid' }).where(eq(users.id, uid)).run();
        if (state === 'missing-session') tx.delete(authSessions).where(eq(authSessions.id, sid)).run();
        if (state === 'changed-expiry') tx.update(authSessions).set({ expiresAt: expiry + 1 }).where(eq(authSessions.id, sid)).run();
        if (state === 'wrong-session-owner') tx.update(authSessions).set({ userId: 'manager' }).where(eq(authSessions.id, sid)).run();
      }, () => send('create', s.tokens.admin)), 401);
      noWork(spies); expect(snapshot()).toEqual(before);
    });
  }

  for (const offset of [0, 1]) it(`POST rejects exact/elapsed expiry +${offset}s inside transaction`, async () => {
    const s = await setup(), before = snapshot(), spies = workSpies(); let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      denied(await duringFresh((_tx, _uid, _sid, expiry) => { clock = vi.spyOn(Date, 'now').mockReturnValue((expiry + offset) * 1000); }, () => send('create', s.tokens.admin)), 401);
      noWork(spies); expect(snapshot()).toEqual(before);
    } finally { clock?.mockRestore(); }
  });

  it('creates repository defaults, strips unknown/server fields and audits the created DTO', async () => {
    const s = await setup(), before = snapshot();
    const response = await send('create', s.tokens.admin, {
      name: 'Synthetic custom field', label: 'Synthetic label', type: 'text',
      id: 'attacker-id', createdAt: 'attacker-time', role: 'admin', userId: 'admin', scope: 'all', isActive: false, unknown: 'ignored',
    });
    expect(response.statusCode).toBe(201); const row = JSON.parse(response.body);
    expect(row).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'Synthetic custom field', label: 'Synthetic label', type: 'text', required: false });
    const stored = s.db.select().from(customFields).where(eq(customFields.id, row.id)).get();
    expect(stored).toEqual({
      id: row.id, name: 'Synthetic custom field', label: 'Synthetic label', type: 'text', optionsJson: null,
      unit: null, required: false, placeholder: null, defaultValue: null, createdAt: expect.any(String),
    });
    expect(stored.createdAt).not.toBe('attacker-time'); expect(new Date(stored.createdAt).toISOString()).toBe(stored.createdAt);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({ userId: 'admin', action: 'CREATE', entity: 'custom_field', entityId: row.id, previousState: null, newState: row });
  });

  it('accepts all seven field types with repository required/options/default fallbacks', async () => {
    const s = await setup();
    const types = ['text', 'number', 'currency', 'date', 'select', 'boolean', 'file'] as const;
    for (const [index, type] of types.entries()) {
      const response = await send('create', s.tokens.admin, { name: 'type_' + index, label: 'Type ' + type, type });
      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body).toMatchObject({ name: 'type_' + index, label: 'Type ' + type, type, required: false });
      for (const key of ['options', 'unit', 'placeholder', 'defaultValue']) expect(body).not.toHaveProperty(key);
      expect(s.db.select().from(customFields).where(eq(customFields.id, body.id)).get()).toMatchObject({
        type, required: false, optionsJson: null, unit: null, placeholder: null, defaultValue: null,
      });
    }
    const rows = JSON.parse((await send('get', s.tokens.manager)).body);
    for (const type of types) expect(rows.some((row: any) => row.type === type)).toBe(true);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('preserves raw create-input vs stored-string/null-to-undefined defaultValue parity', async () => {
    const s = await setup();
    const produced: any[] = [];
    const full = await send('create', s.tokens.admin, { name: '  full_field  ', label: 'Full field', type: 'select', options: ['A', 'B'], unit: 'm2', required: true, placeholder: 'Placeholder', defaultValue: 42 });
    expect(full.statusCode).toBe(201); const created = JSON.parse(full.body); produced.push(created);
    expect(created).toMatchObject({ name: '  full_field  ', options: ['A', 'B'], unit: 'm2', required: true, placeholder: 'Placeholder', defaultValue: 42 });
    const stored = s.db.select().from(customFields).where(eq(customFields.id, created.id)).get();
    expect(stored).toMatchObject({ optionsJson: JSON.stringify(['A', 'B']), unit: 'm2', required: true, placeholder: 'Placeholder', defaultValue: '42' });

    const variants = [
      { suffix: 'zero', value: 0, stored: null, response: 0 },
      { suffix: 'false', value: false, stored: null, response: false },
      { suffix: 'empty', value: '', stored: null, response: '' },
      { suffix: 'null', value: null, stored: null, response: null },
      { suffix: 'text', value: 'abc', stored: 'abc', response: 'abc' },
      { suffix: 'true', value: true, stored: 'true', response: true },
    ];
    for (const variant of variants) {
      const response = await send('create', s.tokens.admin, { name: 'variant_' + variant.suffix, label: 'Variant', type: 'text', defaultValue: variant.value });
      expect(response.statusCode).toBe(201); const body = JSON.parse(response.body); produced.push(body);
      expect(body.defaultValue).toEqual(variant.response);
      expect(s.db.select().from(customFields).where(eq(customFields.id, body.id)).get().defaultValue).toBe(variant.stored);
    }
    const empty = await send('create', s.tokens.admin, { name: 'empty_options', label: 'Empty', type: 'select', options: [], unit: '', placeholder: '' });
    expect(empty.statusCode).toBe(201); const emptyBody = JSON.parse(empty.body); produced.push(emptyBody);
    expect(emptyBody).toMatchObject({ options: [], unit: '', placeholder: '' });
    expect(s.db.select().from(customFields).where(eq(customFields.id, emptyBody.id)).get()).toMatchObject({ optionsJson: '[]', unit: null, placeholder: null });

    const rows = JSON.parse((await send('get', s.tokens.accountant)).body);
    for (const body of produced) {
      const listRow = rows.find((row: any) => row.id === body.id);
      expect(listRow).toEqual(dto(s.db.select().from(customFields).where(eq(customFields.id, body.id)).get()));
    }
    for (const suffix of ['zero', 'false', 'empty', 'null']) {
      const listRow = rows.find((row: any) => row.id === produced.find(body => body.name === 'variant_' + suffix).id);
      expect(listRow).not.toHaveProperty('defaultValue');
    }
  });

  const base = { name: 'Synthetic valid field', label: 'Synthetic valid label', type: 'text' };
  const badFields = [
    { name: '' }, { name: null }, { name: 'x'.repeat(51) }, { name: 1 },
    { label: '' }, { label: null }, { label: 'x'.repeat(101) }, { label: 1 },
    { type: 'garbage' }, { type: null },
    { options: null }, { options: 'A' }, { options: ['A', 1] },
    { unit: 'x'.repeat(21) }, { unit: 1 },
    { required: 'true' }, { required: null },
    { placeholder: 'x'.repeat(101) }, { placeholder: 1 },
  ];
  it.each(badFields)('POST rejects invalid definition fields %j before definition query/audit', async fields => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send('create', s.tokens.admin, { ...base, ...fields }), 400);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('POST rejects missing definition fields and non-object payloads', async () => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    for (const payload of [{}, { name: 'only' }, { name: 'n', label: 'l' }, [], ['name']]) denied(await send('create', s.tokens.admin, payload), 400);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('keeps the existing duplicate-name DB constraint as a generic 500 rollback and allows retry', async () => {
    const s = await setup();
    const first = await send('create', s.tokens.admin, { name: 'unique_name', label: 'Unique', type: 'text' });
    expect(first.statusCode).toBe(201);
    const before = snapshot(), spies = workSpies();
    denied(await send('create', s.tokens.admin, { name: 'unique_name', label: 'Duplicate', type: 'text' }), 500);
    noWork(spies); expect(snapshot()).toEqual(before);
    expect((await send('create', s.tokens.admin, { name: 'unique_name_2', label: 'Retry', type: 'text' })).statusCode).toBe(201);
    expect(snapshot().customFields).toHaveLength(before.customFields.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('rolls back a real custom_fields insert failure and retries without extra audit', async () => {
    const s = await setup(), before = snapshot(), audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    s.db.run(sql`CREATE TRIGGER synthetic_custom_field_failure BEFORE INSERT ON custom_fields BEGIN SELECT RAISE(ABORT, 'Synthetic private row failure'); END`);
    denied(await send('create', s.tokens.admin), 500);
    expect(snapshot()).toEqual(before); expect(audit).not.toHaveBeenCalled();
    s.db.run(sql`DROP TRIGGER synthetic_custom_field_failure`);
    expect((await send('create', s.tokens.admin)).statusCode).toBe(201);
    expect(snapshot().customFields).toHaveLength(before.customFields.length + 1);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('rolls back a real audit insert failure after the definition insert and retries', async () => {
    const s = await setup(), before = snapshot();
    s.db.run(sql`CREATE TRIGGER synthetic_custom_field_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'Synthetic private audit failure'); END`);
    denied(await send('create', s.tokens.admin), 500);
    expect(snapshot()).toEqual(before);
    s.db.run(sql`DROP TRIGGER synthetic_custom_field_audit_failure`);
    expect((await send('create', s.tokens.admin)).statusCode).toBe(201);
    expect(snapshot().customFields).toHaveLength(before.customFields.length + 1);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('rolls back AFTER a real audit insert, with safe errors, and retries', async () => {
    const s = await setup(), before = snapshot(), original = AuditLogRepository.prototype.logAction;
    const logs: unknown[] = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args); });
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) vi.spyOn(app.log, level).mockImplementation((...args: any[]) => {
      const keys = args[0] && Object.keys(args[0]).sort().join(',');
      if (level === 'info' && args.length === 2 && ((args[1] === 'incoming request' && keys === 'req') || (args[1] === 'request completed' && keys === 'res,responseTime'))) return;
      logs.push(args);
    });
    let inserted = false;
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args: any[]) {
      const logged = original.apply(this, args); expect(this.db).not.toBe(s.db);
      expect(this.db.select().from(auditLogs).where(eq(auditLogs.id, logged.id)).get()).toBeDefined();
      expect(this.db.select().from(customFields).all()).toHaveLength(before.customFields.length + 1);
      inserted = true; throw new Error('Synthetic private failure enc:v1:payload SQLITE_failure');
    });
    denied(await send('create', s.tokens.admin), 500); expect(inserted).toBe(true); expect(audit).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(before); expect(logs).toEqual([]);
    // logger:false application-call check, not enabled logger redaction proof.
    audit.mockRestore(); expect((await send('create', s.tokens.admin)).statusCode).toBe(201);
    expect(snapshot().customFields).toHaveLength(before.customFields.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it.each(['get', 'create'] as const)('%s keeps fresh auth/data/audit synchronous and commits before serialization', async endpoint => {
    const s = await setup(); let currentTx: any, committed = false, serializations = 0, definitionQueries = 0, writes = 0;
    const order: string[] = [], transaction = s.db.transaction, fresh = app.projectAccess.requireFreshActor, log = AuditLogRepository.prototype.logAction;
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation((value: any, replacer?: any, space?: any) => {
      const responsePayload = endpoint === 'get'
        ? Array.isArray(value) && value.some((row: any) => row?.id === 'full' && row?.name === 'plaka_no')
        : value?.name === 'Synthetic new custom field' && typeof value?.id === 'string';
      if (responsePayload) { serializations++; expect(committed).toBe(true); expect(currentTx).toBeUndefined(); }
      return stringify(value, replacer, space);
    });
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, options: any) => {
      expect(options).toEqual(endpoint === 'create' ? { behavior: 'immediate' } : undefined);
      const result = transaction.call(s.db, (tx: any) => {
        currentTx = tx;
        const select = tx.select;
        tx.select = function (this: any, ...args: any[]) {
          expect(currentTx).toBe(tx); const builder = select.apply(this, args), from = builder.from;
          builder.from = function (table: any) { if (table === customFields) { expect(order[0]).toBe('fresh'); definitionQueries++; } return from.call(this, table); };
          return builder;
        };
        for (const method of ['insert', 'update', 'delete'] as const) {
          const original = tx[method]; tx[method] = function (this: any, ...args: any[]) { expect(currentTx).toBe(tx); expect(order[0]).toBe('fresh'); writes++; return original.apply(this, args); };
        }
        try { const value = callback(tx); expect(value).not.toBeInstanceOf(Promise); return value; }
        finally { currentTx = undefined; }
      }, options);
      committed = true; return result;
    });
    app.projectAccess.requireFreshActor = function (tx: any, ...args: any[]) { expect(tx).toBe(currentTx); const result = fresh.call(this, tx, ...args); order.push('fresh'); return result; };
    vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args: any[]) { expect(this.db).toBe(currentTx); expect(order).toEqual(['fresh']); order.push('audit'); return log.apply(this, args); });
    try {
      const response = await send(endpoint, s.tokens.admin, endpoint === 'create' ? { name: 'Synthetic new custom field', label: 'Synthetic label', type: 'text' } : undefined);
      expect(response.statusCode).toBe(endpoint === 'create' ? 201 : 200);
      expect(serializations).toBe(1); expect(committed).toBe(true); expect(currentTx).toBeUndefined();
      expect(order).toEqual(endpoint === 'create' ? ['fresh', 'audit'] : ['fresh']);
      expect(definitionQueries).toBe(endpoint === 'create' ? 0 : 1);
      expect(writes).toBe(endpoint === 'create' ? 2 : 0);
    } finally { app.projectAccess.requireFreshActor = fresh; }
  });
});
