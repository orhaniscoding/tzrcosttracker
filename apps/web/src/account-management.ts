import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { ApiClient, ApiError } from './api/client.js';
import { canMutateAccounts, isValidRole } from './view-access.js';

export type ProjectOption = { id: string; name: string };
export interface AccountContext { role?: string; projects: readonly ProjectOption[]; selectedProjectId?: string | null; onDataChanged?: () => void | Promise<void> }
export const accountFields = ['projectId', 'name', 'type', 'currency', 'initialBalance', 'creditLimit', 'statementClosingDay', 'paymentDueDay', 'iban', 'bankName', 'description'] as const;
export function accountNumericInput(key: string, value: string): number | null | undefined {
  return value === '' ? (key === 'statementClosingDay' || key === 'paymentDueDay' ? null : undefined) : Number(value);
}
export function safeManagementError(error: unknown): string {
  if (error instanceof ApiError && [400, 401, 403, 404, 409].includes(error.status)) return `${error.status}: ${error.message.slice(0, 400)}`;
  return 'Veriler yüklenemedi veya işlem tamamlanamadı. Lütfen yeniden deneyin.';
}
export function defaultAccountProject(context: AccountContext): string | null {
  if (context.selectedProjectId && context.projects.some(p => p.id === context.selectedProjectId)) return context.selectedProjectId;
  return context.role === 'admin' ? null : context.projects[0]?.id ?? null;
}
export function accountPayload(draft: Record<string, any>, role: unknown, previous?: Record<string, any>): Record<string, any> {
  const payload: Record<string, any> = {};
  for (const key of accountFields) {
    if (draft[key] === undefined) continue;
    if (key === 'projectId' && previous && role !== 'admin') continue;
    const old = key === 'initialBalance' ? previous?.initialBalance ?? previous?.balance : previous?.[key];
    if (previous && ['projectId', 'currency', 'initialBalance', 'statementClosingDay', 'paymentDueDay'].includes(key) && (draft[key] ?? null) === (old ?? null)) continue;
    payload[key] = draft[key];
  }
  return payload;
}

