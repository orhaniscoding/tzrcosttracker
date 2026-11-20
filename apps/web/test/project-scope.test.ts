import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { Project, Transaction } from '@cost-core/types';
import { ApiClient, ApiError } from '../src/api/client.js';
import { ProjectScopeController, canRenderScopedView, type ScopeState } from '../src/project-scope.js';
import { canAccessView, canCreateProject, isPersonalView, validRoles } from '../src/view-access.js';
import { Sidebar, type NavView } from '../src/components/Sidebar.js';
import { ProjectSelector, canSubmitProject } from '../src/components/ProjectSelector.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const projects = [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }] as Project[];
const tx = (title: string) => [{ id: title, title }] as Transaction[];
const controllers: ProjectScopeController[] = [];
function setup(role = 'admin') {
  const api = {
    getToken: () => ApiClient.getToken(), getAuthGeneration: () => ApiClient.getAuthGeneration(),
    subscribeAuthChange: (listener: () => void) => ApiClient.subscribeAuthChange(listener),
    getProjects: vi.fn(async (): Promise<Project[]> => projects),
    getCategories: vi.fn(async () => []),
    getTransactions: vi.fn(async (_query = ''): Promise<Transaction[]> => tx('current')),
    getBalance: vi.fn(async (_id?: string) => ({ label: 'current' })),
    verifyAudit: vi.fn(async () => ({ verified: true })),
  };
  const controller = new ProjectScopeController(api); controllers.push(controller);
  controller.connect(); controller.setActor({ id: 'synthetic-user', role });
  return { api, controller };
}
async function advance() { await Promise.resolve(); await Promise.resolve(); }
beforeEach(() => ApiClient.setToken('synthetic-session'));
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  ApiClient.setToken(null); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('App-used project scope controller', () => {
  it.each(['site A', 'site%20A', 'site%2520A', '%'])('passes raw project ID %s through the real balance client without ambiguity', async id => {
    const { api, controller } = setup('manager');
    api.getProjects.mockResolvedValue([{ id, name: id }] as Project[]);
    api.getBalance.mockImplementation(ApiClient.getBalance);
    const request = vi.spyOn(ApiClient, 'request').mockImplementation(async endpoint => ({ label: new URL(endpoint, 'https://synthetic.invalid').searchParams.get('projectId') }) as any);
    await controller.selectProject(id);
    expect(api.getBalance).toHaveBeenLastCalledWith(id);
    expect(request).toHaveBeenLastCalledWith(`/reports/balance?projectId=${encodeURIComponent(id)}`);
    expect(controller.getSnapshot().balance).toEqual({ label: id });
    expect(new URLSearchParams(api.getTransactions.mock.calls[0][0]).get('projectId')).toBe(id);
  });
  it('keeps the App keyed scope stable on refresh but changes it on login, project, membership and lock boundaries', async () => {
    const { api, controller } = setup('manager');
    const loginKey = controller.getSnapshot().scopeKey;
    expect(loginKey).toBeGreaterThan(0);
    await controller.selectProject('A'); const key = controller.getSnapshot().scopeKey;
    expect(key).toBeGreaterThan(loginKey);
    const pending = deferred<Project[]>(); api.getProjects.mockReturnValueOnce(pending.promise);
    const read = controller.reload();
    expect(controller.getSnapshot()).toMatchObject({ ready: false, loading: true, scopeKey: key });
    for (const view of ['accounts_hub', 'trash_list'] as const) expect(canRenderScopedView('manager', view, controller.getSnapshot())).toBe(true);
    pending.resolve(projects.map(p => ({ ...p }))); await read;
    expect(controller.getSnapshot().scopeKey).toBe(key);
    await controller.selectProject('B'); expect(controller.getSnapshot().scopeKey).toBeGreaterThan(key);
    const switched = controller.getSnapshot().scopeKey;
    api.getProjects.mockResolvedValueOnce([projects[1]]); await controller.reload();
    expect(controller.getSnapshot().scopeKey).toBeGreaterThan(switched);
    const memberKey = controller.getSnapshot().scopeKey; controller.lock();
    expect(controller.getSnapshot().scopeKey).toBeGreaterThan(memberKey);
  });
  it('App refresh gate rejects errors, missing memberships and invalid/unauthorized roles, while keeping personal settings', () => {
    const refreshing = { ready: false, loading: true, error: '', noProjects: false, scopeAuthorized: true };
    expect(canRenderScopedView('manager', 'trash_list', refreshing)).toBe(true);
    expect(canRenderScopedView('manager', 'accounts_hub', { ...refreshing, error: 'denied' })).toBe(false);
    expect(canRenderScopedView('manager', 'trash_list', { ...refreshing, noProjects: true })).toBe(false);
    expect(canRenderScopedView('unknown', 'trash_list', refreshing)).toBe(false);
    expect(canRenderScopedView('viewer', 'transactions_new', refreshing)).toBe(false);
    expect(canRenderScopedView('viewer', 'users_pin', { ...refreshing, noProjects: true })).toBe(true);
    expect(canRenderScopedView('manager', 'trash_list', { ...refreshing, loading: false })).toBe(false);
  });
  it('waits for project authorization before any financial request', async () => {
    const { api, controller } = setup('viewer');
    const list = deferred<Project[]>(); api.getProjects.mockReturnValueOnce(list.promise);
    const read = controller.reload();
    expect(api.getTransactions).not.toHaveBeenCalled(); expect(api.getBalance).not.toHaveBeenCalled();
    list.resolve(projects); await read;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, selectedProjectId: null });
    expect(api.verifyAudit).not.toHaveBeenCalled();
  });
  it('synchronously clears A on B selection and ignores late A load and balance', async () => {
    const { api, controller } = setup(); await controller.selectProject('A');
    const oldTx = deferred<Transaction[]>(), oldBal = deferred<{ label: string }>();
    api.getTransactions.mockReturnValueOnce(oldTx.promise); api.getBalance.mockReturnValueOnce(oldBal.promise);
    const a = controller.reload(); await advance();
    api.getTransactions.mockResolvedValueOnce(tx('B')); api.getBalance.mockResolvedValueOnce({ label: 'B' });
    const b = controller.selectProject('B');
    expect(controller.getSnapshot()).toMatchObject({ transactions: [], balance: null, auditVerified: null, selectedProjectId: 'B', ready: false });
    await b; oldTx.resolve(tx('A')); oldBal.resolve({ label: 'A' }); await a;
    expect(controller.getSnapshot()).toMatchObject({ transactions: tx('B'), balance: { label: 'B' }, selectedProjectId: 'B' });
    expect(api.getTransactions).toHaveBeenLastCalledWith('projectId=B');
  });
  it('latest search beats an older load, and newer load beats late search', async () => {
    const { api, controller } = setup(); await controller.selectProject('A');
    const old = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(old.promise);
    const load = controller.reload(); await advance();
    api.getTransactions.mockResolvedValueOnce(tx('search'));
    await controller.search('x & y'); old.resolve(tx('old load')); await load;
    expect(controller.getSnapshot().transactions).toEqual(tx('search'));
    expect(api.getTransactions).toHaveBeenLastCalledWith('projectId=A&searchTitle=x+%26+y');
    const search = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(search.promise);
    const pending = controller.search('old'); await advance();
    api.getTransactions.mockResolvedValueOnce(tx('B')); await controller.selectProject('B');
    search.resolve(tx('old search')); await pending;
    expect(controller.getSnapshot().transactions).toEqual(tx('B'));
  });
  it('a late old search failure cannot clear a newer successful load', async () => {
    const { api, controller } = setup(); await controller.reload();
    const old = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(old.promise);
    const pending = controller.search('old'); await advance(); await controller.selectProject('B');
    old.reject(new ApiError('unsafe old denial', 403)); await pending;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, error: '', selectedProjectId: 'B' });
  });
  it('late audit A cannot overwrite B or a newer verification', async () => {
    const { api, controller } = setup();
    const audit = deferred<{ verified: boolean }>(); api.verifyAudit.mockReturnValueOnce(audit.promise);
    const a = controller.selectProject('A'); await advance(); await advance();
    await controller.selectProject('B');
    expect(controller.getSnapshot().auditVerified).toBe(true);
    audit.resolve({ verified: false }); await a;
    expect(controller.getSnapshot().auditVerified).toBe(true);
    const old = deferred<{ verified: boolean }>(); api.verifyAudit.mockReturnValueOnce(old.promise);
    const pending = controller.refreshAudit(); await controller.refreshAudit();
    old.resolve({ verified: false }); await pending;
    expect(controller.getSnapshot().auditVerified).toBe(true);
  });
  it('verification failure becomes unknown, never previous success', async () => {
    const { api, controller } = setup(); await controller.reload();
    api.verifyAudit.mockRejectedValueOnce(new Error('offline')); await controller.refreshAudit();
    expect(controller.getSnapshot().auditVerified).toBeNull();
    expect(controller.getSnapshot().ready).toBe(true);
  });
  it('lock invalidates a pending audit and unlock starts a fresh scope', async () => {
    const { api, controller } = setup(); await controller.selectProject('A');
    const audit = deferred<{ verified: boolean }>(); api.verifyAudit.mockReturnValueOnce(audit.promise);
    const pending = controller.refreshAudit(); controller.lock();
    expect(controller.getSnapshot()).toMatchObject({ transactions: [], balance: null, auditVerified: null, ready: false });
    controller.setActor({ id: 'synthetic-user', role: 'admin' }); await controller.reload();
    audit.resolve({ verified: false }); await pending;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, auditVerified: true });
  });
  it('a disposed controller ignores its pending project list and can reconnect for a new lifetime', async () => {
    const { api, controller } = setup(); const list = deferred<Project[]>(); api.getProjects.mockReturnValueOnce(list.promise);
    const pending = controller.reload(); controller.dispose(); list.resolve(projects); await pending;
    expect(api.getTransactions).not.toHaveBeenCalled(); expect(controller.getSnapshot().projects).toEqual([]);
    controller.connect(); controller.setActor({ id: 'new-user', role: 'viewer' }); await controller.reload();
    expect(controller.getSnapshot().ready).toBe(true);
  });
  it('two searches in one project share a child key but only the latest may publish', async () => {
    const { api, controller } = setup(); await controller.selectProject('A');
    const key = controller.getSnapshot().scopeKey, old = deferred<Transaction[]>();
    api.getTransactions.mockReturnValueOnce(old.promise); const pending = controller.search('old'); await advance();
    api.getTransactions.mockResolvedValueOnce(tx('latest')); await controller.search('latest');
    old.resolve(tx('old')); await pending;
    expect(controller.getSnapshot().transactions).toEqual(tx('latest')); expect(controller.getSnapshot().scopeKey).toBe(key);
  });
  it('removed selection reloads authorized aggregate and remounts private children', async () => {
    const { api, controller } = setup('accountant'); await controller.selectProject('A');
    const key = controller.getSnapshot().scopeKey;
    api.getProjects.mockResolvedValueOnce([projects[1]]); await controller.reload();
    expect(controller.getSnapshot()).toMatchObject({ selectedProjectId: null, projects: [projects[1]], ready: true });
    expect(controller.getSnapshot().scopeKey).toBeGreaterThan(key);
    expect(api.getTransactions).toHaveBeenLastCalledWith(''); expect(api.getBalance).toHaveBeenLastCalledWith(undefined);
  });
  it('loss of all memberships clears data and skips financial requests, with recovery', async () => {
    const { api, controller } = setup('viewer'); await controller.selectProject('A');
    api.getTransactions.mockClear(); api.getBalance.mockClear(); api.getCategories.mockClear();
    api.getProjects.mockResolvedValueOnce([]); await controller.reload();
    expect(controller.getSnapshot()).toMatchObject({ noProjects: true, ready: false, selectedProjectId: null, transactions: [], balance: null, auditVerified: null });
    expect(api.getTransactions).not.toHaveBeenCalled(); expect(api.getBalance).not.toHaveBeenCalled(); expect(api.getCategories).not.toHaveBeenCalled();
    expect(canAccessView('viewer', 'users_pin')).toBe(true);
    await controller.reload(); expect(controller.getSnapshot()).toMatchObject({ noProjects: false, ready: true });
  });
  it('admin with no projects may still load global authorized financial data', async () => {
    const { api, controller } = setup(); api.getProjects.mockResolvedValueOnce([]); await controller.reload();
    expect(api.getTransactions).toHaveBeenCalledWith(''); expect(controller.getSnapshot().ready).toBe(true);
  });
  it.each([401, 403, 500, 'network'])('project-list failure %s fails closed, reports safe error and retries', async (status) => {
    const { api, controller } = setup(); await controller.selectProject('A');
    api.getTransactions.mockClear(); api.getBalance.mockClear();
    api.getProjects.mockRejectedValueOnce(status === 'network' ? new Error('private details') : new ApiError('private details', Number(status)));
    await controller.reload();
    expect(controller.getSnapshot()).toMatchObject({ projects: [], selectedProjectId: null, transactions: [], balance: null, auditVerified: null, ready: false, noProjects: false, loading: false });
    expect(controller.getSnapshot().error).not.toContain('private'); expect(controller.getSnapshot().error.length).toBeGreaterThan(0);
    expect(api.getTransactions).not.toHaveBeenCalled(); expect(api.getBalance).not.toHaveBeenCalled();
    await controller.reload(); expect(controller.getSnapshot()).toMatchObject({ ready: true, error: '' });
  });
  it.each(['load', 'search', 'balance'])('%s financial failure clears stale data and retries', async (kind) => {
    const { api, controller } = setup(); await controller.reload();
    if (kind === 'balance') api.getBalance.mockRejectedValueOnce(new ApiError('private balance', 403));
    else api.getTransactions.mockRejectedValueOnce(new Error('private title'));
    await (kind === 'search' ? controller.search('term') : controller.reload());
    expect(controller.getSnapshot()).toMatchObject({ transactions: [], balance: null, auditVerified: null, ready: false, loading: false });
    expect(controller.getSnapshot().error).not.toContain('private');
    await controller.reload(); expect(controller.getSnapshot().ready).toBe(true);
  });
  it.each(['manager', 'accountant', 'auditor', 'viewer'])('%s never requests global audit', async (role) => {
    const { api, controller } = setup(role); await controller.reload(); await controller.refreshAudit();
    expect(api.verifyAudit).not.toHaveBeenCalled(); expect(controller.getSnapshot().auditVerified).toBeNull();
  });
  it.each(['synthetic-session', 'different-session'])('token reset (%s), including same token, invalidates pending reads', async (token) => {
    const { api, controller } = setup(); const pending = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(pending.promise);
    const read = controller.reload(); await advance(); ApiClient.setToken(token);
    pending.resolve(tx('stale')); await read;
    expect(controller.getSnapshot()).toMatchObject({ transactions: [], ready: false, balance: null });
    await controller.reload(); expect(api.getProjects).toHaveBeenCalledOnce();
    controller.setActor({ id: 'new-user', role: 'viewer' }); await controller.reload();
    expect(controller.getSnapshot().ready).toBe(true);
  });
  it.each(['lock', 'dispose', 'role', 'identity'])('%s invalidates in-flight search and mutation refresh tickets', async (action) => {
    const { api, controller } = setup(); await controller.selectProject('A');
    const ticket = controller.captureSession(), pending = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(pending.promise);
    const read = controller.search('old'); await advance();
    if (action === 'lock') controller.lock();
    if (action === 'dispose') controller.dispose();
    if (action === 'role') controller.setActor({ id: 'synthetic-user', role: 'viewer' });
    if (action === 'identity') controller.setActor({ id: 'other-user', role: 'admin' });
    pending.resolve(tx('stale')); await read;
    expect(ticket()).toBe(false); expect(controller.getSnapshot()).toMatchObject({ transactions: [], balance: null, auditVerified: null, ready: false });
  });
  it('a mutation finishing after A→B refreshes B, not a captured A selection', async () => {
    const { api, controller } = setup(); await controller.selectProject('A');
    const ticket = controller.captureSession(); await controller.selectProject('B');
    expect(ticket()).toBe(true); if (ticket()) await controller.reload();
    expect(api.getTransactions).toHaveBeenLastCalledWith('projectId=B');
  });
  it('unknown roles and absent sessions cannot read data or audit', async () => {
    const { controller, api } = setup('unexpected'); await controller.reload(); await controller.refreshAudit();
    expect(api.getProjects).not.toHaveBeenCalled(); expect(api.verifyAudit).not.toHaveBeenCalled();
    ApiClient.setToken(null); controller.setActor({ id: 'u', role: 'admin' }); await controller.reload();
    expect(api.getProjects).not.toHaveBeenCalled();
  });
  it('real client SESSION_INVALID clears pending controller state, not successful empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ code: 'SESSION_INVALID', error: 'expired' }) })));
    const controller = new ProjectScopeController(); controllers.push(controller); controller.connect(); controller.setActor({ id: 'u', role: 'admin' });
    await controller.reload(); expect(ApiClient.getToken()).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({ transactions: [], balance: null, ready: false, noProjects: false });
  });
});

