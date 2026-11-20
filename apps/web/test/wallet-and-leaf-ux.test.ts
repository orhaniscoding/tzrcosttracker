import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ApiClient, ApiError } from '../src/api/client.js';
import { AccountManagementController, ScopedAccountLoader, FormRequestGuard, accountNumericInput, accountPayload, defaultAccountProject, validateFormAccount } from '../src/account-management.js';
import { ProjectScopeController, canRenderScopedView } from '../src/project-scope.js';
import { TrashController } from '../src/trash-management.js';
import { canMutateAccounts, canMutateTransactions, canManageCategories, canMutateTrash, canReassignAccountProject } from '../src/view-access.js';
import { LiquidityHubView, AccountTypeOptions } from '../src/components/LiquidityHubView.js';
import { TrashView } from '../src/components/TrashView.js';
import { QuickTransactionTable } from '../src/components/QuickTransactionTable.js';
import { KasaTable } from '../src/components/KasaTable.js';
import { CategoriesView } from '../src/components/CategoriesView.js';
import { CategoryManagerModal } from '../src/components/CategoryManagerModal.js';
import { NewTransactionView } from '../src/components/NewTransactionView.js';
import { NewTransactionModal } from '../src/components/NewTransactionModal.js';
import { EditTransactionModal } from '../src/components/EditTransactionModal.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const projects = [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }];
const account = (id = 'wallet') => ({ id, projectId: 'A', name: id, type: 'bank', balance: 100, currency: 'TRY', creditLimit: 0, isActive: true });
const summary = { totalBankBase: 100, totalCashBase: 0, totalCreditCardDebtBase: 0, netLiquidityAfterCC: 100 };
const transaction = { id: 'tx', projectId: 'A', title: 'Synthetic', date: '2026-01-01T00:00:00Z', categoryId: 'cat', amount: 10, baseAmount: 10, currency: 'TRY', isPaid: false, type: 'expense', paymentSource: 'company_account' } as any;
const categories = [{ id: 'cat', name: 'Synthetic category', color: '#123456' }] as any;
const cleanup: Array<() => void> = [];
beforeEach(() => { ApiClient.setToken('synthetic'); });
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); ApiClient.setToken(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function wallet(role = 'admin', selectedProjectId: string | null = 'A') {
  const list = vi.spyOn(ApiClient, 'getAccounts').mockResolvedValue([account()]);
  const totals = vi.spyOn(ApiClient, 'getLiquiditySummary').mockResolvedValue(summary);
  const create = vi.spyOn(ApiClient, 'createAccount').mockResolvedValue(account());
  const update = vi.spyOn(ApiClient, 'updateAccount').mockResolvedValue(account());
  const remove = vi.spyOn(ApiClient, 'deleteAccount').mockResolvedValue({});
  const transfer = vi.spyOn(ApiClient, 'transferFunds').mockResolvedValue({});
  const onDataChanged = vi.fn(async () => {});
  const controller = new AccountManagementController(); cleanup.push(controller.connect());
  controller.configure({ role, projects, selectedProjectId, onDataChanged });
  return { controller, list, totals, create, update, remove, transfer, onDataChanged };
}
function trash(role = 'admin') {
  const list = vi.spyOn(ApiClient, 'getTrash').mockResolvedValue([transaction]);
  const restore = vi.spyOn(ApiClient, 'restoreTransaction').mockResolvedValue(transaction);
  const remove = vi.spyOn(ApiClient, 'permanentDeleteTransaction').mockResolvedValue({});
  const onRestored = vi.fn(async () => {});
  const controller = new TrashController(); cleanup.push(controller.connect());
  controller.configure({ role, selectedProjectId: 'A', onRestored });
  return { controller, list, restore, remove, onRestored };
}
async function parentScope() {
  vi.spyOn(ApiClient, 'getProjects').mockImplementation(async () => projects.map(p => ({ ...p })));
  vi.spyOn(ApiClient, 'getCategories').mockResolvedValue([]);
  const transactions = vi.spyOn(ApiClient, 'getTransactions').mockResolvedValue([]);
  vi.spyOn(ApiClient, 'getBalance').mockResolvedValue({});
  const scope = new ProjectScopeController(); cleanup.push(scope.connect());
  scope.setActor({ id: 'synthetic-user', role: 'manager' }); await scope.selectProject('A');
  return { scope, transactions };
}
// Model the actual App gate/key and wallet effect dependency without installing
// a DOM renderer. Both the gate helper and controllers are used by the real UI.
function watchMountedScope(scope: ProjectScopeController, view: 'accounts_hub' | 'trash_list', dispose: () => void) {
  const key = scope.getSnapshot().scopeKey;
  const membership = JSON.stringify(scope.getSnapshot().projects.map(p => p.id).sort());
  const unmount = vi.fn(dispose);
  cleanup.push(scope.subscribe(() => {
    const state = scope.getSnapshot();
    if (state.scopeKey !== key || !canRenderScopedView('manager', view, state) ||
      (view === 'accounts_hub' && JSON.stringify(state.projects.map(p => p.id).sort()) !== membership)) unmount();
  }));
  return { key, unmount };
}
describe('encoded client URLs and compatibility', () => {
  it('encodes raw scoped queries once and omits aggregate queries', async () => {
    const request = vi.spyOn(ApiClient, 'request').mockResolvedValue({});
    const id = 'p /é?&#%';
    await ApiClient.getAccounts(id); await ApiClient.getLiquiditySummary(id); await ApiClient.getTrash(id);
    await ApiClient.getAccounts(null); await ApiClient.getLiquiditySummary(''); await ApiClient.getTrash();
    await ApiClient.getBalance(id); await ApiClient.getBalance('plain /&?');
    expect(request.mock.calls.map(c => c[0])).toEqual([
      `/accounts?projectId=${encodeURIComponent(id)}`, `/accounts/liquidity/summary?projectId=${encodeURIComponent(id)}`, `/transactions/trash?projectId=${encodeURIComponent(id)}`,
      '/accounts', '/accounts/liquidity/summary', '/transactions/trash', `/reports/balance?projectId=${encodeURIComponent(id)}`, '/reports/balance?projectId=plain%20%2F%26%3F',
    ]);
  });
  it.each(['site A', 'site%20A', 'site%2520A', '%'])('balance raw ID %s survives one URL query decode', async id => {
    const request = vi.spyOn(ApiClient, 'request').mockResolvedValue({});
    await ApiClient.getBalance(id);
    const endpoint = request.mock.calls[0][0];
    expect(endpoint).toBe(`/reports/balance?projectId=${encodeURIComponent(id)}`);
    expect(new URL(endpoint, 'https://synthetic.invalid').searchParams.get('projectId')).toBe(id);
  });
  it('encodes account detail IDs and treats missing balance scope as aggregate', async () => {
    const request = vi.spyOn(ApiClient, 'request').mockResolvedValue({});
    await ApiClient.getAccount('wallet /%?'); await ApiClient.getBalance(); await ApiClient.getBalance(null); await ApiClient.getBalance('');
    expect(request.mock.calls.map(c => c[0])).toEqual(['/accounts/wallet%20%2F%25%3F', '/reports/balance', '/reports/balance', '/reports/balance']);
    expect(request.mock.calls[0][1]).toBeUndefined();
  });
  it('encodes every mutation path ID without changing verbs or bodyless semantics', async () => {
    const request = vi.spyOn(ApiClient, 'request').mockResolvedValue({});
    const id = 'id /?#%', enc = encodeURIComponent(id);
    await ApiClient.updateAccount(id, { name: 'n' }); await ApiClient.deleteAccount(id);
    await ApiClient.updateCategory(id, {}); await ApiClient.deleteCategory(id);
    await ApiClient.updateTransaction(id, {}); await ApiClient.deleteTransaction(id, true);
    await ApiClient.restoreTransaction(id); await ApiClient.permanentDeleteTransaction(id); await ApiClient.markTransactionPaid(id); await ApiClient.deleteParty(id);
    expect(request.mock.calls.map(c => c[0])).toEqual([`/accounts/${enc}`, `/accounts/${enc}`, `/categories/${enc}`, `/categories/${enc}`, `/transactions/${enc}`, `/transactions/${enc}?permanent=true`, `/transactions/${enc}/restore`, `/transactions/${enc}/permanent`, `/transactions/${enc}/mark-paid`, `/parties/${enc}`]);
    expect(request.mock.calls.map(c => c[1]?.method)).toEqual(['PUT', 'DELETE', 'PUT', 'DELETE', 'PUT', 'DELETE', 'POST', 'DELETE', 'POST', 'DELETE']);
    expect(request.mock.calls[6][1]?.body).toBeUndefined();
  });
});
describe('account controller used by LiquidityHubView', () => {
  it('scopes both reads and clears A immediately before B, ignoring late A', async () => {
    const { controller, list, totals } = wallet();
    const old = deferred<any[]>(); list.mockReturnValueOnce(old.promise);
    const a = controller.reload();
    controller.configure({ role: 'admin', projects, selectedProjectId: 'B' });
    expect(controller.getSnapshot()).toMatchObject({ accounts: [], summary: null });
    list.mockResolvedValueOnce([account('B')]); await controller.reload(); old.resolve([account('A')]); await a;
    expect(controller.getSnapshot().accounts[0].id).toBe('B');
    expect(list).toHaveBeenLastCalledWith('B'); expect(totals).toHaveBeenLastCalledWith('B');
  });
  it('latest request wins within one scope', async () => {
    const { controller, list } = wallet(); const old = deferred<any[]>(); list.mockReturnValueOnce(old.promise);
    const first = controller.reload(); await controller.reload(); old.resolve([account('old')]); await first;
    expect(controller.getSnapshot().accounts[0].id).toBe('wallet');
  });
  it('malformed partial summary is an error, never NaN/zero money', async () => {
    const { controller, totals } = wallet(); totals.mockResolvedValueOnce({ totalBankBase: 100 });
    expect(await controller.reload()).toBe(false); expect(controller.getSnapshot().summary).toBeNull(); expect(controller.getSnapshot().error).toBeTruthy();
  });
  it.each(['auth', 'dispose'])('late wallet read after %s cannot expose accounts or summary', async reason => {
    const { controller, list } = wallet(); const delayed = deferred<any[]>(); list.mockReturnValueOnce(delayed.promise);
    const pending = controller.reload(); if (reason === 'auth') ApiClient.setToken('synthetic'); else controller.dispose();
    const snapshot = controller.getSnapshot(); delayed.resolve([account('old')]); await pending;
    expect(controller.getSnapshot()).toBe(snapshot); expect(controller.getSnapshot().accounts).toEqual([]); expect(controller.getSnapshot().summary).toBeNull();
  });
  it.each(['accounts', 'summary'])('partial %s failure never becomes empty or zero balances; retry works', async source => {
    const { controller, list, totals } = wallet();
    (source === 'accounts' ? list : totals).mockRejectedValueOnce(new Error('private transport details'));
    expect(await controller.reload()).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ accounts: [], summary: null, loading: false });
    expect(controller.getSnapshot().error).toBeTruthy(); expect(controller.getSnapshot().error).not.toContain('private');
    expect(await controller.reload()).toBe(true);
  });
  it('whitelists PUT, omits unchanged currency/opening/project and never submits DTO-only fields', async () => {
    const { controller, update } = wallet(); await controller.reload();
    await controller.update('wallet', { ...account(), initialBalance: 100, name: 'Renamed', createdAt: 'bad', updatedAt: 'bad', isActive: false });
    expect(update).toHaveBeenCalledWith('wallet', { name: 'Renamed', type: 'bank', creditLimit: 0 });
  });
  it('non-admin omits reassignment even when passed malicious draft project', async () => {
    const { controller, update } = wallet('manager'); await controller.reload();
    await controller.update('wallet', { name: 'n', projectId: 'B' });
    expect(update).toHaveBeenCalledWith('wallet', { name: 'n' });
  });
  it('admin sends changed project, currency and opening only when intentional', () => {
    expect(accountPayload({ projectId: null, currency: 'USD', initialBalance: 200, balance: 999 }, 'admin', account())).toEqual({ projectId: null, currency: 'USD', initialBalance: 200 });
  });
  it('clears populated nullable days via empty numeric inputs and sends explicit nulls in the real PUT body', async () => {
    const send = ApiClient.updateAccount;
    const { controller, list, update } = wallet();
    list.mockResolvedValue([{ ...account(), statementClosingDay: 15, paymentDueDay: 25 }]);
    await controller.reload();
    update.mockImplementation(send);
    const request = vi.spyOn(ApiClient, 'request').mockResolvedValue({});
    const draft = { statementClosingDay: accountNumericInput('statementClosingDay', ''), paymentDueDay: accountNumericInput('paymentDueDay', '') };
    expect(draft).toEqual({ statementClosingDay: null, paymentDueDay: null });
    expect(await controller.update('wallet', draft)).toBe(true);
    expect(request).toHaveBeenCalledWith('/accounts/wallet', { method: 'PUT', body: JSON.stringify({ statementClosingDay: null, paymentDueDay: null }) });
    expect(accountPayload(draft, 'admin', { statementClosingDay: null, paymentDueDay: undefined })).toEqual({});
    expect(accountPayload({ statementClosingDay: 15, paymentDueDay: 25 }, 'admin', { statementClosingDay: 15, paymentDueDay: 25 })).toEqual({});
    expect(accountNumericInput('initialBalance', '')).toBeUndefined(); expect(accountNumericInput('creditLimit', '')).toBeUndefined();
    expect(accountNumericInput('statementClosingDay', '15')).toBe(15);
  });
  it('other is a selectable account type in the actual options component and is preserved in create/update payloads', async () => {
    const html = renderToString(React.createElement('select', { defaultValue: 'other' }, React.createElement(AccountTypeOptions)));
    expect(html).toMatch(/<option value="other" selected="">Diğer<\/option>/);
    const { controller, create, update } = wallet(); await controller.reload();
    await controller.create({ name: 'Other', type: 'other' });
    expect(create).toHaveBeenLastCalledWith({ name: 'Other', type: 'other', projectId: 'A' });
    await controller.update('wallet', { type: 'other' }); expect(update).toHaveBeenLastCalledWith('wallet', { type: 'other' });
  });
  it.each(['manager', 'accountant'])('%s creation defaults to accessible selected or first project and refuses null/unknown', async role => {
    const { controller, create } = wallet(role, null);
    expect(await controller.create({ name: 'new', projectId: null })).toBe(false);
    expect(await controller.create({ name: 'new', projectId: 'outside' })).toBe(false); expect(create).not.toHaveBeenCalled();
    await controller.create({ name: 'new' }); expect(create).toHaveBeenLastCalledWith({ name: 'new', projectId: 'A' });
    expect(defaultAccountProject({ role, projects, selectedProjectId: 'B' })).toBe('B');
  });
  it('admin aggregate defaults null and project view defaults selected', async () => {
    const { controller, create } = wallet('admin', null); await controller.create({ name: 'global' });
    expect(create).toHaveBeenLastCalledWith({ name: 'global', projectId: null });
    expect(defaultAccountProject({ role: 'admin', projects, selectedProjectId: 'B' })).toBe('B');
  });
  it('manager with no memberships cannot create; admin can explicitly choose global from project view', async () => {
    const { controller, create } = wallet('manager'); controller.configure({ role: 'manager', projects: [], selectedProjectId: null });
    expect(await controller.create({ name: 'forbidden' })).toBe(false); expect(create).not.toHaveBeenCalled();
    controller.configure({ role: 'admin', projects, selectedProjectId: 'A' }); await controller.create({ name: 'global', projectId: null });
    expect(create).toHaveBeenLastCalledWith({ name: 'global', projectId: null });
  });
  it('successful wallet mutation remains success if local refresh fails', async () => {
    const { controller, list, onDataChanged } = wallet(); list.mockRejectedValueOnce(new Error('offline'));
    expect(await controller.create({ name: 'created' })).toBe(true); expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().notice).toMatch(/tamamlandı.*yenilenemedi/); expect(controller.getSnapshot().summary).toBeNull();
  });
  it.each([401, 403, 404, 409])('surfaces safe server %s and leaves failed mutation retryable', async status => {
    const { controller, update } = wallet(); await controller.reload(); update.mockRejectedValueOnce(new ApiError('Mali geçmiş kısıtı', status));
    expect(await controller.update('wallet', { name: 'n' })).toBe(false);
    expect(controller.getSnapshot().error).toContain(String(status)); expect(controller.getSnapshot().error).toContain('Mali geçmiş');
    expect(controller.getSnapshot().pending).toBe(false);
  });
  it.each(['scope', 'role', 'same-token-generation', 'token', 'dispose'])('late mutation after %s never notifies, refreshes or writes state', async reason => {
    const { controller, create, list, onDataChanged } = wallet(); const pending = deferred<any>(); create.mockReturnValueOnce(pending.promise);
    const action = controller.create({ name: 'new' });
    if (reason === 'scope') controller.configure({ role: 'admin', projects, selectedProjectId: 'B', onDataChanged });
    if (reason === 'role') controller.configure({ role: 'viewer', projects, selectedProjectId: 'A', onDataChanged });
    if (reason === 'same-token-generation') ApiClient.setToken('synthetic');
    if (reason === 'token') ApiClient.setToken('different-synthetic');
    if (reason === 'dispose') controller.dispose();
    const snapshot = controller.getSnapshot(); pending.resolve({}); await action;
    expect(controller.getSnapshot()).toBe(snapshot); expect(list).not.toHaveBeenCalled(); expect(onDataChanged).not.toHaveBeenCalled();
  });
  it.each(['update', 'delete', 'transfer'])('late %s uses the same session guard as create', async action => {
    const { controller, list, update, remove, transfer, onDataChanged } = wallet(); list.mockResolvedValueOnce([account(), account('other')]); await controller.reload();
    const delayed = deferred<any>();
    if (action === 'update') update.mockReturnValueOnce(delayed.promise);
    if (action === 'delete') remove.mockReturnValueOnce(delayed.promise);
    if (action === 'transfer') transfer.mockReturnValueOnce(delayed.promise);
    const pending = action === 'update' ? controller.update('wallet', { name: 'n' }) : action === 'delete' ? controller.delete('wallet') : controller.transfer({ fromAccountId: 'wallet', toAccountId: 'other', amount: 1 });
    ApiClient.setToken('synthetic'); const snapshot = controller.getSnapshot(); delayed.resolve({}); await pending;
    expect(controller.getSnapshot()).toBe(snapshot); expect(list).toHaveBeenCalledTimes(1); expect(onDataChanged).not.toHaveBeenCalled();
  });
  it.each(['viewer', 'auditor', 'unknown'])('%s reads safely but cannot create/edit/delete/transfer', async role => {
    const { controller, create, update, remove, transfer } = wallet(role); await controller.reload();
    await controller.create({ name: 'n' }); await controller.update('wallet', { name: 'n' }); await controller.delete('wallet'); await controller.transfer({ fromAccountId: 'wallet', toAccountId: 'other' });
    for (const spy of [create, update, remove, transfer]) expect(spy).not.toHaveBeenCalled();
  });
});
describe('trash controller used by TrashView', () => {
  it('A to B and latest-request guards prevent stale records and failures', async () => {
    const { controller, list } = trash(); const old = deferred<any[]>(); list.mockReturnValueOnce(old.promise);
    const a = controller.reload(); controller.configure({ role: 'manager', selectedProjectId: 'B' });
    expect(controller.getSnapshot().items).toEqual([]); await controller.reload(); old.reject(new Error('old')); await a;
    expect(list).toHaveBeenLastCalledWith('B'); expect(controller.getSnapshot()).toMatchObject({ ready: true, error: '', items: [transaction] });
  });
  it('read error differs from empty, retry produces real empty state', async () => {
    const { controller, list } = trash(); list.mockRejectedValueOnce(new Error('private'));
    await controller.reload(); expect(controller.getSnapshot()).toMatchObject({ ready: false, items: [] }); expect(controller.getSnapshot().error).toBeTruthy();
    list.mockResolvedValueOnce([]); await controller.reload(); expect(controller.getSnapshot()).toMatchObject({ ready: true, error: '', items: [] });
  });
  it('same-scope latest trash request wins', async () => {
    const { controller, list } = trash(); const delayed = deferred<any[]>(); list.mockReturnValueOnce(delayed.promise);
    const first = controller.reload(); list.mockResolvedValueOnce([]); await controller.reload(); delayed.resolve([transaction]); await first;
    expect(controller.getSnapshot()).toMatchObject({ items: [], ready: true });
  });
  it('failed restore releases lock, surfaces safe error and never notifies parent', async () => {
    const { controller, restore, onRestored } = trash(); await controller.reload(); restore.mockRejectedValueOnce(new ApiError('Yasak.', 403));
    expect(await controller.restore('tx')).toBe(false); expect(onRestored).not.toHaveBeenCalled(); expect(controller.getSnapshot().pending).toEqual([]); expect(controller.getSnapshot().error).toContain('403');
  });
  it('permanent delete refreshes without claiming restoration or notifying parent', async () => {
    const { controller, remove, onRestored } = trash(); await controller.reload();
    expect(await controller.permanentDelete('tx')).toBe(true); expect(remove).toHaveBeenCalledWith('tx'); expect(onRestored).not.toHaveBeenCalled(); expect(controller.getSnapshot().notice).toMatch(/kalıcı/);
  });
  it('restore success + refresh failure still notifies once and displays partial warning', async () => {
    const { controller, list, onRestored } = trash(); await controller.reload(); list.mockRejectedValueOnce(new Error('offline'));
    expect(await controller.restore('tx')).toBe(true); expect(onRestored).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().notice).toMatch(/tamamlandı.*yenilenemedi/); expect(controller.getSnapshot().error).toBeTruthy();
  });
  it('per-item pending synchronously blocks restore/delete double clicks', async () => {
    const { controller, restore, remove } = trash(); await controller.reload(); const delayed = deferred<any>(); restore.mockReturnValueOnce(delayed.promise);
    const first = controller.restore('tx'); await controller.restore('tx'); await controller.permanentDelete('tx');
    expect(restore).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled(); expect(controller.getSnapshot().pending).toEqual(['tx']);
    delayed.resolve({}); await first; expect(controller.getSnapshot().pending).toEqual([]);
  });
  it.each(['scope', 'role', 'same-token-generation', 'token', 'dispose'])('late restore after %s cannot notify/refresh/write state', async reason => {
    const { controller, list, restore, onRestored } = trash(); await controller.reload(); const delayed = deferred<any>(); restore.mockReturnValueOnce(delayed.promise);
    const pending = controller.restore('tx');
    if (reason === 'scope') controller.configure({ role: 'admin', selectedProjectId: 'B', onRestored });
    if (reason === 'role') controller.configure({ role: 'viewer', selectedProjectId: 'A', onRestored });
    if (reason === 'same-token-generation') ApiClient.setToken('synthetic');
    if (reason === 'token') ApiClient.setToken('different-synthetic');
    if (reason === 'dispose') controller.dispose();
    const snapshot = controller.getSnapshot(); delayed.resolve({}); await pending;
    expect(controller.getSnapshot()).toBe(snapshot); expect(onRestored).not.toHaveBeenCalled(); expect(list).toHaveBeenCalledTimes(1);
  });
  it.each(['viewer', 'auditor', 'unknown'])('%s cannot restore or permanently delete', async role => {
    const { controller, restore, remove } = trash(role); await controller.reload(); await controller.restore('tx'); await controller.permanentDelete('tx');
    expect(restore).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
});
describe('actual parent scope refresh interaction with mounted mutation controllers', () => {
  it.each(['accounts_hub', 'trash_list'] as const)('%s still refreshes locally and preserves a warning when the parent callback rejects', async view => {
    const notify = vi.fn(async () => { throw new Error('parent refresh offline'); });
    if (view === 'accounts_hub') {
      const { controller, list } = wallet('manager');
      controller.configure({ role: 'manager', projects, selectedProjectId: 'A', onDataChanged: notify });
      expect(await controller.create({ name: 'Created' })).toBe(true);
      expect(list).toHaveBeenCalledTimes(1); expect(controller.getSnapshot().summary).toEqual(summary);
      expect(controller.getSnapshot().notice).toMatch(/tamamlandı.*yenilenemedi/);
    } else {
      const { controller, list } = trash('manager');
      controller.configure({ role: 'manager', selectedProjectId: 'A', onRestored: notify }); await controller.reload();
      expect(await controller.restore('tx')).toBe(true);
      expect(list).toHaveBeenCalledTimes(2); expect(controller.getSnapshot().ready).toBe(true);
      expect(controller.getSnapshot().notice).toMatch(/tamamlandı.*yenilenemedi/);
    }
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it.each(['accounts_hub', 'trash_list'] as const)('%s stays in the same keyed scope and retains a partial local-refresh warning', async view => {
    const { scope } = await parentScope();
    const notify = vi.fn(scope.reload);
    if (view === 'accounts_hub') {
      const { controller, list } = wallet('manager');
      controller.configure({ role: 'manager', projects: scope.getSnapshot().projects, selectedProjectId: 'A', onDataChanged: notify });
      await controller.reload();
      const mounted = watchMountedScope(scope, view, () => controller.dispose());
      list.mockRejectedValueOnce(new Error('local refresh offline'));
      expect(await controller.create({ name: 'Created' })).toBe(true);
      expect(mounted.unmount).not.toHaveBeenCalled(); expect(scope.getSnapshot().scopeKey).toBe(mounted.key);
      expect(controller.getSnapshot()).toMatchObject({ pending: false, summary: null });
      expect(controller.getSnapshot().notice).toMatch(/tamamlandı.*yenilenemedi/);
      expect(controller.getSnapshot().error).toBeTruthy();
    } else {
      const { controller, list } = trash('manager');
      controller.configure({ role: 'manager', selectedProjectId: 'A', onRestored: notify }); await controller.reload();
      const mounted = watchMountedScope(scope, view, () => controller.dispose());
      list.mockRejectedValueOnce(new Error('local refresh offline'));
      expect(await controller.restore('tx')).toBe(true);
      expect(mounted.unmount).not.toHaveBeenCalled(); expect(scope.getSnapshot().scopeKey).toBe(mounted.key);
      expect(controller.getSnapshot()).toMatchObject({ pending: [], ready: false });
      expect(controller.getSnapshot().notice).toMatch(/tamamlandı.*yenilenemedi/);
      expect(controller.getSnapshot().error).toBeTruthy();
    }
    expect(notify).toHaveBeenCalledTimes(1); expect(scope.getSnapshot().ready).toBe(true);
  });
  it('two distinct restores survive the first parent reload and refresh parent transactions again after the later restore', async () => {
    const { scope, transactions } = await parentScope();
    const { controller, list, restore } = trash('manager');
    const rows = [{ ...transaction, id: 'tx1' }, { ...transaction, id: 'tx2' }];
    const restored: any[] = [];
    list.mockImplementation(async () => rows.filter(row => !restored.some(tx => tx.id === row.id)));
    transactions.mockImplementation(async () => [...restored]);
    const notify = vi.fn(scope.reload);
    controller.configure({ role: 'manager', selectedProjectId: 'A', onRestored: notify }); await controller.reload();
    const mounted = watchMountedScope(scope, 'trash_list', () => controller.dispose());
    const tx1 = deferred<any>(), tx2 = deferred<any>();
    restore.mockImplementation(id => (id === 'tx1' ? tx1 : tx2).promise.then(() => { const row = rows.find(tx => tx.id === id)!; restored.push(row); return row; }));
    const first = controller.restore('tx1'), second = controller.restore('tx2');
    expect(controller.getSnapshot().pending).toEqual(['tx1', 'tx2']);
    tx1.resolve({}); expect(await first).toBe(true);
    expect(scope.getSnapshot()).toMatchObject({ ready: true, scopeKey: mounted.key, transactions: [rows[0]] });
    expect(notify).toHaveBeenCalledTimes(1);
    // tx1's local reload must not clear the still-pending tx2 row lock.
    expect(controller.getSnapshot().pending).toEqual(['tx2']);
    await controller.restore('tx2'); expect(restore).toHaveBeenCalledTimes(2);
    tx2.resolve({}); expect(await second).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2); expect(transactions).toHaveBeenCalledTimes(3);
    expect(scope.getSnapshot()).toMatchObject({ ready: true, scopeKey: mounted.key, transactions: rows });
    expect(mounted.unmount).not.toHaveBeenCalled(); expect(controller.getSnapshot().pending).toEqual([]);
    expect(controller.getSnapshot().items).toEqual([]);
  });
  it('keeps an authorized mounted leaf open across a deferred same-scope reload, then closes on membership change', async () => {
    const { scope, transactions } = await parentScope();
    const mounted = watchMountedScope(scope, 'trash_list', () => {});
    const pending = deferred<any[]>();
    transactions.mockReturnValueOnce(pending.promise);
    const read = scope.reload();
    expect(canRenderScopedView('manager', 'trash_list', scope.getSnapshot())).toBe(true);
    expect(scope.getSnapshot()).toMatchObject({ loading: true, ready: false, scopeAuthorized: true, scopeKey: mounted.key });
    pending.resolve([]); await read;
    expect(canRenderScopedView('manager', 'accounts_hub', scope.getSnapshot())).toBe(true);
    expect(mounted.unmount).not.toHaveBeenCalled();
    const list = deferred<any[]>();
    vi.spyOn(ApiClient, 'getProjects').mockReturnValueOnce(list.promise as any);
    // Hold the aggregate financial read open so the post-membership-change state
    // is observed instead of the fast mocked reads completing the reload first.
    const nextTx = deferred<any[]>();
    transactions.mockReturnValueOnce(nextTx.promise);
    const changed = scope.reload();
    list.resolve([{ ...projects[1] }]); for (let i = 0; i < 2; i++) await Promise.resolve();
    expect(scope.getSnapshot()).toMatchObject({ loading: true, ready: false, scopeAuthorized: false });
    expect(canRenderScopedView('manager', 'trash_list', scope.getSnapshot())).toBe(false);
    expect(mounted.unmount).toHaveBeenCalled();
    nextTx.resolve([]); await changed;
  });
});
describe('shared scoped form account loader and validation', () => {
  it.each([null, 'B'])('recovers only the verified existing wallet from project %s without broadening the scoped list', async projectId => {
    const existing = { ...account('existing'), projectId };
    const list = vi.spyOn(ApiClient, 'getAccounts').mockResolvedValue([account()]);
    const detail = vi.spyOn(ApiClient, 'getAccount').mockResolvedValue(existing);
    const loader = new ScopedAccountLoader(); cleanup.push(loader.connect()); loader.configure('A', true, 'existing');
    await loader.reload();
    expect(list).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledWith('A');
    expect(detail).toHaveBeenCalledTimes(1); expect(detail).toHaveBeenCalledWith('existing');
    expect(loader.getSnapshot().accounts).toEqual([account(), existing]);
    expect(validateFormAccount(loader.getSnapshot(), 'existing', 'TRY')).toBeNull();
  });
  it('does not fetch detail for an existing scoped choice or an empty preserved ID, and rejects inactive choices', async () => {
    vi.spyOn(ApiClient, 'getAccounts').mockResolvedValue([{ ...account(), isActive: false }]);
    const detail = vi.spyOn(ApiClient, 'getAccount');
    const loader = new ScopedAccountLoader(); cleanup.push(loader.connect()); loader.configure('A', true, 'wallet'); await loader.reload();
    expect(detail).not.toHaveBeenCalled(); expect(validateFormAccount(loader.getSnapshot(), 'wallet', 'TRY')).toMatch(/aktif değil/);
    loader.configure('A', true, ''); await loader.reload(); expect(detail).not.toHaveBeenCalled();
  });
  it.each(['404', 'inactive', 'missing'])('does not preserve a %s detail account and blocks that selection', async kind => {
    vi.spyOn(ApiClient, 'getAccounts').mockResolvedValue([account()]);
    const detail = vi.spyOn(ApiClient, 'getAccount');
    if (kind === '404') detail.mockRejectedValue(new ApiError('Bulunamadı', 404));
    else detail.mockResolvedValue(kind === 'inactive' ? { ...account('existing'), isActive: false } : null);
    const loader = new ScopedAccountLoader(); cleanup.push(loader.connect()); loader.configure('A', true, 'existing'); await loader.reload();
    expect(loader.getSnapshot()).toMatchObject({ ready: true, error: '', accounts: [account()] });
    expect(validateFormAccount(loader.getSnapshot(), 'existing', 'TRY')).toMatch(/kapsamda/);
    expect(validateFormAccount(loader.getSnapshot(), 'wallet', 'TRY')).toBeNull();
  });
  it.each([401, 403, 500, 'network'])('detail failure %s fails the entire loader visibly and is retryable', async status => {
    vi.spyOn(ApiClient, 'getAccounts').mockResolvedValue([account()]);
    const detail = vi.spyOn(ApiClient, 'getAccount').mockRejectedValueOnce(status === 'network' ? new Error('private') : new ApiError('Denied', Number(status))).mockResolvedValue(account('existing'));
    const loader = new ScopedAccountLoader(); cleanup.push(loader.connect()); loader.configure('A', true, 'existing'); await loader.reload();
    expect(loader.getSnapshot()).toMatchObject({ ready: false, loading: false, accounts: [] });
    expect(loader.getSnapshot().error).toBeTruthy(); expect(loader.getSnapshot().error).not.toContain('private');
    expect(validateFormAccount(loader.getSnapshot(), 'existing', 'TRY')).toBeTruthy();
    await loader.reload(); expect(detail).toHaveBeenCalledTimes(2); expect(validateFormAccount(loader.getSnapshot(), 'existing', 'TRY')).toBeNull();
  });
  it.each(['scope', 'preserved-id', 'auth', 'unmount'])('late account detail after %s never publishes into another form lifetime', async reason => {
    vi.spyOn(ApiClient, 'getAccounts').mockResolvedValue([account()]);
    const detail = deferred<any>(); vi.spyOn(ApiClient, 'getAccount').mockReturnValue(detail.promise);
    const loader = new ScopedAccountLoader(); const disconnect = loader.connect(); cleanup.push(disconnect);
    loader.configure('A', true, 'existing'); const pending = loader.reload(); await Promise.resolve();
    if (reason === 'scope') loader.configure('B', true, 'existing');
    if (reason === 'preserved-id') loader.configure('A', true, 'different');
    if (reason === 'auth') ApiClient.setToken('synthetic');
    if (reason === 'unmount') disconnect();
    const snapshot = loader.getSnapshot(); detail.resolve(account('existing')); await pending;
    expect(loader.getSnapshot()).toBe(snapshot);
  });
  it.each(['project', 'role', 'close', 'auth-generation', 'token', 'unmount'])('form duplicate/save/delete continuation after %s is ignored', async reason => {
    const guard = new FormRequestGuard(); guard.activate(true);
    const current = guard.capture(), duplicate = deferred<boolean>(); let warning = false; let callbacks = 0;
    const pending = duplicate.promise.then(value => { if (current()) { warning = value; callbacks++; } });
    if (reason === 'project') { guard.invalidate(); guard.activate(true); }
    if (reason === 'role' || reason === 'close' || reason === 'unmount') guard.invalidate();
    if (reason === 'auth-generation') ApiClient.setToken('synthetic');
    if (reason === 'token') ApiClient.setToken('different-synthetic');
    duplicate.resolve(true); await pending; expect(warning).toBe(false); expect(callbacks).toBe(0);
  });
  it('current form continuation remains usable and a reopened form gets a new epoch', () => {
    const guard = new FormRequestGuard(); guard.activate(true); const old = guard.capture(); expect(old()).toBe(true);
    guard.invalidate(); guard.activate(true); expect(old()).toBe(false); expect(guard.capture()()).toBe(true);
  });
  it('closed modal does not request; A to B responses cannot leak accounts', async () => {
    const list = vi.spyOn(ApiClient, 'getAccounts').mockResolvedValue([account('B')]);
    const loader = new ScopedAccountLoader(); cleanup.push(loader.connect()); loader.configure('A', false, 'existing'); await loader.reload(); expect(list).not.toHaveBeenCalled();
    const old = deferred<any[]>(); list.mockReturnValueOnce(old.promise); loader.configure('A', true); const first = loader.reload();
    loader.configure('B', true); await loader.reload(); old.resolve([account('A')]); await first;
    expect(list).toHaveBeenLastCalledWith('B'); expect(loader.getSnapshot().accounts[0].id).toBe('B');
  });
  it.each(['close', 'auth', 'unmount'])('late load after %s is ignored', async reason => {
    const delayed = deferred<any[]>(); vi.spyOn(ApiClient, 'getAccounts').mockReturnValue(delayed.promise);
    const loader = new ScopedAccountLoader(); const disconnect = loader.connect(); cleanup.push(disconnect);
    loader.configure('A', true); const pending = loader.reload();
    if (reason === 'close') loader.configure('A', false); if (reason === 'auth') ApiClient.setToken('synthetic'); if (reason === 'unmount') disconnect();
    const snapshot = loader.getSnapshot(); delayed.resolve([account()]); await pending; expect(loader.getSnapshot()).toBe(snapshot);
  });
  it('error is visible, retry works, validates membership/currency and failed company-account change', async () => {
    const list = vi.spyOn(ApiClient, 'getAccounts').mockRejectedValueOnce(new Error('offline')).mockResolvedValue([account()]);
    const loader = new ScopedAccountLoader(); cleanup.push(loader.connect()); loader.configure(null, true); await loader.reload();
    expect(validateFormAccount(loader.getSnapshot(), 'wallet', 'TRY')).toBeTruthy();
    expect(loader.getSnapshot().error).toBeTruthy(); await loader.reload(); expect(list).toHaveBeenLastCalledWith(null);
    expect(validateFormAccount(loader.getSnapshot(), 'wallet', 'TRY')).toBeNull(); expect(validateFormAccount(loader.getSnapshot(), '', 'TRY')).toBeNull();
    expect(validateFormAccount(loader.getSnapshot(), 'missing', 'TRY')).toMatch(/kapsamda/); expect(validateFormAccount(loader.getSnapshot(), 'wallet', 'USD')).toMatch(/para birimi/);
  });
});
describe('leaf permissions and SSR (visibility is not server authorization)', () => {
  it.each(['admin', 'manager', 'accountant', 'viewer', 'auditor', 'unknown'])('role policy %s is fail closed', role => {
    const writable = ['admin', 'manager', 'accountant'].includes(role);
    for (const policy of [canMutateTransactions, canMutateAccounts, canMutateTrash]) expect(policy(role)).toBe(writable);
    expect(canManageCategories(role)).toBe(role === 'admin'); expect(canReassignAccountProject(role)).toBe(role === 'admin');
  });
  it.each(['viewer', 'auditor', 'unknown'])('wallet/trash %s SSR never shows mutation controls or fake totals', role => {
    const hub = renderToString(React.createElement(LiquidityHubView, { role, projects }));
    expect(hub).not.toContain('Yeni Cüzdan / Hesap Ekle'); expect(hub).not.toContain('Virman Yap'); expect(hub).not.toContain('Hesabı Sil'); expect(hub).not.toContain('0,00');
    const bin = renderToString(React.createElement(TrashView, { role, categories, onRestored: async () => {} }));
    expect(bin).not.toContain('title="Geri Yükle"'); expect(bin).not.toContain('Kalıcı Olarak Sil'); expect(bin).not.toContain('Çöp kutusu boş.');
  });
  it.each(['admin', 'manager', 'accountant'])('wallet %s SSR exposes create/transfer only for writable roles', role => {
    const hub = renderToString(React.createElement(LiquidityHubView, { role, projects, selectedProjectId: 'B' }));
    expect(hub).toContain('Yeni Cüzdan / Hesap Ekle'); expect(hub).toContain('Virman Yap'); expect(hub).toContain('Seçili şantiye');
  });
  it.each([false, true])('transaction tables canMutate=%s', canMutate => {
    const quick = renderToString(React.createElement(QuickTransactionTable, { canMutate, transactions: [transaction], categories, onOpenNewModal: vi.fn(), onEditTransaction: vi.fn(), onDeleteTransaction: async () => {}, onMarkPaid: async () => {}, onSearch: vi.fn(), isLoading: false }));
    for (const text of ['+ Yeni Harcama Ekle', 'Kaydı Düzenle', 'Kaydı Sil', 'Ödendi Yap']) expect(quick.includes(text)).toBe(canMutate);
    const kasa = renderToString(React.createElement(KasaTable, { canMutate, transactions: [], onAddKasaEntry: vi.fn() })); expect(kasa.includes('Kasaya Nakit Ekle')).toBe(canMutate);
  });
  it.each([false, true])('category tree/form/modal canManage=%s', canManage => {
    const props = { canManage, categories, onAddCategory: async () => {}, onDeleteCategory: async () => {} };
    const tree = renderToString(React.createElement(CategoriesView, { ...props, subView: 'tree', onNavigateToTree: vi.fn() })); expect(tree.includes('Ana Kategoriyi Sil')).toBe(canManage);
    const form = renderToString(React.createElement(CategoriesView, { ...props, subView: 'new' })); expect(form.includes('<form')).toBe(canManage);
    const modal = renderToString(React.createElement(CategoryManagerModal, { ...props, isOpen: true, onClose: vi.fn() })); expect(modal.includes('<form')).toBe(canManage); expect(modal.includes('Kategoriyi Sil')).toBe(canManage);
  });
  it('omitted category and table permissions default to denied', () => {
    const props = { categories, onAddCategory: async () => {}, onDeleteCategory: async () => {} };
    expect(renderToString(React.createElement(CategoryManagerModal, { ...props, isOpen: true, onClose: vi.fn() }))).not.toContain('<form');
    expect(renderToString(React.createElement(CategoriesView, { ...props, subView: 'new' }))).not.toContain('<form');
    expect(renderToString(React.createElement(KasaTable, { transactions: [], onAddKasaEntry: vi.fn() }))).not.toContain('Kasaya Nakit Ekle');
    expect(canMutateAccounts({ toString: () => 'admin' })).toBe(false);
  });
  it('closed and forbidden transaction forms issue no SSR requests and hide forms', () => {
    const list = vi.spyOn(ApiClient, 'getAccounts');
    expect(renderToString(React.createElement(NewTransactionModal, { isOpen: false, canMutate: true, categories, selectedProjectId: 'A', onClose: vi.fn(), onAddTransaction: async () => {} }))).toBe('');
    expect(renderToString(React.createElement(NewTransactionView, { canMutate: false, categories, selectedProjectId: 'A', onNavigateBack: vi.fn(), onAddTransaction: async () => {} }))).not.toContain('<form');
    expect(renderToString(React.createElement(EditTransactionModal, { isOpen: true, canMutate: false, transaction, categories, onClose: vi.fn(), onSave: async () => {}, onDelete: async () => {} }))).toBe('');
    expect(list).not.toHaveBeenCalled();
  });
});
