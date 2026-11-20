import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ApiClient, ApiError } from '../src/api/client.js';
import { ProjectMembershipController, canListManagedUsers, type ProjectMember } from '../src/project-membership.js';
import { ProjectMembershipPanel } from '../src/components/ProjectMembershipPanel.js';
import { UserManagementView } from '../src/components/UserManagementView.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const member = (projectId: string, userId = 'viewer'): ProjectMember => ({ projectId, userId, createdAt: '2026-01-01T00:00:00Z' });
const users = [
  { id: 'viewer', fullName: 'Viewer User', username: 'viewer', role: 'viewer', isActive: true },
  { id: 'auditor', fullName: 'Auditor User', username: 'auditor', role: 'auditor', isActive: true },
  { id: 'inactive', fullName: 'Inactive User', username: 'inactive', role: 'accountant', isActive: false },
  { id: 'admin', fullName: 'Admin User', username: 'admin', role: 'admin', isActive: true },
];
const controllers: ProjectMembershipController[] = [];
function setup(role = 'admin') {
  const api = {
    getToken: () => ApiClient.getToken(), getAuthGeneration: () => ApiClient.getAuthGeneration(),
    subscribeAuthChange: (listener: () => void) => ApiClient.subscribeAuthChange(listener),
    getProjects: vi.fn(async () => [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }]),
    getUsers: vi.fn(async () => users),
    getProjectMembers: vi.fn(async (_id: string): Promise<ProjectMember[]> => []),
    putProjectMember: vi.fn(async (_projectId: string, _userId: string) => ({ changed: true })),
    deleteProjectMember: vi.fn(async (_projectId: string, _userId: string) => ({ changed: true })),
  };
  const controller = new ProjectMembershipController(role, api);
  controllers.push(controller);
  return { controller, api };
}
const response = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
beforeEach(() => { ApiClient.setToken('synthetic-session'); });
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  ApiClient.setToken(null);
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('membership client wire contract', () => {
  it('encodes both IDs and sends GET, bodyless PUT and DELETE with bearer but no content-type', async () => {
    const fetchMock = vi.fn(async () => response(200, { changed: false }));
    vi.stubGlobal('fetch', fetchMock);
    await ApiClient.getProjectMembers('pro j/é?#');
    await ApiClient.putProjectMember('pro j/é?#', 'u /?#');
    await ApiClient.deleteProjectMember('pro j/é?#', 'u /?#');
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual([
      '/api/projects/pro%20j%2F%C3%A9%3F%23/members',
      '/api/projects/pro%20j%2F%C3%A9%3F%23/members/u%20%2F%3F%23',
      '/api/projects/pro%20j%2F%C3%A9%3F%23/members/u%20%2F%3F%23',
    ]);
    expect(calls.map(([, init]) => init.method)).toEqual(['GET', 'PUT', 'DELETE']);
    for (const [, init] of calls) {
      expect(init.body).toBeUndefined();
      expect(init.headers).toEqual({ Authorization: 'Bearer synthetic-session' });
    }
  });
  it.each([400, 403, 404, 500])('preserves status %s without changing the session', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(status, { error: 'Synthetic failure' })));
    await expect(ApiClient.putProjectMember('p', 'u')).rejects.toMatchObject({ name: 'ApiError', status });
    expect(ApiClient.getToken()).toBe('synthetic-session');
  });
  it('current SESSION_INVALID clears the real controller and blocks mutations', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/projects') return response(200, [{ id: 'A', name: 'Alpha' }]);
      if (url === '/api/auth/users') return response(200, users);
      return response(401, { error: 'expired', code: 'SESSION_INVALID' });
    }));
    const controller = new ProjectMembershipController('admin'); controllers.push(controller);
    await controller.start(); await controller.selectProject('A');
    expect(ApiClient.getToken()).toBeNull();
    expect(controller.getSnapshot()).toMatchObject({ members: [], projects: [], ready: false, saving: false });
    expect(controller.getSnapshot().error).toMatch(/Oturum/);
    await controller.changeMembership('viewer', true);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(3);
  });
  it('non-JSON HTTP failures and transport errors remain rejected, not successful writes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('not JSON'); } })));
    await expect(ApiClient.deleteProjectMember('p', 'u')).rejects.toMatchObject({ status: 502, name: 'ApiError' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(ApiClient.getProjectMembers('p')).rejects.toThrow('offline');
  });
});