describe('scopeAuthorized gate keeps unverified scopes closed', () => {
  const scoped: NavView[] = ['accounts_hub', 'trash_list', 'transactions_list', 'kasa_balance'];
  async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
  const closedFor = (controller: ProjectScopeController) => {
    for (const view of scoped) expect(canRenderScopedView('manager', view, controller.getSnapshot())).toBe(false);
  };
  it('keeps every scoped leaf closed during the deferred initial project read', async () => {
    const { api, controller } = setup('manager');
    const list = deferred<Project[]>(); api.getProjects.mockReturnValueOnce(list.promise);
    const read = controller.reload();
    expect(controller.getSnapshot()).toMatchObject({ loading: true, ready: false, scopeAuthorized: false });
    closedFor(controller);
    for (const view of ['users_pin', 'security_lock', 'security_2fa'] as NavView[]) {
      expect(canRenderScopedView('manager', view, controller.getSnapshot())).toBe(true);
    }
    expect(api.getTransactions).not.toHaveBeenCalled(); expect(api.getBalance).not.toHaveBeenCalled();
    const financial = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(financial.promise);
    list.resolve(projects); await flush();
    expect(controller.getSnapshot()).toMatchObject({ loading: true, scopeAuthorized: false, noProjects: false });
    closedFor(controller);
    financial.resolve(tx('ready')); await read;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, loading: false, scopeAuthorized: true });
    for (const view of scoped) expect(canRenderScopedView('manager', view, controller.getSnapshot())).toBe(true);
  });
  it.each(['failure', 'noProjects'] as const)('stays closed through a deferred retry after %s', async kind => {
    const { api, controller } = setup(kind === 'failure' ? 'manager' : 'viewer');
    if (kind === 'failure') {
      api.getProjects.mockRejectedValueOnce(new ApiError('private denial', 403)); await controller.reload();
      expect(controller.getSnapshot()).toMatchObject({ scopeAuthorized: false, ready: false });
    } else {
      api.getProjects.mockResolvedValueOnce([]); await controller.reload();
      expect(controller.getSnapshot()).toMatchObject({ noProjects: true, loading: false, scopeAuthorized: false });
    }
    closedFor(controller);
    const retry = deferred<Project[]>(); api.getProjects.mockReturnValueOnce(retry.promise);
    const read = controller.reload();
    expect(controller.getSnapshot()).toMatchObject({ loading: true, error: '', scopeAuthorized: false });
    closedFor(controller);
    const financial = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(financial.promise);
    retry.resolve(kind === 'failure' ? projects : [projects[0]]); await flush();
    expect(controller.getSnapshot()).toMatchObject({ loading: true, scopeAuthorized: false });
    closedFor(controller);
    financial.resolve(tx('recovered')); await read;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, scopeAuthorized: true });
  });
  it('stays closed while project B loads after a selection switch', async () => {
    const { api, controller } = setup('manager');
    await controller.selectProject('A');
    expect(controller.getSnapshot().scopeAuthorized).toBe(true);
    const list = deferred<Project[]>(); api.getProjects.mockReturnValueOnce(list.promise);
    const read = controller.selectProject('B');
    expect(controller.getSnapshot()).toMatchObject({ loading: true, ready: false, selectedProjectId: 'B', scopeAuthorized: false });
    closedFor(controller);
    const financial = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(financial.promise);
    list.resolve(projects); await flush();
    closedFor(controller);
    financial.resolve(tx('B')); await read;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, selectedProjectId: 'B', scopeAuthorized: true });
    for (const view of scoped) expect(canRenderScopedView('manager', view, controller.getSnapshot())).toBe(true);
  });
  it('keeps the authorized scope rendered during same-scope reload and search', async () => {
    const { api, controller } = setup('manager'); await controller.selectProject('A');
    const key = controller.getSnapshot().scopeKey;
    const reloadRead = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(reloadRead.promise);
    const reload = controller.reload();
    expect(controller.getSnapshot()).toMatchObject({ loading: true, ready: false, scopeAuthorized: true, scopeKey: key });
    for (const view of scoped) expect(canRenderScopedView('manager', view, controller.getSnapshot())).toBe(true);
    reloadRead.resolve(tx('reload')); await reload;
    const searchRead = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(searchRead.promise);
    const search = controller.search('needle');
    expect(controller.getSnapshot()).toMatchObject({ loading: true, ready: false, scopeAuthorized: true, scopeKey: key });
    expect(canRenderScopedView('manager', 'transactions_list', controller.getSnapshot())).toBe(true);
    searchRead.resolve(tx('search')); await search;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, scopeAuthorized: true, scopeKey: key });
    expect(api.getTransactions).toHaveBeenLastCalledWith('projectId=A&searchTitle=needle');
  });
  it('immediately closes an authorized scope when a reload reveals membership loss', async () => {
    const { api, controller } = setup('manager'); await controller.selectProject('A');
    const list = deferred<Project[]>(); api.getProjects.mockReturnValueOnce(list.promise);
    const financial = deferred<Transaction[]>(); api.getTransactions.mockReturnValueOnce(financial.promise);
    const read = controller.reload();
    expect(controller.getSnapshot().scopeAuthorized).toBe(true);
    list.resolve([projects[1]]); await flush();
    expect(controller.getSnapshot()).toMatchObject({ loading: true, scopeAuthorized: false, selectedProjectId: null });
    closedFor(controller);
    financial.resolve(tx('aggregate')); await read;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, scopeAuthorized: true, selectedProjectId: null });
  });
});

