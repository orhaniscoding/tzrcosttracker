import { ApiClient, ApiError } from './api/client.js';

export interface MembershipUser { id: string; fullName: string; username: string; role: string; isActive: boolean; }
export interface MembershipProject { id: string; name: string; }
export interface ProjectMember { userId: string; projectId: string; createdAt: string; }
export interface MembershipState {
  projects: MembershipProject[];
  users: MembershipUser[];
  projectId: string;
  members: ProjectMember[];
  loading: boolean;
  loadingMembers: boolean;
  ready: boolean;
  saving: boolean;
  error: string;
  notice: string;
}
export function membershipError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return 'Oturumunuz geçerli değil. Lütfen yeniden giriş yapın.';
  if (error instanceof ApiError && error.status === 403) return 'Bu işlem için yönetici yetkisi gerekiyor. Yetkilerinizi kontrol edip yeniden deneyin.';
  return 'İşlem tamamlanamadı. Lütfen yeniden deneyin.';
}
export function canListManagedUsers(role: unknown, subView?: string): boolean {
  return role === 'admin' && (!subView || subView === 'list');
}
const empty = (): MembershipState => ({ projects: [], users: [], projectId: '', members: [], loading: false, loadingMembers: false, ready: false, saving: false, error: '', notice: '' });
type MembershipApi = Pick<typeof ApiClient, 'getProjects' | 'getUsers' | 'getProjectMembers' | 'putProjectMember' | 'deleteProjectMember' | 'getToken' | 'getAuthGeneration' | 'subscribeAuthChange'>;

// The UI uses this controller directly. Epochs cover project, read, write,
// actor and lifetime changes; the API generation also covers same-token login.
// Hiding controls is only UX: the server remains the authorization boundary.
export class ProjectMembershipController {
  private state = empty();
  private listeners = new Set<() => void>();
  private epoch = 0;
  private active = false;
  private unsubscribe?: () => void;
  constructor(private role: string, private api: MembershipApi = ApiClient) {}
  getSnapshot = (): MembershipState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<MembershipState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private allowed() { return this.active && this.role === 'admin' && !!this.api.getToken(); }
  private current(epoch: number, generation: number) { return this.allowed() && epoch === this.epoch && generation === this.api.getAuthGeneration(); }
  start = async () => {
    this.active = true;
    this.unsubscribe?.();
    this.unsubscribe = this.api.subscribeAuthChange(() => {
      this.epoch++;
      this.publish({ ...empty(), error: this.api.getToken() ? '' : membershipError(new ApiError('', 401)) });
      if (this.allowed()) void this.load();
    });
    await this.load();
  };
  dispose = () => { this.active = false; this.epoch++; this.unsubscribe?.(); this.unsubscribe = undefined; };
  setRole = (role: string) => {
    if (this.role === role) return;
    this.role = role;
    this.epoch++;
    this.publish(empty());
    if (this.allowed()) void this.load();
  };
  private fail(error: unknown) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      this.epoch++;
      this.publish({ ...empty(), error: membershipError(error) });
    } else {
      this.publish({ members: [], ready: false, loading: false, loadingMembers: false, saving: false, notice: '', error: membershipError(error) });
    }
  }
  load = async () => {
    const epoch = ++this.epoch, generation = this.api.getAuthGeneration();
    this.publish(empty());
    if (!this.allowed()) {
      if (this.active && this.role === 'admin' && !this.api.getToken()) this.publish({ error: membershipError(new ApiError('', 401)) });
      return;
    }
    this.publish({ loading: true });
    try {
      const [projects, users] = await Promise.all([this.api.getProjects(), this.api.getUsers()]);
      if (!this.current(epoch, generation)) return;
      this.publish({ projects, users, loading: false });
    } catch (error) { if (this.current(epoch, generation)) this.fail(error); }
  };
  selectProject = async (projectId: string) => {
    const epoch = ++this.epoch, generation = this.api.getAuthGeneration();
    // Synchronous invalidation: no old list is actionable while B is loading.
    this.publish({ projectId: '', members: [], ready: false, saving: false, loadingMembers: false, error: '', notice: '' });
    if (!this.allowed() || !this.state.projects.some((p) => p.id === projectId)) return;
    this.publish({ projectId, loadingMembers: true });
    await this.readMembers(projectId, epoch, generation);
  };
  reloadMembers = async () => { await this.selectProject(this.state.projectId); };
  private async readMembers(projectId: string, epoch: number, generation: number, notice = '') {
    try {
      const members = await this.api.getProjectMembers(projectId);
      if (!this.current(epoch, generation)) return;
      this.publish({ members: members.filter((m) => m.projectId === projectId), ready: true, loadingMembers: false, saving: false, notice });
    } catch (error) { if (this.current(epoch, generation)) this.fail(error); }
  }
  getCandidates = (): MembershipUser[] => this.state.users.filter((user) => user.isActive === true && user.role !== 'admin' && !this.state.members.some((m) => m.userId === user.id));
  changeMembership = async (userId: string, add: boolean) => {
    if (!this.allowed() || !this.state.ready || this.state.saving || this.state.loadingMembers) return;
    if (add ? !this.getCandidates().some((u) => u.id === userId) : !this.state.members.some((m) => m.userId === userId)) return;
    const projectId = this.state.projectId;
    const epoch = ++this.epoch, generation = this.api.getAuthGeneration();
    this.publish({ saving: true, ready: false, members: [], error: '', notice: '' });
    try {
      const result = await (add ? this.api.putProjectMember(projectId, userId) : this.api.deleteProjectMember(projectId, userId));
      if (!this.current(epoch, generation)) return;
      // Never manufacture a successful list locally. A failed confirmation read
      // leaves no actionable old list, even when the write may have committed.
      this.publish({ loadingMembers: true });
      await this.readMembers(projectId, epoch, generation, result.changed ? 'Üyelik güncellendi.' : 'İstenen üyelik durumu zaten geçerliydi; değişiklik yapılmadı.');
    } catch (error) { if (this.current(epoch, generation)) this.fail(error); }
  };
}