// One controller owns the actual UI requests. Scope epochs are independent of
// read sequence numbers so a refresh cannot accidentally legitimize old writes.
export class AccountManagementController {
  private context: AccountContext = { projects: [] };
  private epoch = 0; private request = 0; private alive = false;
  private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  private state = { accounts: [] as any[], summary: null as any, loading: false, pending: false, error: '', notice: '' };
  constructor(private api = ApiClient) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(update: Partial<typeof this.state>) { this.state = { ...this.state, ...update }; this.listeners.forEach(l => l()); }
  private clear() { this.epoch++; this.request++; this.set({ accounts: [], summary: null, loading: false, pending: false, error: '', notice: '' }); }
  connect = () => { this.alive = true; this.unsubscribe = this.api.subscribeAuthChange(() => { this.context = { projects: [] }; this.clear(); this.set({ error: 'Oturum değişti. Güncel kullanıcıyla yeniden açın.' }); }); return () => this.dispose(); };
  dispose() { this.alive = false; this.unsubscribe?.(); this.clear(); }
  configure(context: AccountContext) { this.context = context; this.clear(); }
  private capture() {
    const epoch = this.epoch, token = this.api.getToken(), generation = this.api.getAuthGeneration();
    return () => this.alive && epoch === this.epoch && token === this.api.getToken() && generation === this.api.getAuthGeneration();
  }
  reload = async (): Promise<boolean> => {
    if (!this.alive || !isValidRole(this.context.role)) return false;
    const current = this.capture(), request = ++this.request;
    this.set({ loading: true, accounts: [], summary: null, error: '' });
    try {
      const [accounts, summary] = await Promise.all([this.api.getAccounts(this.context.selectedProjectId), this.api.getLiquiditySummary(this.context.selectedProjectId)]);
      if (!current() || request !== this.request) return false;
      if (!Array.isArray(accounts) || !summary || typeof summary !== 'object' ||
        !['totalBankBase', 'totalCashBase', 'totalCreditCardDebtBase', 'netLiquidityAfterCC'].every(key => typeof summary[key] === 'number' && Number.isFinite(summary[key]))) throw new Error('Invalid response');
      this.set({ accounts, summary, loading: false }); return true;
    } catch (error) { if (current() && request === this.request) this.set({ loading: false, accounts: [], summary: null, error: safeManagementError(error) }); return false; }
  };
  private async mutate(action: () => Promise<unknown>): Promise<boolean> {
    if (!this.alive || !canMutateAccounts(this.context.role) || this.state.pending) return false;
    const current = this.capture(); this.set({ pending: true, error: '', notice: '' });
    try {
      await action(); if (!current()) return false;
      this.set({ notice: 'İşlem başarıyla tamamlandı.' });
      // Only this still-current session may notify; a same-scope parent refresh
      // keeps the keyed view mounted, and must precede the fallible local read.
      let parentFailed = false;
      try { await this.context.onDataChanged?.(); } catch { parentFailed = true; }
      if (!current()) return false;
      const refreshed = await this.reload();
      if (current() && (!refreshed || parentFailed)) this.set({ notice: 'İşlem tamamlandı; görünüm veya cüzdan listesi yenilenemedi. Yeniden deneyin.' });
      return current();
    } catch (error) { if (current()) this.set({ error: safeManagementError(error) }); return false; }
    finally { if (current()) this.set({ pending: false }); }
  }
  create = async (draft: Record<string, any>) => {
    if (!this.alive || !canMutateAccounts(this.context.role)) return false;
    const projectId = draft.projectId === undefined ? defaultAccountProject(this.context) : draft.projectId;
    if ((projectId === null && this.context.role !== 'admin') || (projectId !== null && !this.context.projects.some(p => p.id === projectId))) {
      this.set({ error: 'Erişilebilir bir şantiye seçmelisiniz.' }); return false;
    }
    return this.mutate(() => this.api.createAccount(accountPayload({ ...draft, projectId }, this.context.role)));
  };
  update = (id: string, draft: Record<string, any>) => {
    if (!this.alive || !canMutateAccounts(this.context.role)) return Promise.resolve(false);
    const previous = this.state.accounts.find(a => a.id === id);
    if (!previous) return Promise.resolve(false);
    if (this.context.role === 'admin' && draft.projectId != null && !this.context.projects.some(p => p.id === draft.projectId)) {
      this.set({ error: 'Erişilebilir bir şantiye seçmelisiniz.' }); return Promise.resolve(false);
    }
    return this.mutate(() => this.api.updateAccount(id, accountPayload(draft, this.context.role, previous)));
  };
  delete = (id: string) => this.state.accounts.some(a => a.id === id) ? this.mutate(() => this.api.deleteAccount(id)) : Promise.resolve(false);
  transfer = (draft: Record<string, any>) => {
    if (draft.fromAccountId === draft.toAccountId || ![draft.fromAccountId, draft.toAccountId].every(id => this.state.accounts.some(a => a.id === id))) return Promise.resolve(false);
    return this.mutate(() => this.api.transferFunds(draft));
  };
}