describe('atomic scope revocation publish', () => {
  async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
  function record(controller: ProjectScopeController) {
    const snapshots: ScopeState[] = [];
    controller.subscribe(() => snapshots.push({ ...controller.getSnapshot() }));
    return snapshots;
  }
  it('never publishes an advanced scope key with stale authorization when the selected project is removed', async () => {
    const { api, controller } = setup('manager');
    await controller.selectProject('A');
    const initialKey = controller.getSnapshot().scopeKey;
    const snapshots = record(controller);
    const financial = deferred<Transaction[]>();
    api.getProjects.mockResolvedValueOnce([projects[1]]);
    api.getTransactions.mockReturnValueOnce(financial.promise);
    const read = controller.reload();
    await flush();
    const advanced = snapshots.filter((snap) => snap.scopeKey > initialKey && snap.ready === false);
    expect(advanced.length).toBeGreaterThan(0);
    for (const snap of advanced) {
      expect(snap.scopeAuthorized).toBe(false);
      expect(canRenderScopedView('manager', 'accounts_hub', snap)).toBe(false);
    }
    financial.resolve(tx('aggregate'));
    await read;
    expect(controller.getSnapshot()).toMatchObject({ ready: true, scopeAuthorized: true, selectedProjectId: null });
  });
  it('publishes every notification for fully removed projects without stale authorization', async () => {
    const { api, controller } = setup('viewer');
    await controller.selectProject('A');
    const initialKey = controller.getSnapshot().scopeKey;
    const snapshots = record(controller);
    api.getTransactions.mockClear();
    api.getProjects.mockResolvedValueOnce([]);
    await controller.reload();
    const advanced = snapshots.filter((snap) => snap.scopeKey > initialKey);
    expect(advanced.length).toBeGreaterThan(0);
    for (const snap of advanced) {
      expect(snap.scopeAuthorized).toBe(false);
      expect(snap.noProjects).toBe(true);
      expect(snap.loading).toBe(false);
      expect(canRenderScopedView('manager', 'trash_list', snap)).toBe(false);
    }
    expect(api.getTransactions).not.toHaveBeenCalled();
  });
});

