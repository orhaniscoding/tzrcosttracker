import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { AuditLogRepository, users, authSessions, auditLogs, projectMemberships, projects } from '@cost-core/database';
import { hashPassword, verifyPassword, decryptField } from '@cost-core/crypto';
import { buildApp } from '../src/app.js';

// Real scrypt remains the implementation; the wrapper only provides an explicit
// await boundary for authorization-race tests. All data is synthetic/in-memory.
vi.mock('@cost-core/crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('@cost-core/crypto')>();
  return { ...actual, hashPassword: vi.fn(actual.hashPassword), decryptField: vi.fn(actual.decryptField) };
});
const realCrypto = await vi.importActual<typeof import('@cost-core/crypto')>('@cost-core/crypto');
const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
const nonadmins = ['manager', 'accountant', 'auditor', 'viewer'].flatMap(role => [role, 'unassigned-' + role]);
const roles = ['admin', ...nonadmins];
const now = '2026-01-01T00:00:00.000Z';
const publicKeys = ['id', 'username', 'email', 'fullName', 'role', 'isActive', 'hasPin', 'twoFactorEnabled', 'createdAt', 'updatedAt'].sort();
const input = { username: 'synthetic-new', email: 'synthetic-new@example.test', fullName: 'Synthetic New User', password: 'Synthetic-password-789' };
const genericError = { error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' };
let app: any;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(hashPassword).mockReset().mockImplementation(realCrypto.hashPassword);
  vi.mocked(decryptField).mockClear();
  if (app) { await app.close(); app = undefined; }
});

