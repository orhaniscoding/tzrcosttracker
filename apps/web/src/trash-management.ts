import { ApiClient } from './api/client.js';
import { safeManagementError } from './account-management.js';
import { canMutateTrash, isValidRole } from './view-access.js';
export interface TrashContext { role?: string; selectedProjectId?: string | null; onRestored?: () => void | Promise<void> }
export class TrashController {
  private context: TrashContext = {}; private alive = false; private epoch = 0; private request = 0;
  private unsubscribe?: () => void; private listeners = new Set<() => void>();
  private state = { items: [] as any[], loading: false, ready: false, error: '', notice: '', pending: [] as string[] };
  constructor(private api = ApiClient) {}
  getSnapshot = () => this.state;
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  private set(update: Partial<typeof this.state>) { this.state = { ...this.state, ...update }; this.listeners.forEach(l => l()); }
  private clear() { this.epoch++; this.request++; this.set({ items: [], loading: false, ready: false, error: '', notice: '', pending: [] }); }
  connect = () => { this.alive = true; this.unsubscribe = this.api.subscribeAuthChange(() => { this.context = {}; this.clear(); this.set({ error: 'Oturum değişti. Güncel kullanıcıyla yeniden açın.' }); }); return () => this.dispose(); };
  dispose() { this.alive = false; this.unsubscribe?.(); this.clear(); }
  configure(context: TrashContext) { this.context = context; this.clear(); }
  private capture() { const epoch = this.epoch, generation = this.api.getAuthGeneration(), token = this.api.getToken(); return () => this.alive && epoch === this.epoch && generation === this.api.getAuthGeneration() && token === this.api.getToken(); }
  reload = async () => {
    if (!this.alive || !isValidRole(this.context.role)) return false;
    const current = this.capture(), request = ++this.request;
    // Refreshes must retain locks for other rows whose writes are in flight.
    this.set({ items: [], loading: true, ready: false, error: '' });
    try { const items = await this.api.getTrash(this.context.selectedProjectId); if (!current() || request !== this.request) return false; if (!Array.isArray(items)) throw new Error('Invalid response'); this.set({ items, loading: false, ready: true }); return true; }
    catch (error) { if (current() && request === this.request) this.set({ items: [], loading: false, ready: false, error: safeManagementError(error) }); return false; }
  };
  private async mutate(id: string, restore: boolean) {
    if (!this.alive || !canMutateTrash(this.context.role) || this.state.pending.includes(id) || !this.state.items.some(t => t.id === id)) return false;
    const current = this.capture(); this.set({ pending: [...this.state.pending, id], error: '', notice: '' });
    try {
      await (restore ? this.api.restoreTransaction(id) : this.api.permanentDeleteTransaction(id));
      if (!current()) return false;
      // Success is authoritative. A failed refresh must not be reported as a
      // failed restore, and must not suppress the parent notification. The
      // current() guard above also forbids notifying after in-flight disposal.
      let parentFailed = false;
      if (restore) { try { await this.context.onRestored?.(); } catch { parentFailed = true; } }
      if (!current()) return false;
      const refreshed = await this.reload();
      if (!current()) return false;
      this.set({ notice: !refreshed || parentFailed ? 'İşlem tamamlandı; liste yenilenemedi. Yeniden deneyin.' : restore ? 'Kayıt kurtarıldı.' : 'Kayıt kalıcı olarak silindi.' }); return true;
    } catch (error) { if (current()) this.set({ error: safeManagementError(error) }); return false; }
    finally { if (current()) this.set({ pending: this.state.pending.filter(p => p !== id) }); }
  }
  restore = (id: string) => this.mutate(id, true);
  permanentDelete = (id: string) => this.mutate(id, false);
}
