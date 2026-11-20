import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { AuditLogRepository, users, projects, categories, auditLogs, authSessions, projectMemberships } from '@cost-core/database';
import { buildApp } from '../src/app.js';

// All records, signing material and encryption inputs below are synthetic;
// buildApp receives explicit configuration and uses only an in-memory database.
const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
const reads = ['list', 'tree', 'detail'] as const;
const mutations = ['create', 'update', 'delete'] as const;
const endpoints = [...reads, ...mutations] as const;
type Endpoint = typeof endpoints[number];
const nonadmins = ['manager', 'accountant', 'auditor', 'viewer'].flatMap(role => [role, 'unassigned-' + role]);
const referenceKeys = ['id', 'name', 'code', 'parentId', 'color', 'icon', 'orderIndex', 'customFieldIds', 'isActive'].sort();
const sensitiveKeys = ['budget', 'description', 'createdAt', 'updatedAt'];
const genericError = { error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' };
const now = '2026-01-01T00:00:00.000Z';
const fieldId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
let app: any;
afterEach(async () => { vi.restoreAllMocks(); if (app) { await app.close(); app = undefined; } });

async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const db = app.db, tokens: Record<string, string> = {}, sessions: Record<string, any> = {};
  for (const id of ['site1', 'site2']) db.insert(projects).values({ id, name: id, createdAt: now, updatedAt: now }).run();
  for (const id of ['admin', ...nonadmins]) {
    const role = id.replace('unassigned-', '');
    db.insert(users).values({ id, username: id, email: id + '@example.test', fullName: 'Synthetic user', passwordHash: 'synthetic-hash', role, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(id); sessions[id] = session;
    tokens[id] = app.jwt.sign({ id, username: id, role, sid: session.id, exp: session.expiresAt });
    if (id !== 'admin' && !id.startsWith('unassigned-')) db.insert(projectMemberships).values({ userId: id, projectId: 'site1', createdAt: now }).run();
  }
  // Deliberately not sorted by orderIndex: preserve the repository's row order.
  for (const [id, parent, orderIndex] of [['root', null, 9], ['child', 'root', -2], ['orphan', 'missing-parent', 0]] as const) db.insert(categories).values({
    id, name: 'Synthetic category ' + id, code: 'code-' + id, parentId: parent,
    description: 'Synthetic private description', budget: 98765.25, color: '#123abc', icon: 'tag', orderIndex,
    customFieldIds: JSON.stringify([fieldId]), isActive: id !== 'child', createdAt: now, updatedAt: now,
  }).run();
  app.auditRepo.logAction({ userId: 'admin', action: 'CREATE', entity: 'synthetic', entityId: 'fixture', newState: { synthetic: true } }, config.masterKey);
  return { db, tokens, sessions };
}
function snapshot() {
  return {
    categories: app.db.select().from(categories).orderBy(categories.id).all(),
    auditLogs: app.db.select().from(auditLogs).orderBy(auditLogs.id).all(),
    users: app.db.select().from(users).orderBy(users.id).all(),
    sessions: app.db.select().from(authSessions).orderBy(authSessions.id).all(),
    memberships: app.db.select().from(projectMemberships).orderBy(projectMemberships.userId, projectMemberships.projectId).all(),
    projects: app.db.select().from(projects).orderBy(projects.id).all(),
  };
}
function dto(row: any, admin = true) {
  const result = { ...row, customFieldIds: JSON.parse(row.customFieldIds || '[]') };
  return admin ? result : Object.fromEntries(referenceKeys.map(key => [key, result[key]]));
}
function send(endpoint: Endpoint, token?: string, value?: any, id = 'root') {
  const smuggling = 'role=admin&userId=admin&projectId=site2&scope=all&fields=budget,description,createdAt,updatedAt';
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  if (endpoint === 'list' || endpoint === 'tree') return app.inject({ method: 'GET', url: '/api/categories?' + (value ?? (endpoint === 'tree' ? 'tree=true' : '')) + '&' + smuggling, headers });
  if (endpoint === 'detail' || endpoint === 'delete') return app.inject({ method: endpoint === 'detail' ? 'GET' : 'DELETE', url: '/api/categories/' + encodeURIComponent(value ?? id) + '?' + smuggling, headers });
  return app.inject({ method: endpoint === 'create' ? 'POST' : 'PUT', url: '/api/categories' + (endpoint === 'update' ? '/' + encodeURIComponent(id) : '') + '?' + smuggling, headers, payload: value ?? (endpoint === 'create' ? { name: 'Synthetic new category' } : { budget: 45 }) });
}
function denied(response: any, status: number) {
  expect(response.statusCode).toBe(status); const body = JSON.parse(response.body);
  if (status === 401) expect(body.code).toBe('SESSION_INVALID');
  if (status === 500) expect(body).toEqual(genericError);
  for (const text of ['Synthetic private', '98765', 'enc:v1:', 'SQLITE_']) expect(response.body).not.toContain(text);
}
// Observe the actual executed category SQL, not just the eventual response DTO.
function workSpies() {
  const transaction = app.db.transaction, selections = vi.fn();
  vi.spyOn(app.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => transaction.call(app.db, (tx: any) => {
    const select = tx.select;
    tx.select = function (this: any, ...selection: any[]) {
      const builder = select.apply(this, selection), from = builder.from;
      builder.from = function (table: any) {
        const query = from.call(this, table);
        if (table === categories) for (const method of ['all', 'get'] as const) {
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
function expectProjection(spies: ReturnType<typeof workSpies>, admin: boolean) {
  expect(spies.selections).toHaveBeenCalledTimes(1);
  const [selection, statement] = spies.selections.mock.calls[0];
  if (!admin) {
    expect(Object.keys(selection).sort()).toEqual(referenceKeys);
    const projection = statement.slice(0, statement.indexOf(' from '));
    for (const column of ['budget', 'description', 'created_at', 'updated_at']) expect(projection).not.toContain('"' + column + '"');
    for (const column of ['id', 'name', 'code', 'parent_id', 'color', 'icon', 'order_index', 'custom_field_ids', 'is_active']) expect(projection).toContain('"' + column + '"');
  } else {
    expect(selection).toBeUndefined();
    for (const column of ['budget', 'description', 'created_at', 'updated_at']) expect(statement).toContain('"' + column + '"');
  }
}
function nodes(response: any, endpoint: Endpoint): any[] {
  const body = JSON.parse(response.body);
  if (endpoint === 'detail') return [body];
  const flatten = (rows: any[]): any[] => rows.flatMap(({ children, ...row }: any) => [row, ...flatten(children || [])]);
  return endpoint === 'tree' ? flatten(body) : body;
}
function expectRetry(before: ReturnType<typeof snapshot>, endpoint: typeof mutations[number]) {
  const after = snapshot();
  for (const key of ['users', 'sessions', 'memberships', 'projects'] as const) expect(after[key]).toEqual(before[key]);
  expect(after.auditLogs).toHaveLength(before.auditLogs.length + 1);
  for (const row of before.auditLogs) expect(after.auditLogs).toContainEqual(row);
  const others = (rows: any[]) => rows.filter(row => row.id !== 'root');
  if (endpoint === 'create') {
    for (const row of before.categories) expect(after.categories).toContainEqual(row);
    expect(after.categories).toHaveLength(before.categories.length + 1);
    expect(after.categories.find((row: any) => row.name === 'Synthetic new category')).toBeDefined();
  } else {
    expect(others(after.categories)).toEqual(others(before.categories));
    if (endpoint === 'delete') expect(after.categories.some((row: any) => row.id === 'root')).toBe(false);
    else expect(after.categories.find((row: any) => row.id === 'root')).toEqual({ ...before.categories.find((row: any) => row.id === 'root'), budget: 45, updatedAt: expect.any(String) });
  }
  expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
}

describe('category shared references: least-privilege SQL and atomic admin mutations', () => {
  for (const role of ['admin', ...nonadmins]) {
    it.each(reads)(`${role} %s uses fresh SQL projection regardless of membership/client claims`, async endpoint => {
      const s = await setup(), before = snapshot(), spies = workSpies();
      const response = await send(endpoint, s.tokens[role]); expect(response.statusCode).toBe(200);
      const rows = nodes(response, endpoint), admin = role === 'admin';
      const expected = before.categories.filter((row: any) => endpoint !== 'detail' || row.id === 'root').map((row: any) => dto(row, admin));
      expect(rows.sort((a: any, b: any) => a.id.localeCompare(b.id))).toEqual(expected);
      if (!admin) for (const row of rows) { expect(Object.keys(row).sort()).toEqual(referenceKeys); for (const key of sensitiveKeys) expect(row).not.toHaveProperty(key); }
      expectProjection(spies, admin); expect(spies.audit).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
    });
  }

  it.each(mutations)('%s denies all nonadmins before validation, category queries or audit', async endpoint => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    for (const role of nonadmins) {
      denied(await send(endpoint, s.tokens[role]), 403);
      denied(await send(endpoint, s.tokens[role], endpoint === 'delete' ? ' ' : { name: null, budget: 'bad', role: 'admin', scope: 'all', userId: 'admin', projectId: 'site1' }, ' '), 403);
    }
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s rejects missing/invalid authentication before category work', async endpoint => {
    await setup(); const before = snapshot(), spies = workSpies();
    denied(await send(endpoint), 401); denied(await send(endpoint, 'invalid-token'), 401); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(endpoints)('%s follows a same-token role change, not JWT/client admin claims', async endpoint => {
    const s = await setup(); s.db.update(users).set({ role: 'manager' }).where(eq(users.id, 'admin')).run();
    const forged = app.jwt.sign({ id: 'manager', username: 'manager', role: 'admin', sid: s.sessions.manager.id, exp: s.sessions.manager.expiresAt });
    for (const token of [s.tokens.admin, forged]) {
      const before = snapshot();
      const response = await send(endpoint, token);
      if (mutations.includes(endpoint as any)) denied(response, 403);
      else { expect(response.statusCode).toBe(200); for (const row of nodes(response, endpoint)) expect(Object.keys(row).sort()).toEqual(referenceKeys); }
      expect(snapshot()).toEqual(before);
    }
  });

  it.each(endpoints)('%s rechecks an auth-to-tx downgrade before validation/projection', async endpoint => {
    const s = await setup(), spies = workSpies();
    const response = await duringFresh((tx, uid) => tx.update(users).set({ role: 'manager' }).where(eq(users.id, uid)).run(), () => send(endpoint, s.tokens.admin));
    if (mutations.includes(endpoint as any)) { denied(response, 403); noWork(spies); expect(s.db.select().from(users).where(eq(users.id, 'admin')).get().role).toBe('admin'); }
    else { expect(response.statusCode).toBe(200); expectProjection(spies, false); for (const row of nodes(response, endpoint)) expect(Object.keys(row).sort()).toEqual(referenceKeys); }
  });

  it.each(reads)('%s follows an auth-to-tx promotion to admin for full DTO', async endpoint => {
    const s = await setup(), spies = workSpies();
    const response = await duringFresh((tx, uid) => tx.update(users).set({ role: 'admin' }).where(eq(users.id, uid)).run(), () => send(endpoint, s.tokens.manager));
    expect(response.statusCode).toBe(200); expectProjection(spies, true);
    expect(nodes(response, endpoint)[0]).toHaveProperty('budget', 98765.25);
  });

  it.each(mutations)('%s rechecks admin before malformed input validation in the transaction', async endpoint => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await duringFresh((tx, uid) => tx.update(users).set({ role: 'manager' }).where(eq(users.id, uid)).run(), () => send(endpoint, s.tokens.admin, endpoint === 'delete' ? ' ' : { name: null, budget: 'invalid' }, ' ')), 403);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  for (const state of ['revoked', 'inactive', 'missing-user', 'invalid-role', 'missing-session', 'changed-expiry', 'wrong-session-owner'] as const) {
    it.each(endpoints)(`%s rejects ${state} between authentication and transaction`, async endpoint => {
      const s = await setup(), before = snapshot(), spies = workSpies();
      denied(await duringFresh((tx, uid, sid, expiry) => {
        if (state === 'revoked') tx.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, sid)).run();
        if (state === 'inactive') tx.update(users).set({ isActive: false }).where(eq(users.id, uid)).run();
        if (state === 'missing-user') tx.delete(users).where(eq(users.id, uid)).run();
        if (state === 'invalid-role') tx.update(users).set({ role: 'invalid' }).where(eq(users.id, uid)).run();
        if (state === 'missing-session') tx.delete(authSessions).where(eq(authSessions.id, sid)).run();
        if (state === 'changed-expiry') tx.update(authSessions).set({ expiresAt: expiry + 1 }).where(eq(authSessions.id, sid)).run();
        if (state === 'wrong-session-owner') tx.update(authSessions).set({ userId: 'manager' }).where(eq(authSessions.id, sid)).run();
      }, () => send(endpoint, s.tokens.admin)), 401);
      noWork(spies); expect(snapshot()).toEqual(before);
    });
  }

  for (const offset of [0, 1]) it.each(endpoints)(`%s rejects exact/elapsed expiry +${offset}s inside transaction`, async endpoint => {
    const s = await setup(), before = snapshot(), spies = workSpies(); let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      denied(await duringFresh((_tx, _uid, _sid, expiry) => { clock = vi.spyOn(Date, 'now').mockReturnValue((expiry + offset) * 1000); }, () => send(endpoint, s.tokens.admin)), 401);
      noWork(spies); expect(snapshot()).toEqual(before);
    } finally { clock?.mockRestore(); }
  });

  it.each(endpoints)('%s rejects an already revoked session', async endpoint => {
    const s = await setup(); s.db.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, s.sessions.admin.id)).run();
    const before = snapshot(), spies = workSpies(); denied(await send(endpoint, s.tokens.admin), 401); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('preserves list order, inactive rows, nested children and orphan-as-root tree shape', async () => {
    const s = await setup(), rows = s.db.select().from(categories).all().map((row: any) => dto(row));
    for (const query of ['', 'tree=false']) { const response = await send('list', s.tokens.admin, query); expect(response.statusCode).toBe(200); expect(JSON.parse(response.body)).toEqual(rows); }
    const response = await send('tree', s.tokens.admin); expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([{ ...rows[0], children: [{ ...rows[1], children: [] }] }, { ...rows[2], children: [] }]);
  });

  it.each(['tree=', 'tree', 'tree=garbage', 'tree=True', 'tree=0', 'tree=null', 'tree=%20true', 'tree=true%20', 'tree=true&tree=false', 'tree=true&tree=true'])('rejects malformed tree query %s before category reads', async query => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    for (const token of [s.tokens.admin, s.tokens.viewer]) denied(await send('list', token, query), 400);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  for (const endpoint of ['detail', 'update', 'delete'] as const) {
    it.each([' ', '   ', '\t'])(`${endpoint} rejects blank opaque ID %j before category reads`, async id => {
      const s = await setup(), before = snapshot(), spies = workSpies();
      denied(await send(endpoint, s.tokens.admin, endpoint === 'update' ? {} : id, id), 400); noWork(spies); expect(snapshot()).toEqual(before);
    });
    it(`${endpoint} preserves significant spaces and accepts opaque 128-character IDs`, async () => {
      const s = await setup();
      for (const id of ['opaque_' + 'x'.repeat(121), ' opaque_id ']) {
        s.db.insert(categories).values({ id, name: 'Synthetic opaque', createdAt: now, updatedAt: now }).run();
        if (id !== id.trim()) denied(await send(endpoint, s.tokens.admin, endpoint === 'update' ? {} : id.trim(), id.trim()), 404);
        expect((await send(endpoint, s.tokens.admin, endpoint === 'update' ? {} : id, id)).statusCode).toBe(200);
      }
      expect((await send(endpoint, s.tokens.admin, endpoint === 'update' ? {} : 'x'.repeat(129), 'x'.repeat(129))).statusCode).toBe(414);
    });
    it(`${endpoint} missing IDs return 404 without audit`, async () => {
      const s = await setup(), before = snapshot(), audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
      denied(await send(endpoint, s.tokens.admin, endpoint === 'update' ? {} : 'missing', 'missing'), 404);
      expect(audit).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
    });
  }

  it('creates repository defaults while stripping unknown/server fields', async () => {
    const s = await setup(), before = snapshot();
    const response = await send('create', s.tokens.admin, { name: 'Synthetic new category', id: 'attacker-id', isActive: false, createdAt: 'attacker-time', updatedAt: 'attacker-time', role: 'admin', userId: 'admin', scope: 'all', unknown: 'ignored' });
    expect(response.statusCode).toBe(201); const row = JSON.parse(response.body);
    expect(row).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'Synthetic new category', code: null, parentId: null, description: null, budget: 0, color: '#3B82F6', icon: 'folder', orderIndex: 0, customFieldIds: [], isActive: true, createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect(row.createdAt).toBe(row.updatedAt); expect(new Date(row.createdAt).toISOString()).toBe(row.createdAt);
    expect(dto(s.db.select().from(categories).where(eq(categories.id, row.id)).get())).toEqual(row);
    expect(snapshot().auditLogs).toHaveLength(before.auditLogs.length + 1);
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({ userId: 'admin', action: 'CREATE', entity: 'category', entityId: row.id, previousState: null, newState: row });
  });

  it('preserves accepted field/JSON parity and legacy create fallback values', async () => {
    const s = await setup(), input = { name: '  Synthetic full category  ', code: 'CODE', parentId, description: 'Synthetic details', budget: -12.5, color: '#Ab01fF', icon: 'tag', orderIndex: -3, customFieldIds: [fieldId] };
    const response = await send('create', s.tokens.admin, input); expect(response.statusCode).toBe(201); const row = JSON.parse(response.body);
    expect(row).toMatchObject(input); expect(dto(s.db.select().from(categories).where(eq(categories.id, row.id)).get())).toEqual(row);
    const fallback = await send('create', s.tokens.admin, { name: 'Synthetic fallback', code: '', description: '', parentId: null, icon: '', customFieldIds: [] });
    expect(fallback.statusCode).toBe(201); expect(JSON.parse(fallback.body)).toMatchObject({ code: null, description: null, parentId: null, icon: 'folder', customFieldIds: [] });
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('partial updates retain every omitted field, support nullable fields, strip server fields and audit both states', async () => {
    const s = await setup(), before = dto(s.db.select().from(categories).where(eq(categories.id, 'root')).get());
    const response = await send('update', s.tokens.admin, { name: 'Synthetic renamed', id: 'attacker', isActive: false, createdAt: 'attacker-time', updatedAt: 'attacker-time', role: 'viewer', unknown: 1 });
    expect(response.statusCode).toBe(200); const row = JSON.parse(response.body);
    expect(row).toEqual({ ...before, name: 'Synthetic renamed', updatedAt: expect.any(String) }); expect(row.updatedAt).not.toBe('attacker-time');
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({ action: 'UPDATE', entity: 'category', entityId: 'root', previousState: before, newState: row });
    const values = { code: null, parentId: null, description: null, icon: '', budget: 0, color: '#000000', orderIndex: 7, customFieldIds: [] };
    const nullable = await send('update', s.tokens.admin, values); expect(nullable.statusCode).toBe(200); expect(JSON.parse(nullable.body)).toMatchObject(values);
    const full = { code: 'NEW', parentId, description: 'Updated', icon: 'book', budget: 5.25, orderIndex: -9, customFieldIds: [fieldId] };
    const changed = await send('update', s.tokens.admin, full); expect(changed.statusCode).toBe(200);
    expect(JSON.parse(changed.body)).toMatchObject(full); expect(dto(s.db.select().from(categories).where(eq(categories.id, 'root')).get())).toEqual(JSON.parse(changed.body));
    const previous = JSON.parse(changed.body), auditCount = snapshot().auditLogs.length;
    const empty = await send('update', s.tokens.admin, {}); expect(empty.statusCode).toBe(200);
    expect(JSON.parse(empty.body)).toEqual({ ...previous, updatedAt: expect.any(String) }); expect(snapshot().auditLogs).toHaveLength(auditCount + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it.each(['self', 'descendant'])('rejects a category parent pointing to its %s without changing the tree or audit', async target => {
    const { tokens } = await setup();
    const root = await send('create', tokens.admin, { name: 'Synthetic root' });
    expect(root.statusCode).toBe(201);
    const rootId = root.json().id;
    const child = await send('create', tokens.admin, { name: 'Synthetic child', parentId: rootId });
    expect(child.statusCode).toBe(201);
    const grandchild = await send('create', tokens.admin, { name: 'Synthetic grandchild', parentId: child.json().id });
    expect(grandchild.statusCode).toBe(201);
    const nextParent = target === 'self' ? rootId : grandchild.json().id;
    const before = snapshot();
    const result = await send('update', tokens.admin, { parentId: nextParent }, rootId);
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({ code: 'CATEGORY_CYCLE' });
    expect(snapshot()).toEqual(before);

    const detached = await send('update', tokens.admin, { parentId: null }, child.json().id);
    expect(detached.statusCode).toBe(200);
    expect(detached.json().parentId).toBeNull();
  });


  const badFields = [{ name: '' }, { name: null }, { name: [] }, { name: 'x'.repeat(101) }, { code: 'x'.repeat(31) }, { parentId: '' }, { parentId: 'opaque' }, { description: 'x'.repeat(501) }, { budget: '1' }, { budget: null }, { budget: 1e309 }, { orderIndex: 1.5 }, { orderIndex: null }, { color: 'red' }, { color: null }, { icon: null }, { icon: 'x'.repeat(51) }, { customFieldIds: null }, { customFieldIds: ['opaque'] }];
  for (const endpoint of ['create', 'update'] as const) it.each(badFields)(`${endpoint} rejects invalid fields %j before category reads/audit`, async fields => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send(endpoint, s.tokens.admin, { name: 'Synthetic category', ...fields }), 400); noWork(spies); expect(snapshot()).toEqual(before);
  });
  it('rejects missing create name and non-object create/update payloads', async () => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send('create', s.tokens.admin, {}), 400);
    for (const endpoint of ['create', 'update'] as const) for (const payload of [[], ['name']]) denied(await send(endpoint, s.tokens.admin, payload), 400);
    noWork(spies); expect(snapshot()).toEqual(before);
  });

  for (const endpoint of ['create', 'update'] as const) it.each(['1e309', '-1e309'])(`${endpoint} rejects nonfinite parsed JSON budget %s`, async budget => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    const response = await app.inject({ method: endpoint === 'create' ? 'POST' : 'PUT', url: '/api/categories' + (endpoint === 'update' ? '/root' : ''), headers: { authorization: 'Bearer ' + s.tokens.admin, 'content-type': 'application/json' }, payload: '{"name":"Synthetic category","budget":' + budget + '}' });
    denied(response, 400); noWork(spies); expect(snapshot()).toEqual(before);
  });

  it('deletes with full decoded previousState and preserves the existing success body', async () => {
    const s = await setup(), before = snapshot(), previousState = dto(before.categories.find((row: any) => row.id === 'root'));
    const response = await send('delete', s.tokens.admin); expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ success: true, message: 'Kategori başarıyla silindi.' });
    expect(snapshot().categories).toEqual(before.categories.filter((row: any) => row.id !== 'root'));
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0]).toMatchObject({ userId: 'admin', action: 'DELETE', entity: 'category', entityId: 'root', previousState, newState: null });
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it.each(mutations)('%s rolls back a real row failure, then retries without extra audit', async endpoint => {
    const s = await setup(), before = snapshot(), audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    if (endpoint === 'create') s.db.run(sql`CREATE TRIGGER synthetic_category_failure BEFORE INSERT ON categories BEGIN SELECT RAISE(ABORT, 'Synthetic private row failure'); END`);
    if (endpoint === 'update') s.db.run(sql`CREATE TRIGGER synthetic_category_failure BEFORE UPDATE ON categories BEGIN SELECT RAISE(ABORT, 'Synthetic private row failure'); END`);
    if (endpoint === 'delete') s.db.run(sql`CREATE TRIGGER synthetic_category_failure BEFORE DELETE ON categories BEGIN SELECT RAISE(ABORT, 'Synthetic private row failure'); END`);
    denied(await send(endpoint, s.tokens.admin), 500); expect(snapshot()).toEqual(before); expect(audit).not.toHaveBeenCalled();
    s.db.run(sql`DROP TRIGGER synthetic_category_failure`);
    expect((await send(endpoint, s.tokens.admin)).statusCode).toBe(endpoint === 'create' ? 201 : 200);
    expectRetry(before, endpoint);
  });

  it.each(mutations)('%s rolls back a real audit insert failure and retries', async endpoint => {
    const s = await setup(), before = snapshot();
    s.db.run(sql`CREATE TRIGGER synthetic_category_audit_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'Synthetic private audit failure'); END`);
    denied(await send(endpoint, s.tokens.admin), 500); expect(snapshot()).toEqual(before);
    s.db.run(sql`DROP TRIGGER synthetic_category_audit_failure`);
    expect((await send(endpoint, s.tokens.admin)).statusCode).toBe(endpoint === 'create' ? 201 : 200);
    expectRetry(before, endpoint);
  });

  it.each(mutations)('%s rolls back AFTER a real audit insert, with safe errors, and retries', async endpoint => {
    const s = await setup(), before = snapshot(), original = AuditLogRepository.prototype.logAction;
    const logs: unknown[] = [];
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args); });
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) vi.spyOn(app.log, level).mockImplementation((...args: any[]) => {
      const keys = args[0] && Object.keys(args[0]).sort().join(',');
      if (level === 'info' && args.length === 2 && ((args[1] === 'incoming request' && keys === 'req') || (args[1] === 'request completed' && keys === 'res,responseTime'))) return;
      logs.push(args);
    });
    let inserted = false;
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args) {
      const logged = original.apply(this, args); expect(this.db).not.toBe(s.db);
      expect(this.db.select().from(auditLogs).where(eq(auditLogs.id, logged.id)).get()).toBeDefined();
      const rows = this.db.select().from(categories).all();
      expect(rows).toHaveLength(before.categories.length + (endpoint === 'create' ? 1 : endpoint === 'delete' ? -1 : 0));
      if (endpoint === 'update') expect(rows.find((row: any) => row.id === 'root').budget).toBe(45);
      inserted = true; throw new Error('Synthetic private failure enc:v1:payload SQLITE_failure');
    });
    denied(await send(endpoint, s.tokens.admin), 500); expect(inserted).toBe(true); expect(audit).toHaveBeenCalledTimes(1);
    expect(snapshot()).toEqual(before); expect(logs).toEqual([]);
    // logger:false application-call check, not enabled logger redaction proof.
    audit.mockRestore(); expect((await send(endpoint, s.tokens.admin)).statusCode).toBe(endpoint === 'create' ? 201 : 200);
    expectRetry(before, endpoint);
  });

  it.each(reads)('%s returns a generic unexpected read failure with no writes', async endpoint => {
    const s = await setup(), before = snapshot(), transaction = s.db.transaction;
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => transaction.call(s.db, (tx: any) => {
      const select = tx.select;
      tx.select = function (this: any, ...selection: any[]) { if (!selection.length) throw new Error('Synthetic private read failure'); return select.apply(this, selection); };
      return callback(tx);
    }, ...args));
    denied(await send(endpoint, s.tokens.admin), 500); expect(snapshot()).toEqual(before);
  });

  for (const role of ['admin', 'viewer']) it.each(role === 'admin' ? endpoints : reads)(`${role} %s keeps fresh auth/data/audit synchronous and commits before serialization`, async endpoint => {
    const s = await setup(); let currentTx: any, committed = false, serializations = 0, categoryQueries = 0, writes = 0;
    const order: string[] = [], transaction = s.db.transaction, fresh = app.projectAccess.requireFreshActor, log = AuditLogRepository.prototype.logAction;
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation((value: any, replacer?: any, space?: any) => {
      const responsePayload = endpoint === 'list' || endpoint === 'tree'
        ? Array.isArray(value) && value.some(row => row?.id === 'root' && row?.name === 'Synthetic category root')
        : endpoint === 'delete' ? value?.success === true && value?.message === 'Kategori başarıyla silindi.'
          : endpoint === 'create' ? value?.name === 'Synthetic new category' && typeof value?.id === 'string'
            : value?.id === 'root' && value?.name === 'Synthetic category root';
      if (responsePayload) { serializations++; expect(committed).toBe(true); expect(currentTx).toBeUndefined(); }
      return stringify(value, replacer, space);
    });
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, options: any) => {
      expect(options).toEqual(mutations.includes(endpoint as any) ? { behavior: 'immediate' } : undefined);
      const result = transaction.call(s.db, (tx: any) => {
        currentTx = tx;
        const select = tx.select;
        tx.select = function (this: any, ...args: any[]) {
          expect(currentTx).toBe(tx); const builder = select.apply(this, args), from = builder.from;
          builder.from = function (table: any) { if (table === categories) { expect(order[0]).toBe('fresh'); categoryQueries++; } return from.call(this, table); };
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
    vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args) { expect(this.db).toBe(currentTx); expect(order).toEqual(['fresh']); order.push('audit'); return log.apply(this, args); });
    try {
      const response = await send(endpoint, s.tokens[role]); expect(response.statusCode).toBe(endpoint === 'create' ? 201 : 200);
      expect(serializations).toBe(1); expect(committed).toBe(true); expect(currentTx).toBeUndefined();
      expect(order).toEqual(mutations.includes(endpoint as any) ? ['fresh', 'audit'] : ['fresh']);
      expect(categoryQueries).toBe(endpoint === 'create' ? 0 : endpoint === 'update' ? 2 : 1);
      expect(writes).toBe(mutations.includes(endpoint as any) ? 2 : 0);
    } finally { app.projectAccess.requireFreshActor = fresh; }
  });
});