describe('UI membership controller async flow (no DOM mirror)', () => {
  it('loads its own project/user lists, never chooses a project or automatically grants access', async () => {
    const { controller, api } = setup(); await controller.start();
    expect(api.getUsers).toHaveBeenCalledOnce(); expect(api.getProjects).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ projectId: '', members: [], ready: false });
    expect(api.getProjectMembers).not.toHaveBeenCalled(); expect(api.putProjectMember).not.toHaveBeenCalled();
  });
  it('an admin without a session sees a safe error and sends no requests', async () => {
    ApiClient.setToken(null);
    const { controller, api } = setup(); await controller.start();
    expect(controller.getSnapshot().error).toMatch(/Oturum/);
    expect(api.getUsers).not.toHaveBeenCalled(); expect(api.getProjects).not.toHaveBeenCalled();
  });
  it.each(['manager', 'accountant', 'auditor', 'viewer', 'unknown'])('%s cannot fetch or invoke membership writes', async (role) => {
    const { controller, api } = setup(role); await controller.start();
    await controller.selectProject('A'); await controller.changeMembership('viewer', true); await controller.changeMembership('viewer', false);
    expect(api.getUsers).not.toHaveBeenCalled(); expect(api.getProjects).not.toHaveBeenCalled();
    expect(api.getProjectMembers).not.toHaveBeenCalled(); expect(api.putProjectMember).not.toHaveBeenCalled(); expect(api.deleteProjectMember).not.toHaveBeenCalled();
  });
  it('immediately clears A and ignores its late response after selecting B', async () => {
    const { controller, api } = setup(); await controller.start();
    api.getProjectMembers.mockResolvedValueOnce([member('A')]); await controller.selectProject('A');
    const a = deferred<ProjectMember[]>(), b = deferred<ProjectMember[]>();
    api.getProjectMembers.mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const oldRead = controller.reloadMembers(); const nextRead = controller.selectProject('B');
    expect(controller.getSnapshot()).toMatchObject({ projectId: 'B', members: [], ready: false, loadingMembers: true });
    b.resolve([member('B', 'auditor')]); await nextRead;
    a.resolve([member('A')]); await oldRead;
    expect(controller.getSnapshot().members).toEqual([member('B', 'auditor')]);
  });
  it('a late old read error cannot clear the new project', async () => {
    const { controller, api } = setup(); await controller.start();
    const a = deferred<ProjectMember[]>(); api.getProjectMembers.mockImplementationOnce(() => a.promise);
    const oldRead = controller.selectProject('A'); await controller.selectProject('B');
    a.reject(new ApiError('stale', 403)); await oldRead;
    expect(controller.getSnapshot()).toMatchObject({ projectId: 'B', error: '', ready: true });
  });
  it('a failed reload removes all old actionable members, with retry recovery', async () => {
    const { controller, api } = setup(); await controller.start();
    api.getProjectMembers.mockResolvedValueOnce([member('A')]); await controller.selectProject('A');
    api.getProjectMembers.mockRejectedValueOnce(new Error('do not reflect internals'));
    await controller.reloadMembers();
    expect(controller.getSnapshot()).toMatchObject({ members: [], ready: false, loadingMembers: false });
    expect(controller.getSnapshot().error).toMatch(/yeniden/); expect(controller.getSnapshot().error).not.toContain('internals');
    await controller.changeMembership('viewer', true); await controller.changeMembership('viewer', false);
    expect(api.putProjectMember).not.toHaveBeenCalled(); expect(api.deleteProjectMember).not.toHaveBeenCalled();
    await controller.reloadMembers(); expect(controller.getSnapshot()).toMatchObject({ ready: true, error: '' });
  });
  it.each([401, 403])('read failure %s clears directory and selection, never retaining old actions', async (status) => {
    const { controller, api } = setup(); await controller.start();
    api.getProjectMembers.mockRejectedValueOnce(new ApiError('unsafe server details', status));
    await controller.selectProject('A');
    expect(controller.getSnapshot()).toMatchObject({ projects: [], users: [], projectId: '', members: [], ready: false });
    expect(controller.getSnapshot().error).toMatch(status === 401 ? /Oturum/ : /yetki/);
    expect(controller.getSnapshot().error).not.toContain('unsafe');
  });
  it('adds only active nonadmins, removes inactive existing members, and confirms both via read', async () => {
    const { controller, api } = setup(); await controller.start();
    api.getProjectMembers.mockResolvedValueOnce([member('A', 'inactive')]); await controller.selectProject('A');
    expect(controller.getCandidates().map((u) => u.id)).toEqual(['viewer', 'auditor']);
    await controller.changeMembership('inactive', true); await controller.changeMembership('admin', true); await controller.changeMembership('unknown', true);
    expect(api.putProjectMember).not.toHaveBeenCalled();
    await controller.changeMembership('inactive', false);
    expect(api.deleteProjectMember).toHaveBeenCalledWith('A', 'inactive');
    api.getProjectMembers.mockResolvedValueOnce([member('A', 'auditor')]); await controller.changeMembership('auditor', true);
    expect(api.putProjectMember).toHaveBeenCalledWith('A', 'auditor');
    expect(controller.getSnapshot().members).toEqual([member('A', 'auditor')]);
  });
  it('changed:false is neutral success and still reloads the authoritative list', async () => {
    const { controller, api } = setup(); await controller.start(); await controller.selectProject('A');
    api.putProjectMember.mockResolvedValueOnce({ changed: false }); api.getProjectMembers.mockResolvedValueOnce([member('A')]);
    await controller.changeMembership('viewer', true);
    expect(api.getProjectMembers).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({ ready: true, error: '', members: [member('A')] });
    expect(controller.getSnapshot().notice).toMatch(/zaten/);
    api.deleteProjectMember.mockResolvedValueOnce({ changed: false }); await controller.changeMembership('viewer', false);
    expect(controller.getSnapshot().notice).toMatch(/zaten/);
  });
  it('does not optimistically retain writes; confirmation failure leaves no actionable list', async () => {
    const { controller, api } = setup(); await controller.start(); await controller.selectProject('A');
    const write = deferred<{ changed: boolean }>(); api.putProjectMember.mockImplementationOnce(() => write.promise);
    const pending = controller.changeMembership('viewer', true);
    expect(controller.getSnapshot()).toMatchObject({ saving: true, ready: false, members: [] });
    await controller.changeMembership('auditor', true); expect(api.putProjectMember).toHaveBeenCalledOnce();
    api.getProjectMembers.mockRejectedValueOnce(new Error('read failed')); write.resolve({ changed: true }); await pending;
    expect(controller.getSnapshot()).toMatchObject({ saving: false, ready: false, members: [], notice: '' });
  });
  it.each([401, 403, 500])('write %s failure is visible and clears unconfirmed members', async (status) => {
    const { controller, api } = setup(); await controller.start(); await controller.selectProject('A');
    api.putProjectMember.mockRejectedValueOnce(new ApiError('private detail', status)); await controller.changeMembership('viewer', true);
    expect(controller.getSnapshot()).toMatchObject({ saving: false, ready: false, members: [], notice: '' });
    expect(controller.getSnapshot().error).not.toBe(''); expect(controller.getSnapshot().error).not.toContain('private');
  });
  it('late mutation on A never reloads or overwrites B', async () => {
    const { controller, api } = setup(); await controller.start(); await controller.selectProject('A');
    const write = deferred<{ changed: boolean }>(); api.putProjectMember.mockImplementationOnce(() => write.promise);
    const pending = controller.changeMembership('viewer', true); await controller.selectProject('B');
    const snapshot = controller.getSnapshot(); write.resolve({ changed: true }); await pending;
    expect(controller.getSnapshot()).toBe(snapshot); expect(api.getProjectMembers.mock.calls.map(([id]) => id)).toEqual(['A', 'B']);
  });
  it('a late removal error and a late post-write confirmation cannot overwrite B', async () => {
    const { controller, api } = setup(); await controller.start();
    api.getProjectMembers.mockResolvedValueOnce([member('A')]); await controller.selectProject('A');
    const removal = deferred<{ changed: boolean }>(); api.deleteProjectMember.mockImplementationOnce(() => removal.promise);
    const pendingRemoval = controller.changeMembership('viewer', false); await controller.selectProject('B');
    const snapshot = controller.getSnapshot(); removal.reject(new ApiError('old removal', 403)); await pendingRemoval;
    expect(controller.getSnapshot()).toBe(snapshot);
    await controller.selectProject('A');
    const confirmation = deferred<ProjectMember[]>(); api.getProjectMembers.mockImplementationOnce(() => confirmation.promise);
    const pendingWrite = controller.changeMembership('viewer', true);
    // Let the successful PUT reach its deferred confirmation read.
    await Promise.resolve();
    expect(controller.getSnapshot().loadingMembers).toBe(true);
    await controller.selectProject('B'); const nextSnapshot = controller.getSnapshot();
    confirmation.resolve([member('A')]); await pendingWrite;
    expect(controller.getSnapshot()).toBe(nextSnapshot);
  });
  it.each(['different', 'same'])('%s-token login resets state immediately and ignores late membership/write results', async (kind) => {
    const { controller, api } = setup(); await controller.start(); await controller.selectProject('A');
    const write = deferred<{ changed: boolean }>(); api.putProjectMember.mockImplementationOnce(() => write.promise);
    const pending = controller.changeMembership('viewer', true);
    const directory = deferred<typeof users>(); api.getUsers.mockImplementationOnce(() => directory.promise);
    ApiClient.setToken(kind === 'same' ? 'synthetic-session' : 'new-synthetic-session');
    expect(controller.getSnapshot()).toMatchObject({ members: [], projectId: '', ready: false, saving: false });
    write.resolve({ changed: true }); await pending;
    expect(api.getProjectMembers).toHaveBeenCalledOnce();
    directory.resolve(users); await Promise.resolve(); await Promise.resolve();
    expect(controller.getSnapshot().members).toEqual([]);
  });
  it('old-token read, even a late 401, cannot invalidate the new session or directory', async () => {
    const a = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/projects') return response(200, [{ id: 'A', name: 'Alpha' }]);
      if (url === '/api/auth/users') return response(200, users);
      return a.promise;
    }); vi.stubGlobal('fetch', fetchMock);
    const controller = new ProjectMembershipController('admin'); controllers.push(controller); await controller.start();
    const pending = controller.selectProject('A'); ApiClient.setToken('new-synthetic-session');
    a.resolve(response(401, { code: 'SESSION_INVALID', error: 'old' })); await pending;
    expect(ApiClient.getToken()).toBe('new-synthetic-session');
    expect(controller.getSnapshot()).toMatchObject({ projectId: '', members: [], error: '' });
  });
  it('token replacement drops late successful reads; logout clears all actions without new fetches', async () => {
    const { controller, api } = setup(); await controller.start();
    const read = deferred<ProjectMember[]>(); api.getProjectMembers.mockImplementationOnce(() => read.promise);
    const pending = controller.selectProject('A'); ApiClient.setToken('replacement');
    read.resolve([member('A')]); await pending;
    expect(controller.getSnapshot()).toMatchObject({ members: [], projectId: '', ready: false });
    const calls = api.getUsers.mock.calls.length; ApiClient.setToken(null);
    await controller.changeMembership('viewer', true);
    expect(controller.getSnapshot()).toMatchObject({ users: [], projects: [], members: [], ready: false });
    expect(api.getUsers).toHaveBeenCalledTimes(calls); expect(api.putProjectMember).not.toHaveBeenCalled();
  });
  it('role downgrade resets state and ignores pending results and handlers', async () => {
    const { controller, api } = setup(); await controller.start();
    const read = deferred<ProjectMember[]>(); api.getProjectMembers.mockImplementationOnce(() => read.promise);
    const pending = controller.selectProject('A'); controller.setRole('viewer');
    read.resolve([member('A')]); await pending; await controller.changeMembership('viewer', true);
    expect(controller.getSnapshot()).toMatchObject({ projects: [], members: [], ready: false });
    expect(api.putProjectMember).not.toHaveBeenCalled();
  });
  it('role change and unmount each invalidate late writes, with no confirmation fetch', async () => {
    for (const action of ['role', 'unmount']) {
      const { controller, api } = setup(); await controller.start(); await controller.selectProject('A');
      const write = deferred<{ changed: boolean }>(); api.putProjectMember.mockImplementationOnce(() => write.promise);
      const pending = controller.changeMembership('viewer', true);
      if (action === 'role') controller.setRole('accountant'); else controller.dispose();
      const snapshot = controller.getSnapshot(); write.resolve({ changed: true }); await pending;
      expect(controller.getSnapshot()).toBe(snapshot); expect(api.getProjectMembers).toHaveBeenCalledOnce();
    }
  });
  it('unmount invalidates pending directory and member reads', async () => {
    const { controller, api } = setup(); const directory = deferred<typeof users>(); api.getUsers.mockImplementationOnce(() => directory.promise);
    const pending = controller.start(); controller.dispose(); const snapshot = controller.getSnapshot(); directory.resolve(users); await pending;
    expect(controller.getSnapshot()).toBe(snapshot);
    const next = setup(); await next.controller.start(); const read = deferred<ProjectMember[]>(); next.api.getProjectMembers.mockImplementationOnce(() => read.promise);
    const pendingRead = next.controller.selectProject('A'); next.controller.dispose(); const nextSnapshot = next.controller.getSnapshot(); read.resolve([member('A')]); await pendingRead;
    expect(next.controller.getSnapshot()).toBe(nextSnapshot);
  });
  it('directory errors are visible and a retry can load successfully', async () => {
    const { controller, api } = setup(); api.getUsers.mockRejectedValueOnce(new Error('private'));
    await controller.start(); expect(controller.getSnapshot()).toMatchObject({ loading: false, users: [], projects: [] });
    expect(controller.getSnapshot().error).toMatch(/yeniden/); await controller.load();
    expect(controller.getSnapshot().projects).toHaveLength(2); expect(controller.getSnapshot().error).toBe('');
  });
});