// Shared by all three transaction forms; no requests are issued for closed forms.
export class ScopedAccountLoader {
  private epoch = 0; private alive = false; private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  private state = { accounts: [] as any[], loading: false, error: '', ready: false };
  private projectId: string | null = null; private enabled = false; private preserveAccountId: string | null = null;
  constructor(private api = ApiClient) {}
  getSnapshot = () => this.state;
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  private set(update: Partial<typeof this.state>) { this.state = { ...this.state, ...update }; this.listeners.forEach(l => l()); }
  connect = () => { this.alive = true; this.unsubscribe = this.api.subscribeAuthChange(() => { this.epoch++; this.enabled = false; this.set({ accounts: [], ready: false, loading: false, error: 'Oturum değişti. Güncel kullanıcıyla formu yeniden açın.' }); }); return () => { this.alive = false; this.epoch++; this.unsubscribe?.(); this.set({ accounts: [], ready: false, loading: false, error: '' }); }; };
  configure(projectId: string | null, enabled: boolean, preserveAccountId?: string | null) { this.epoch++; this.projectId = projectId; this.enabled = enabled; this.preserveAccountId = preserveAccountId || null; this.set({ accounts: [], ready: false, loading: false, error: '' }); }
  reload = async () => {
    if (!this.alive || !this.enabled) return;
    const epoch = ++this.epoch, generation = this.api.getAuthGeneration(), token = this.api.getToken();
    const current = () => this.alive && epoch === this.epoch && generation === this.api.getAuthGeneration() && token === this.api.getToken();
    this.set({ accounts: [], ready: false, loading: true, error: '' });
    const preserveAccountId = this.preserveAccountId;
    try {
      let accounts = await this.api.getAccounts(this.projectId);
      if (!current()) return;
      if (!Array.isArray(accounts)) throw new Error('Invalid response');
      if (preserveAccountId && !accounts.some(a => a.id === preserveAccountId)) {
        try {
          const account = await this.api.getAccount(preserveAccountId);
          if (!current()) return;
          // The detail endpoint verifies actor scope; never fetch an aggregate
          // list to recover an existing global/cross-project selection.
          if (account && account.id === preserveAccountId && account.isActive !== false) accounts = [...accounts, account];
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
      }
      if (current()) this.set({ accounts, ready: true, loading: false });
    }
    catch (error) { if (current()) this.set({ accounts: [], ready: false, loading: false, error: safeManagementError(error) }); }
  };
}
export function validateFormAccount(state: { accounts: any[]; ready: boolean; error: string }, id: string, currency: string): string | null {
  if (!state.ready) return state.error || 'Cüzdanlar yükleniyor. Lütfen bekleyin.';
  if (!id) return null;
  const account = state.accounts.find(a => a.id === id);
  if (!account) return 'Seçili cüzdan bu kapsamda bulunamadı.';
  if (account.isActive === false) return 'Seçili cüzdan aktif değil.';
  return account.currency !== currency ? 'Cüzdan ve işlem para birimi uyuşmuyor.' : null;
}
export function useScopedAccounts(projectId: string | null | undefined, enabled: boolean, recordId?: string, preserveAccountId?: string | null) {
  const [loader] = useState(() => new ScopedAccountLoader());
  const state = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
  useLayoutEffect(loader.connect, [loader]);
  useLayoutEffect(() => { loader.configure(projectId ?? null, enabled, preserveAccountId); void loader.reload(); return () => loader.configure(null, false); }, [loader, projectId, enabled, recordId, preserveAccountId]);
  return { ...state, retry: loader.reload };
}

export class FormRequestGuard {
  private epoch = 0; private active = false;
  activate(enabled: boolean) { this.epoch++; this.active = enabled; }
  invalidate = () => { this.epoch++; this.active = false; };
  capture = () => {
    const epoch = this.epoch, auth = ApiClient.getAuthGeneration(), token = ApiClient.getToken();
    return () => this.active && epoch === this.epoch && auth === ApiClient.getAuthGeneration() && token === ApiClient.getToken();
  };
}
export function useFormLifetime(scope: string | null | undefined, enabled: boolean) {
  const generation = useSyncExternalStore(ApiClient.subscribeAuthChange.bind(ApiClient), () => ApiClient.getAuthGeneration(), () => ApiClient.getAuthGeneration());
  const [guard] = useState(() => new FormRequestGuard());
  useLayoutEffect(() => { guard.activate(enabled); return guard.invalidate; }, [guard, scope, enabled, generation]);
  return { capture: guard.capture, generation };
}