describe('shared App/Sidebar view policy and project-create guards (SSR, no DOM dependency)', () => {
  const adminOnly: NavView[] = ['users_list', 'users_new', 'categories_new', 'parties_ledger', 'audit_logs', 'audit_verify', 'backup_vault', 'settings_branding'];
  it.each(validRoles)('%s has exact admin/write/personal policy', (role) => {
    for (const view of adminOnly) expect(canAccessView(role, view)).toBe(role === 'admin');
    expect(canAccessView(role, 'transactions_new')).toBe(['admin', 'manager', 'accountant'].includes(role));
    for (const view of ['users_pin', 'security_lock', 'security_2fa'] as NavView[]) {
      expect(canAccessView(role, view)).toBe(true); expect(isPersonalView(view)).toBe(true);
    }
    expect(canCreateProject(role)).toBe(role === 'admin');
  });
  it.each([undefined, null, '', 'Admin', 'unknown'])('unknown role %s is denied, not treated as viewer', (role) => {
    for (const view of [...adminOnly, 'transactions_list', 'transactions_new', 'users_pin']) expect(canAccessView(role, view)).toBe(false);
    expect(canCreateProject(role)).toBe(false);
  });
  it('unknown view is denied even for admin', () => expect(canAccessView('admin', 'invented')).toBe(false));
  function sidebar(role: string, currentView: NavView) {
    return renderToString(React.createElement(Sidebar, { role, currentView, auditVerified: true, onSelectView: vi.fn(), onOpen2FA: vi.fn(), onOpenPinSwitch: vi.fn(), onLogout: vi.fn() }));
  }
  it('SSR filters forced-open admin navigation and audit badge for nonadmins', () => {
    for (const role of ['manager', 'accountant', 'auditor', 'viewer', 'unknown']) {
      for (const view of adminOnly) {
        const html = sidebar(role, view);
        expect(html).not.toContain('Kayıtlı Kullanıcılar'); expect(html).not.toContain('Yeni Kullanıcı Tanımla');
        expect(html).not.toContain('Yeni Kategori Tanımla'); expect(html).not.toContain('Cari &amp; Taşeron Karnesi');
        expect(html).not.toContain('İşlem Logları Tablosu'); expect(html).not.toContain('Firma Bilgisi &amp; Logo');
        expect(html).not.toContain('Kriptografik Mühür');
      }
    }
    expect(sidebar('admin', 'users_list')).toContain('Kayıtlı Kullanıcılar');
    expect(sidebar('admin', 'audit_logs')).toContain('Kriptografik Mühür');
  });
  it('SSR keeps personal settings available and excludes viewer transaction creation', () => {
    expect(sidebar('viewer', 'users_pin')).toContain('Kişisel Hızlı PIN Ayarı');
    expect(sidebar('viewer', 'security_lock')).toContain('Kilit &amp; Zaman Aşımı');
    expect(sidebar('viewer', 'transactions_list')).not.toContain('Yeni Harcama Ekle');
    expect(sidebar('manager', 'transactions_list')).toContain('Yeni Harcama Ekle');
  });
  it('actual ProjectSelector submit guard is default-deny and honors disabled/blank input', () => {
    expect(canSubmitProject(false, false, 'new')).toBe(false);
    expect(canSubmitProject(true, true, 'new')).toBe(false);
    expect(canSubmitProject(true, false, '  ')).toBe(false);
    expect(canSubmitProject(true, false, ' new ')).toBe(true);
    const html = renderToString(React.createElement(ProjectSelector, { projects: [], selectedProjectId: null, disabled: true, onSelectProject: vi.fn(), onCreateProject: vi.fn() }));
    expect(html).toContain('disabled'); expect(html).not.toContain('<form'); expect(html).not.toContain('Yeni Proje');
  });
});