describe('role-aware user management SSR and fetch policy', () => {
  const render = (role: string, subView: 'list' | 'new' | 'pin') => renderToString(React.createElement(UserManagementView, { currentUser: { id: 'actor', role }, subView, onRefreshAuth: async () => {} }));
  it.each(['manager', 'accountant', 'auditor', 'viewer'])('%s list/new has no admin forms, table, panel or fetch policy', (role) => {
    const getUsers = vi.spyOn(ApiClient, 'getUsers');
    for (const subView of ['list', 'new'] as const) {
      const html = render(role, subView); expect(html).toContain('role="alert"'); expect(html).not.toContain('<form'); expect(html).not.toContain('<table'); expect(html).not.toContain('Proje / Şantiye Üyelikleri');
      expect(canListManagedUsers(role, subView)).toBe(false);
    }
    expect(getUsers).not.toHaveBeenCalled();
    expect(renderToString(React.createElement(ProjectMembershipPanel, { currentUser: { id: 'actor', role } }))).toBe('');
  });
  it.each(['admin', 'manager', 'accountant', 'auditor', 'viewer'])('%s own PIN is accessible and never requests the admin directory', (role) => {
    const getUsers = vi.spyOn(ApiClient, 'getUsers'); const html = render(role, 'pin');
    expect(html).toContain('for="personal-pin"'); expect(html).toContain('id="personal-pin"'); expect(html).toContain('type="password"'); expect(html).toContain('Yalnızca kendi hesabınız');
    expect(html).not.toContain('<select'); expect(html).not.toContain('<table'); expect(html).not.toContain('Proje / Şantiye Üyelikleri');
    expect(canListManagedUsers(role, 'pin')).toBe(false); expect(getUsers).not.toHaveBeenCalled();
  });
  it('admin create has all server roles, including auditor, but no membership grant controls', () => {
    const html = render('admin', 'new');
    for (const role of ['admin', 'manager', 'accountant', 'auditor', 'viewer']) expect(html).toContain(`value="${role}"`);
    expect(html).toContain('<form'); expect(html).not.toContain('Projeye ekle'); expect(canListManagedUsers('admin', 'new')).toBe(false);
  });
  it('mounts the self-contained, labelled panel only in admin list and explains global access', () => {
    const html = render('admin', 'list');
    expect(html).toContain('Proje / Şantiye Üyelikleri'); expect(html).toContain('aria-labelledby=');
    expect(html).toContain('global erişir'); expect(html).toContain('otomatik proje ataması yapmaz');
    expect(html).toContain('Projeleri ve kullanıcıları yeniden yükle'); expect(canListManagedUsers('admin', 'list')).toBe(true);
  });
});