async function setup() {
  vi.mocked(hashPassword).mockReset().mockImplementation(realCrypto.hashPassword);
  vi.mocked(decryptField).mockClear();
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const db = app.db, tokens: Record<string, string> = {}, sessions: Record<string, any> = {};
  db.insert(projects).values({ id: 'site1', name: 'Synthetic project', createdAt: now, updatedAt: now }).run();
  for (const id of roles) {
    const role = id.replace('unassigned-', '');
    db.insert(users).values({ id, username: id, email: id + '@example.test', fullName: 'Synthetic ' + id,
      passwordHash: 'synthetic-password-hash-not-for-login', pinHash: id === 'admin' ? 'synthetic-pin-hash' : null,
      twoFactorSecret: 'synthetic-unreadable-totp', twoFactorBackupCodes: 'synthetic-unreadable-backups',
      twoFactorEnabled: id === 'admin', role, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(id); sessions[id] = session;
    tokens[id] = app.jwt.sign({ id, username: id, role, sid: session.id, exp: session.expiresAt });
    if (id !== 'admin' && !id.startsWith('unassigned-')) db.insert(projectMemberships).values({ userId: id, projectId: 'site1', createdAt: now }).run();
  }
  app.auditRepo.logAction({ userId: 'admin', action: 'CREATE', entity: 'synthetic', entityId: 'fixture', newState: { synthetic: true } }, config.masterKey);
  return { db, tokens, sessions };
}
function snapshot() {
  return {
    users: app.db.select().from(users).orderBy(users.id).all(),
    sessions: app.db.select().from(authSessions).orderBy(authSessions.id).all(),
    audit: app.db.select().from(auditLogs).orderBy(auditLogs.id).all(),
    memberships: app.db.select().from(projectMemberships).orderBy(projectMemberships.userId, projectMemberships.projectId).all(),
    projects: app.db.select().from(projects).orderBy(projects.id).all(),
  };
}
function dto(row: any) {
  return { id: row.id, username: row.username, email: row.email, fullName: row.fullName, role: row.role,
    isActive: row.isActive, hasPin: !!row.pinHash, twoFactorEnabled: row.twoFactorEnabled, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function send(method: 'GET' | 'POST', token?: string, payload: any = input) {
  return app.inject({ method, url: '/api/auth/users?role=admin&userId=admin&scope=all&projectId=site1&fields=passwordHash,twoFactorSecret',
    headers: token ? { authorization: 'Bearer ' + token } : {}, ...(method === 'POST' ? { payload } : {}) });
}
function denied(response: any, status: number) {
  expect(response.statusCode).toBe(status); const body = JSON.parse(response.body);
  if (status === 401) expect(body.code).toBe('SESSION_INVALID');
  if (status === 500) expect(body).toEqual(genericError);
  for (const value of ['SQLITE_', 'enc:v1:', 'Synthetic private', input.password, 'synthetic-unreadable', 'scrypt:v1:']) expect(response.body).not.toContain(value);
  expect(body).not.toHaveProperty('token'); expect(body).not.toHaveProperty('passwordHash');
}
function defer() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

// Trace actual executed SQL in route transactions, not a reimplementation of
// the response mapper. Authentication's separate minimal state read is outside.
function workSpies() {
  const transaction = app.db.transaction, selections = vi.fn(), writes = vi.fn();
  vi.spyOn(app.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => transaction.call(app.db, (tx: any) => {
    const select = tx.select;
    tx.select = function (this: any, ...selection: any[]) {
      const builder = select.apply(this, selection), from = builder.from;
      builder.from = function (table: any) {
        const query = from.call(this, table);
        if (table === users) for (const method of ['all', 'get'] as const) {
          const execute = query[method];
          query[method] = function (...params: any[]) { selections(selection[0], this.toSQL(), method); return execute.apply(this, params); };
        }
        return query;
      }; return builder;
    };
    for (const method of ['insert', 'update', 'delete'] as const) {
      const original = tx[method];
      tx[method] = function (this: any, table: any, ...rest: any[]) { writes(method, table); return original.call(this, table, ...rest); };
    }
    return callback(tx);
  }, ...args));
  return {
    selections, writes, audit: vi.spyOn(AuditLogRepository.prototype, 'logAction'),
    create: vi.spyOn(app.userRepo, 'createUser'), list: vi.spyOn(app.userRepo, 'listUsers'),
    lookup: vi.spyOn(app.userRepo, 'getUserByUsernameOrEmail'),
  };
}
function noDirectoryWork(spies: ReturnType<typeof workSpies>) {
  expect(spies.selections.mock.calls.every(([selection]: any[]) => Object.keys(selection).sort().join(',') === 'id,isActive,role')).toBe(true);
  expect(spies.writes).not.toHaveBeenCalled(); expect(spies.audit).not.toHaveBeenCalled();
  expect(spies.create).not.toHaveBeenCalled(); expect(spies.list).not.toHaveBeenCalled(); expect(spies.lookup).not.toHaveBeenCalled();
  expect(hashPassword).not.toHaveBeenCalled();
}
type Race = 'downgrade' | 'revoked' | 'inactive' | 'missing-user' | 'invalid-role' | 'missing-session' | 'changed-expiry' | 'wrong-owner' | 'expired';
const races: Race[] = ['downgrade', 'revoked', 'inactive', 'missing-user', 'invalid-role', 'missing-session', 'changed-expiry', 'wrong-owner', 'expired'];
function mutate(tx: any, state: Race, uid: string, sid: string, expiry: number) {
  if (state === 'downgrade') tx.update(users).set({ role: 'manager' }).where(eq(users.id, uid)).run();
  if (state === 'revoked') tx.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, sid)).run();
  if (state === 'inactive') tx.update(users).set({ isActive: false }).where(eq(users.id, uid)).run();
  if (state === 'missing-user') tx.delete(users).where(eq(users.id, uid)).run();
  if (state === 'invalid-role') tx.update(users).set({ role: 'invalid' }).where(eq(users.id, uid)).run();
  if (state === 'missing-session') tx.delete(authSessions).where(eq(authSessions.id, sid)).run();
  if (state === 'changed-expiry') tx.update(authSessions).set({ expiresAt: expiry + 1 }).where(eq(authSessions.id, sid)).run();
  if (state === 'wrong-owner') tx.update(authSessions).set({ userId: 'manager' }).where(eq(authSessions.id, sid)).run();
  if (state === 'expired') vi.spyOn(Date, 'now').mockReturnValue(expiry * 1000);
}

describe('user management: fresh administrator, public projection, atomic creation', () => {
  it.each(nonadmins)('%s cannot list or create, even with forged scope and invalid fields', async who => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send('GET', s.tokens[who]), 403);
    denied(await send('POST', s.tokens[who], { role: 'admin', password: null }), 403);
    noDirectoryWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(['GET', 'POST'] as const)('%s rejects anonymous, invalid, pending-2FA and forged session tokens', async method => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    const pending = app.jwt.sign({ id: 'admin', is2FaPending: true, sid: s.sessions.admin.id, exp: s.sessions.admin.expiresAt });
    const forged = app.jwt.sign({ id: 'admin', role: 'admin', sid: 'nonexistent-session', exp: s.sessions.admin.expiresAt });
    for (const token of [undefined, 'invalid-token', pending, forged]) denied(await send(method, token), 401);
    noDirectoryWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each(['GET', 'POST'] as const)('%s ignores stale/forged JWT admin roles', async method => {
    const s = await setup();
    s.db.update(users).set({ role: 'accountant' }).where(eq(users.id, 'admin')).run();
    const forged = app.jwt.sign({ id: 'manager', role: 'admin', sid: s.sessions.manager.id, exp: s.sessions.manager.expiresAt });
    const before = snapshot(), spies = workSpies();
    for (const token of [s.tokens.admin, forged]) denied(await send(method, token), 403);
    noDirectoryWork(spies); expect(snapshot()).toEqual(before);
  });

  it('GET returns the existing exact public DTO including inactive users; SQL computes only PIN presence', async () => {
    const s = await setup();
    s.db.update(users).set({ isActive: false, pinHash: '' }).where(eq(users.id, 'viewer')).run();
    const before = snapshot(), spies = workSpies();
    const response = await send('GET', s.tokens.admin);
    expect(response.statusCode).toBe(200); const body = JSON.parse(response.body);
    expect(body.sort((a: any, b: any) => a.id.localeCompare(b.id))).toEqual(before.users.map(dto).sort((a: any, b: any) => a.id.localeCompare(b.id)));
    for (const row of body) { expect(Object.keys(row).sort()).toEqual(publicKeys); expect(typeof row.hasPin).toBe('boolean'); }
    const directory = spies.selections.mock.calls.filter(([, , method]: any[]) => method === 'all');
    expect(directory).toHaveLength(1);
    const [selection, statement] = directory[0]; expect(Object.keys(selection).sort()).toEqual(publicKeys);
    const projection = statement.sql.slice(0, statement.sql.indexOf(' from '));
    for (const column of ['password_hash', 'two_factor_secret', 'two_factor_backup_codes']) expect(projection).not.toContain(column);
    expect(projection).toMatch(/case when .*"pin_hash" is not null and .*"pin_hash" <> '' then 1 else 0 end/);
    expect(projection).not.toMatch(/,\s*"pin_hash"\s*[,\s]/);
    expect(spies.list).not.toHaveBeenCalled(); expect(decryptField).not.toHaveBeenCalled();
    expect(spies.writes).not.toHaveBeenCalled(); expect(spies.audit).not.toHaveBeenCalled(); expect(hashPassword).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  for (const method of ['GET', 'POST'] as const) it.each(races)(`${method} catches %s after authentication, before directory work or hashing`, async state => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    const fresh = app.projectAccess.requireFreshAdmin;
    vi.spyOn(app.projectAccess, 'requireFreshAdmin').mockImplementation(function (this: any, tx: any, uid: string, sid: string, expiry: number) {
      mutate(tx, state, uid, sid, expiry); return fresh.call(this, tx, uid, sid, expiry);
    });
    denied(await send(method, s.tokens.admin), state === 'downgrade' ? 403 : 401);
    // The deliberate race runs inside the rejected transaction and rolls back.
    expect(snapshot()).toEqual(before); expect(hashPassword).not.toHaveBeenCalled();
    expect(spies.selections.mock.calls.every(([selection]: any[]) => Object.keys(selection).sort().join(',') === 'id,isActive,role')).toBe(true);
    expect(spies.audit).not.toHaveBeenCalled(); expect(spies.create).not.toHaveBeenCalled(); expect(spies.list).not.toHaveBeenCalled();
  });

  for (const stage of ['password', 'pin'] as const) it.each(races)(`POST rechecks %s during ${stage} hash await against original session expiry`, async state => {
    const s = await setup(), entered = defer(), release = defer();
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction');
    const fresh = vi.spyOn(app.projectAccess, 'requireFreshAdmin');
    vi.mocked(hashPassword).mockImplementation(async value => {
      if (value === (stage === 'password' ? input.password : '4815')) { entered.resolve(); await release.promise; }
      return realCrypto.hashPassword(value);
    });
    const pending = send('POST', s.tokens.admin, { ...input, pin: '4815' }).then((r: any) => r);
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Request finished before reaching the hash boundary'); })]);
    expect(fresh).toHaveBeenCalledTimes(1);
    mutate(s.db, state, 'admin', s.sessions.admin.id, s.sessions.admin.expiresAt);
    const changed = snapshot(); release.resolve();
    denied(await pending, state === 'downgrade' ? 403 : 401);
    expect(fresh).toHaveBeenCalledTimes(2); expect(snapshot()).toEqual(changed); expect(audit).not.toHaveBeenCalled();
    expect(snapshot().users.some((u: any) => u.username === input.username)).toBe(false);
  });

  it.each([
    { username: 'ab' }, { username: 'x'.repeat(51) }, { email: 'not-email' }, { fullName: 'x' }, { fullName: 'x'.repeat(101) },
    { password: 'short' }, { password: 'x'.repeat(129) }, { role: 'root' }, { pin: '12' }, { pin: 'abcdef' }, { pin: null },
  ])('POST preserves CreateUserSchema validation for %j before hashing or writes', async fields => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send('POST', s.tokens.admin, { ...input, ...fields }), 400);
    noDirectoryWork(spies); expect(snapshot()).toEqual(before);
  });

  it.each([{ payload: [] }, { payload: ['username'] }, { payload: { username: ['bad'] } }])('POST rejects malformed object shape %j', async ({ payload }) => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    denied(await send('POST', s.tokens.admin, payload), 400); noDirectoryWork(spies); expect(snapshot()).toEqual(before);
  });

  for (const role of ['admin', 'manager', 'accountant', 'auditor', 'viewer', undefined]) it.each([undefined, '4815'])('creates ' + String(role) + ' with optional PIN %s using real scrypt, safe DTO and no grants/session', async pin => {
    const s = await setup(), before = snapshot(), spies = workSpies();
    const response = await send('POST', s.tokens.admin, { ...input, ...(role ? { role } : {}), ...(pin ? { pin } : {}),
      id: 'attacker-id', isActive: false, hasPin: true, passwordHash: 'attacker-password-hash', pinHash: 'attacker-pin-hash',
      twoFactorEnabled: true, twoFactorSecret: 'attacker-totp', twoFactorBackupCodes: ['attacker-code'],
      createdAt: now, updatedAt: now, session: { id: 'attacker-session' }, sid: 'attacker-session', token: 'attacker-token', projectIds: ['site1'] });
    expect(response.statusCode).toBe(201); const body = JSON.parse(response.body);
    expect(Object.keys(body).sort()).toEqual(publicKeys); expect(body.id).toMatch(/^[0-9a-f-]{36}$/); expect(body.id).not.toBe('attacker-id');
    const stored = s.db.select().from(users).where(eq(users.id, body.id)).get();
    expect(body).toEqual(dto(stored)); expect(body).toMatchObject({ username: input.username, email: input.email, fullName: input.fullName, role: role ?? 'viewer', isActive: true, hasPin: !!pin, twoFactorEnabled: false });
    expect(body.createdAt).not.toBe(now); expect(new Date(body.createdAt).toISOString()).toBe(body.createdAt); expect(body.updatedAt).toBe(body.createdAt);
    expect(stored.passwordHash).toMatch(/^scrypt:v1:/); expect(await verifyPassword(input.password, stored.passwordHash)).toBe(true);
    expect(await verifyPassword('Synthetic-wrong-password', stored.passwordHash)).toBe(false);
    if (pin) { expect(await verifyPassword(pin, stored.pinHash)).toBe(true); expect(stored.pinHash).not.toBe(stored.passwordHash); }
    else expect(stored.pinHash).toBeNull();
    expect(stored.twoFactorSecret).toBeNull(); expect(stored.twoFactorBackupCodes).toBe('[]');
    expect(hashPassword).toHaveBeenCalledTimes(pin ? 2 : 1);
    const after = snapshot(); expect(after.users).toHaveLength(before.users.length + 1);
    expect(after.users.filter((u: any) => u.id !== body.id)).toEqual(before.users);
    expect(after.sessions).toEqual(before.sessions); expect(after.memberships).toEqual(before.memberships); expect(after.projects).toEqual(before.projects);
    expect(after.audit).toHaveLength(before.audit.length + 1);
    expect(spies.audit).toHaveBeenCalledTimes(1); expect(spies.audit.mock.calls[0][0]).toMatchObject({ userId: 'admin', action: 'CREATE', entity: 'user', entityId: body.id, newState: { username: input.username, role: role ?? 'viewer' } });
    expect(Object.keys(spies.audit.mock.calls[0][0].newState).sort()).toEqual(['role', 'username']);
    expect(app.auditRepo.listAuditLogs(1, config.masterKey)[0].newState).toEqual({ username: input.username, role: role ?? 'viewer' });
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
    expect(spies.create).not.toHaveBeenCalled(); expect(spies.lookup).not.toHaveBeenCalled();
    expect(response.body).not.toContain(input.password); expect(body).not.toHaveProperty('pin'); expect(response.body).not.toContain('scrypt:v1:');
  });

  it.each(['username', 'email', 'username-matches-email', 'email-matches-username'] as const)('POST rejects duplicate %s, including inactive identifiers, without audit or mutations', async variant => {
    const s = await setup();
    // Email-shaped usernames are valid; the legacy login OR lookup must never
    // acquire a second match through a cross-column collision.
    s.db.update(users).set({ username: 'existing@example.test', isActive: false }).where(eq(users.id, 'viewer')).run();
    const fields = variant === 'username' ? { username: 'existing@example.test' }
      : variant === 'email' ? { email: 'viewer@example.test' }
      : variant === 'username-matches-email' ? { username: 'viewer@example.test' } : { email: 'existing@example.test' };
    const before = snapshot(), spies = workSpies();
    denied(await send('POST', s.tokens.admin, { ...input, ...fields }), 409);
    expect(snapshot()).toEqual(before); expect(spies.writes).not.toHaveBeenCalled(); expect(spies.audit).not.toHaveBeenCalled(); expect(spies.lookup).not.toHaveBeenCalled();
    const conflict = spies.selections.mock.calls.find(([, query]: any[]) => query.sql.includes('"username" ='));
    expect(conflict).toBeDefined(); expect(Object.keys(conflict![0])).toEqual(['id']);
    expect(conflict![1].sql).not.toContain(input.username); expect(conflict![1].params).toContain(({ ...input, ...fields }).username);
  });

  it.each(['same-identifiers', 'cross-identifiers'] as const)('concurrent requests with %s serialize duplicate checks and create only one audited row', async variant => {
    const s = await setup(), before = snapshot(), entered = defer(), release = defer(); let arrivals = 0;
    vi.mocked(hashPassword).mockImplementation(async value => {
      const result = await realCrypto.hashPassword(value); arrivals++;
      if (arrivals === 2) entered.resolve(); await release.promise; return result;
    });
    const second = variant === 'same-identifiers' ? { ...input } : { ...input, username: input.email, email: 'different@example.test' };
    const a = send('POST', s.tokens.admin).then((r: any) => r), b = send('POST', s.tokens.admin, second).then((r: any) => r);
    await Promise.race([entered.promise, a.then(() => { throw new Error('First request missed the hash boundary'); }), b.then(() => { throw new Error('Second request missed the hash boundary'); })]);
    release.resolve(); const responses = await Promise.all([a, b]);
    expect(responses.map(r => r.statusCode).sort()).toEqual([201, 409]);
    expect(snapshot().users).toHaveLength(before.users.length + 1); expect(snapshot().audit).toHaveLength(before.audit.length + 1);
    expect(snapshot().sessions).toEqual(before.sessions); expect(snapshot().memberships).toEqual(before.memberships);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it('POST preserves exact identifiers without silently normalizing legacy users', async () => {
    const s = await setup();
    const response = await send('POST', s.tokens.admin, { ...input, username: ' Admin ', email: 'Admin@example.test' });
    expect(response.statusCode).toBe(201); expect(JSON.parse(response.body)).toMatchObject({ username: ' Admin ', email: 'Admin@example.test' });
  });

  it.each(['insert-fails', 'zero-changes', 'audit-insert-fails'] as const)('rolls back %s safely and retries with an intact audit chain', async failure => {
    const s = await setup(), before = snapshot();
    if (failure === 'insert-fails') s.db.run(sql`CREATE TRIGGER synthetic_user_insert_failure BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'Synthetic private SQLITE_ insert failure'); END`);
    if (failure === 'zero-changes') s.db.run(sql`CREATE TRIGGER synthetic_user_insert_failure BEFORE INSERT ON users BEGIN SELECT RAISE(IGNORE); END`);
    if (failure === 'audit-insert-fails') s.db.run(sql`CREATE TRIGGER synthetic_user_insert_failure BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'Synthetic private SQLITE_ audit failure'); END`);
    denied(await send('POST', s.tokens.admin), 500); expect(snapshot()).toEqual(before);
    s.db.run(sql`DROP TRIGGER synthetic_user_insert_failure`);
    expect((await send('POST', s.tokens.admin)).statusCode).toBe(201);
    expect(snapshot().users).toHaveLength(before.users.length + 1); expect(snapshot().audit).toHaveLength(before.audit.length + 1);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it.each(['before-audit-insert', 'after-audit-insert'] as const)('rolls back actual user creation on %s exception and retries', async failure => {
    const s = await setup(), before = snapshot(), original = AuditLogRepository.prototype.logAction; let seen = false;
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args: any[]) {
      expect(this.db).not.toBe(s.db);
      expect(this.db.select().from(users).where(eq(users.username, input.username)).get()).toBeDefined();
      if (failure === 'after-audit-insert') {
        const logged = original.apply(this, args);
        expect(this.db.select().from(auditLogs).where(eq(auditLogs.id, logged.id)).get()).toBeDefined();
      }
      seen = true; throw new Error('Synthetic private SQLITE_ audit exception enc:v1:payload');
    });
    denied(await send('POST', s.tokens.admin), 500); expect(seen).toBe(true); expect(snapshot()).toEqual(before);
    audit.mockRestore(); expect((await send('POST', s.tokens.admin)).statusCode).toBe(201);
    expect(snapshot().audit).toHaveLength(before.audit.length + 1); expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it.each(['GET', 'POST'] as const)('%s transaction errors return a safe 500 and permit retry', async method => {
    const s = await setup(), before = snapshot(), original = s.db.transaction;
    const failure = vi.spyOn(s.db, 'transaction').mockImplementation(() => { throw new Error('Synthetic private SQLITE_ enc:v1:payload'); });
    denied(await send(method, s.tokens.admin), 500); expect(snapshot()).toEqual(before); expect(hashPassword).not.toHaveBeenCalled();
    failure.mockRestore(); expect(s.db.transaction).toBe(original);
    expect((await send(method, s.tokens.admin)).statusCode).toBe(method === 'GET' ? 200 : 201);
  });

  it('GET directory query failure after successful fresh authorization is safe, read-only and retryable', async () => {
    const s = await setup(), before = snapshot(), transaction = s.db.transaction;
    const audit = vi.spyOn(AuditLogRepository.prototype, 'logAction'); let attempted = false;
    const failure = vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, ...args: any[]) => transaction.call(s.db, (tx: any) => {
      const select = tx.select;
      tx.select = function (this: any, selection: any) {
        if (selection && 'hasPin' in selection) { attempted = true; throw new Error('Synthetic private SQLITE_ directory read failure'); }
        return select.call(this, selection);
      };
      return callback(tx);
    }, ...args));
    denied(await send('GET', s.tokens.admin), 500); expect(attempted).toBe(true); expect(snapshot()).toEqual(before); expect(audit).not.toHaveBeenCalled();
    failure.mockRestore(); expect((await send('GET', s.tokens.admin)).statusCode).toBe(200); expect(snapshot()).toEqual(before);
  });

  it.each(['password', 'pin'] as const)('%s hashing failure is safe and creates neither a user nor an audit record', async stage => {
    const s = await setup(), before = snapshot();
    vi.mocked(hashPassword).mockImplementationOnce(async value => {
      if (stage === 'password') throw new Error('Synthetic private SQLITE_ hash failure');
      return realCrypto.hashPassword(value);
    });
    if (stage === 'pin') vi.mocked(hashPassword).mockRejectedValueOnce(new Error('Synthetic private SQLITE_ hash failure'));
    denied(await send('POST', s.tokens.admin, { ...input, pin: '4815' }), 500); expect(snapshot()).toEqual(before);
    expect((await send('POST', s.tokens.admin)).statusCode).toBe(201);
  });

  it.each(['GET', 'POST'] as const)('%s uses synchronous same-tx authorization/data/audit and commits before response serialization', async method => {
    const s = await setup(), transaction = s.db.transaction, fresh = app.projectAccess.requireFreshAdmin, log = AuditLogRepository.prototype.logAction;
    let currentTx: any, committed = false, transactions = 0, freshCalls = 0, serializations = 0, inserts = 0, audits = 0;
    const events: string[] = [], stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation((value: any, replacer?: any, space?: any) => {
      const isResponse = method === 'GET' ? Array.isArray(value) && value.some(v => v?.id === 'admin' && typeof v?.hasPin === 'boolean')
        : value?.username === input.username && typeof value?.hasPin === 'boolean';
      if (isResponse) { serializations++; expect(committed).toBe(true); expect(currentTx).toBeUndefined(); }
      return stringify(value, replacer, space);
    });
    vi.spyOn(s.db, 'transaction').mockImplementation((callback: any, options: any) => {
      transactions++; committed = false;
      expect(options).toEqual(method === 'POST' && transactions === 2 ? { behavior: 'immediate' } : undefined);
      const result = transaction.call(s.db, (tx: any) => {
        currentTx = tx;
        const select = tx.select, insert = tx.insert;
        tx.select = function (this: any, ...args: any[]) {
          const selection = args[0];
          if (selection && ('fullName' in selection || Object.keys(selection).join(',') === 'id')) {
            expect(currentTx).toBe(tx); expect(events.at(-1)).toBe('fresh'); events.push('data');
          }
          return select.apply(this, args);
        };
        tx.insert = function (this: any, table: any, ...rest: any[]) {
          expect(currentTx).toBe(tx); if (table === users) { inserts++; expect(events.at(-1)).toBe('data'); events.push('insert'); }
          return insert.call(this, table, ...rest);
        };
        try { const result = callback(tx); expect(result).not.toBeInstanceOf(Promise); return result; }
        finally { currentTx = undefined; }
      }, options);
      committed = true; return result;
    });
    vi.spyOn(app.projectAccess, 'requireFreshAdmin').mockImplementation(function (this: any, tx: any, ...args: any[]) {
      expect(tx).toBe(currentTx); const result = fresh.call(this, tx, ...args); freshCalls++; events.push('fresh'); return result;
    });
    vi.mocked(hashPassword).mockImplementation(async value => {
      expect(currentTx).toBeUndefined(); expect(committed).toBe(true); events.push('hash'); return realCrypto.hashPassword(value);
    });
    vi.spyOn(AuditLogRepository.prototype, 'logAction').mockImplementation(function (this: any, ...args: any[]) {
      audits++; expect(this.db).toBe(currentTx); expect(events.at(-1)).toBe('insert'); events.push('audit'); return log.apply(this, args);
    });
    const response = await send(method, s.tokens.admin, { ...input, pin: '4815' });
    expect(response.statusCode).toBe(method === 'GET' ? 200 : 201); expect(serializations).toBe(1);
    expect(transactions).toBe(method === 'GET' ? 1 : 2); expect(freshCalls).toBe(transactions);
    expect(inserts).toBe(method === 'GET' ? 0 : 1); expect(audits).toBe(inserts);
    expect(events).toEqual(method === 'GET' ? ['fresh', 'data'] : ['fresh', 'hash', 'hash', 'fresh', 'data', 'insert', 'audit']);
    expect(committed).toBe(true); expect(currentTx).toBeUndefined();
  });
});
