import { ApiClient } from './api/client.js';
import type { Category, Project, Transaction } from '@cost-core/types';
import type { NavView } from './components/Sidebar.js';
import { canAccessView, isPersonalView, isValidRole } from './view-access.js';

export interface ScopeActor { id: string; role: string }
export interface ScopeState {
  projects: Project[]; selectedProjectId: string | null; categories: Category[];
  transactions: Transaction[]; balance: any; auditVerified: boolean | null;
  loading: boolean; ready: boolean; noProjects: boolean; error: string;
  /** True only after the current scopeKey was fully authorized by a successful load. */
  scopeAuthorized: boolean; scopeKey: number;
}
type ScopeApi = Pick<typeof ApiClient, 'getToken' | 'getAuthGeneration' | 'subscribeAuthChange' | 'getProjects' | 'getCategories' | 'getTransactions' | 'getBalance' | 'verifyAudit'>;
// The keyed App subtree handles identity/scope changes. Background reads must
// not dispose a still-authorized view and its in-flight mutation controllers.
// A loading state may only render scoped children once this same scope has
// already been authorized; a first, failed or switched scope stays closed until
// a load fully succeeds.
export function canRenderScopedView(role: unknown, view: NavView, scope: Pick<ScopeState, 'ready' | 'loading' | 'error' | 'noProjects' | 'scopeAuthorized'>): boolean {
  return canAccessView(role, view) && (isPersonalView(view) || (!scope.error && !scope.noProjects && (scope.ready || (scope.loading && scope.scopeAuthorized))));
}
const empty = (scopeKey: number): ScopeState => ({ projects: [], selectedProjectId: null, categories: [], transactions: [], balance: null, auditVerified: null, loading: false, ready: false, noProjects: false, error: '', scopeAuthorized: false, scopeKey });
export function scopeError(error: unknown): string {
  const status = (error as { status?: number })?.status;
  if (status === 401) return 'Oturum doğrulanamadı. Lütfen yeniden giriş yapın.';
  if (status === 403) return 'Güncel proje yetkisi doğrulanamadı. Lütfen yeniden deneyin.';
  return 'Veriler yüklenemedi. Lütfen yeniden deneyin.';
}

/** The App's sole project/load/search/audit state owner. No request can publish
 * across a newer read, identity, auth generation, lock or component lifetime. */
export class ProjectScopeController {
  private state = empty(0);
  private actor: ScopeActor | null = null;
  private locked = true;
  private alive = true;
  private epoch = 0;
  private lifetime = 0;
  private auditRequest = 0;
  private token: string | null = null;
  private authGeneration = -1;
  private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  constructor(private api: ScopeApi = ApiClient) {}
  getSnapshot = (): ScopeState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  connect() {
    this.alive = true;
    this.unsubscribe?.();
    this.unsubscribe = this.api.subscribeAuthChange(() => this.invalidate());
    return () => this.dispose();
  }
  private publish(patch: Partial<ScopeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  invalidate() {
    this.epoch++; this.lifetime++; this.auditRequest++;
    this.actor = null; this.locked = true;
    this.publish(empty(this.state.scopeKey + 1));
  }
  dispose() { this.invalidate(); this.alive = false; this.unsubscribe?.(); this.unsubscribe = undefined; }
  setActor(actor: ScopeActor, locked = false) {
    if (!this.actor || this.actor.id !== actor.id || this.actor.role !== actor.role || this.token !== this.api.getToken() || this.authGeneration !== this.api.getAuthGeneration()) this.invalidate();
    this.actor = { id: actor.id, role: actor.role };
    this.token = this.api.getToken(); this.authGeneration = this.api.getAuthGeneration();
    this.locked = locked;
    if (locked) this.lock();
  }
  lock() {
    this.locked = true; this.epoch++; this.lifetime++; this.auditRequest++;
    this.publish({ ...empty(this.state.scopeKey + 1), selectedProjectId: this.state.selectedProjectId });
  }
  /** Mutation completions may refresh the CURRENT selection, not their closure's selection. */
  captureSession(): () => boolean {
    const lifetime = this.lifetime, token = this.api.getToken(), generation = this.api.getAuthGeneration();
    return () => this.alive && !this.locked && !!this.actor && lifetime === this.lifetime && token === this.api.getToken() && generation === this.api.getAuthGeneration();
  }
  private permitted() {
    return this.alive && !this.locked && !!this.actor && isValidRole(this.actor.role) && !!this.token && this.token === this.api.getToken() && this.authGeneration === this.api.getAuthGeneration();
  }
  reload = (): Promise<void> => this.load('');
  search = (term: string): Promise<void> => this.load(term);
  selectProject = (id: string | null): Promise<void> => {
    if (!this.permitted()) return Promise.resolve();
    this.publish({ selectedProjectId: id, transactions: [], balance: null, auditVerified: null, ready: false, scopeAuthorized: false, scopeKey: this.state.scopeKey + 1 });
    return this.load('');
  };
  private async load(term: string) {
    if (!this.permitted()) return;
    const epoch = ++this.epoch, session = this.captureSession();
    const current = () => session() && epoch === this.epoch;
    const requested = this.state.selectedProjectId;
    const previousProjects = this.state.projects.map((project) => project.id).sort().join('\u0000');
    this.auditRequest++;
    // A same-scope background reload/search keeps the previous authorization so
    // the mounted child (and its focus/partial-warning state) is not torn down.
    this.publish({ transactions: [], balance: null, auditVerified: null, categories: [], ready: false, loading: true, noProjects: false, error: '', scopeAuthorized: this.state.scopeAuthorized });
    let projects: Project[];
    try {
      projects = await this.api.getProjects();
      if (!current()) return;
    } catch (error) {
      if (current()) this.publish({ ...empty(this.state.scopeKey + 1), error: scopeError(error) });
      return;
    }
    const selectedProjectId = requested && projects.some((p) => p.id === requested) ? requested : null;
    const noProjects = this.actor!.role !== 'admin' && projects.length === 0;
    const changedScope = requested !== selectedProjectId || previousProjects !== projects.map((project) => project.id).sort().join('\u0000');
    // Membership/scope loss revokes the previous authorization in the same
    // notification that advances scopeKey, so no subscriber can ever observe a
    // new scope key paired with the previous (still authorized) scope.
    this.publish({
      projects,
      selectedProjectId,
      noProjects,
      scopeKey: this.state.scopeKey + (changedScope ? 1 : 0),
      scopeAuthorized: changedScope || noProjects ? false : this.state.scopeAuthorized,
      loading: !noProjects,
    });
    if (noProjects) return;
    const query = new URLSearchParams();
    if (selectedProjectId) query.set('projectId', selectedProjectId);
    if (term) query.set('searchTitle', term);
    try {
      const [categories, transactions, balance] = await Promise.all([
        this.api.getCategories(), this.api.getTransactions(query.toString()), this.api.getBalance(selectedProjectId || undefined),
      ]);
      if (!current()) return;
      this.publish({ categories, transactions, balance, ready: true, scopeAuthorized: true, loading: false });
      await this.refreshAudit();
    } catch (error) {
      if (current()) this.publish({ categories: [], transactions: [], balance: null, auditVerified: null, ready: false, scopeAuthorized: false, loading: false, error: scopeError(error) });
    }
  }
  refreshAudit = async (): Promise<void> => {
    if (!this.permitted() || this.actor!.role !== 'admin' || !this.state.ready) return;
    const epoch = this.epoch, request = ++this.auditRequest, session = this.captureSession();
    const current = () => session() && epoch === this.epoch && request === this.auditRequest;
    this.publish({ auditVerified: null });
    try {
      const result = await this.api.verifyAudit();
      if (current()) this.publish({ auditVerified: typeof result?.verified === 'boolean' ? result.verified : null });
    } catch { if (current()) this.publish({ auditVerified: null }); }
  };
}
