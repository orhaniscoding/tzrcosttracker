const API_BASE = '/api';

function clearLegacyToken(): void {
  try { globalThis.window?.localStorage?.removeItem('costcore_token'); } catch { /* Storage can be disabled. */ }
}
clearLegacyToken();

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}
export class ApiClient {
  private static token: string | null = null;
  private static authGeneration = 0;
  private static authChangeListeners = new Set<() => void>();
  static getAuthGeneration(): number { return this.authGeneration; }
  static subscribeAuthChange(listener: () => void): () => void { this.authChangeListeners.add(listener); return () => { this.authChangeListeners.delete(listener); }; }
  private static sessionInvalidListeners = new Set<() => void>();
  static subscribeSessionInvalid(listener: () => void): () => void { this.sessionInvalidListeners.add(listener); return () => { this.sessionInvalidListeners.delete(listener); }; }
  private static notifySessionInvalid() { [...this.sessionInvalidListeners].forEach((l) => { try { l(); } catch {} }); }
  static setToken(token: string | null) {
    this.authGeneration += 1;
    this.token = token;
    clearLegacyToken();
    [...this.authChangeListeners].forEach((listener) => { try { listener(); } catch {} });
  }

  static getToken(): string | null {
    return this.token;
  }

  static async request<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const requestToken = this.token;
    const requestGeneration = this.authGeneration;
    const body = options.body;
    const isFormData = typeof FormData !== 'undefined' && typeof body === 'object' && body instanceof FormData;
    const isBlob = typeof Blob !== 'undefined' && typeof body === 'object' && body instanceof Blob;
    const headers: Record<string, string> = {};
    // Only advertise JSON when a body is actually sent: bodyless POST/DELETE
    // requests must not claim application/json (Fastify rejects an empty JSON
    // body with 400). Explicit caller headers still take precedence.
    if (body !== undefined && body !== null && !isFormData && !isBlob) {
      headers['Content-Type'] = 'application/json';
    }
    Object.assign(headers, (options.headers as Record<string, string>) || {});
    if (requestToken) headers['Authorization'] = `Bearer ${requestToken}`;
    const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Bilinmeyen bir hata oluştu.' }));
      const code = typeof err?.code === 'string' ? err.code : undefined;
      if (res.status === 401 && code === 'SESSION_INVALID' && requestToken && this.token === requestToken && this.authGeneration === requestGeneration) {
        this.setToken(null);
        this.notifySessionInvalid();
      }
      throw new ApiError(err.error || `HTTP ${res.status}`, res.status, code);
    }
    return res.json();
  }
  static logout = () => {
    const token = this.token;
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers });
  };

  // Auth & Users & PIN
  static login = (data: any) => this.request('/auth/login', { method: 'POST', body: JSON.stringify(data) });
  static register = (data: any) => this.request('/auth/register', { method: 'POST', body: JSON.stringify(data) });
  static getMe = () => this.request('/auth/me');
  static setup2FA = () => this.request('/auth/2fa/setup', { method: 'POST' });
  static enable2FA = (data: any) => this.request('/auth/2fa/enable', { method: 'POST', body: JSON.stringify(data) });
  static getUsers = () => this.request('/auth/users');
  static createUser = (data: any) => this.request('/auth/users', { method: 'POST', body: JSON.stringify(data) });
  static switchUserPin = (data: any) => this.request('/auth/switch-pin', { method: 'POST', body: JSON.stringify(data) });
  static setUserPin = (data: any) => this.request('/auth/set-pin', { method: 'POST', body: JSON.stringify(data) });

  // Categories
  static getCategories = (tree = false) => this.request(`/categories?tree=${tree}`);
  static createCategory = (data: any) => this.request('/categories', { method: 'POST', body: JSON.stringify(data) });
  static updateCategory = (id: string, data: any) => this.request(`/categories/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) });
  static deleteCategory = (id: string) => this.request(`/categories/${encodeURIComponent(id)}`, { method: 'DELETE' });

  // Projects
  static getProjects = () => this.request('/projects');
  static createProject = (data: any) => this.request('/projects', { method: 'POST', body: JSON.stringify(data) });
  static getProjectMembers = (projectId: string) => this.request<Array<{ userId: string; projectId: string; createdAt: string }>>(`/projects/${encodeURIComponent(projectId)}/members`, { method: 'GET' });
  static putProjectMember = (projectId: string, userId: string) => this.request<{ changed: boolean }>(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: 'PUT' });
  static deleteProjectMember = (projectId: string, userId: string) => this.request<{ changed: boolean }>(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });

  // Parties (Cariler / Şahıslar)
  static getParties = (type?: string) => this.request(`/parties${type ? `?type=${type}` : ''}`);
  static createParty = (data: any) => this.request('/parties', { method: 'POST', body: JSON.stringify(data) });
  static deleteParty = (id: string) => this.request(`/parties/${encodeURIComponent(id)}`, { method: 'DELETE' });

  // Accounts (Cüzdanlar, Bankalar, Kredi Kartları & Likidite Hub'ı)
  static getAccounts = (projectId?: string | null) => this.request(`/accounts${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
  static getAccount = (id: string) => this.request(`/accounts/${encodeURIComponent(id)}`);
  static createAccount = (data: any) => this.request('/accounts', { method: 'POST', body: JSON.stringify(data) });
  static updateAccount = (id: string, data: any) => this.request(`/accounts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) });
  static deleteAccount = (id: string) => this.request(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  static transferFunds = (data: any) => this.request('/accounts/transfer', { method: 'POST', body: JSON.stringify(data) });
  static getLiquiditySummary = (projectId?: string | null) => this.request(`/accounts/liquidity/summary${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);

  // Transactions
  static getTransactions = (query = '') => this.request(`/transactions${query ? `?${query}` : ''}`);
  static createTransaction = (data: any, idempotencyKey?: string) => this.request('/transactions', { method: 'POST', headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined, body: JSON.stringify(data) });
  static updateTransaction = (id: string, data: any) => this.request(`/transactions/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) });
  static deleteTransaction = (id: string, permanent = false) => this.request(`/transactions/${encodeURIComponent(id)}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' });
  static getTrash = (projectId?: string | null) => this.request(`/transactions/trash${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`);
  static restoreTransaction = (id: string) => this.request(`/transactions/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  static permanentDeleteTransaction = (id: string) => this.request(`/transactions/${encodeURIComponent(id)}/permanent`, { method: 'DELETE' });
  static markTransactionPaid = (id: string) => this.request(`/transactions/${encodeURIComponent(id)}/mark-paid`, { method: 'POST' });
  static checkDuplicate = (data: any) => this.request('/transactions/check-duplicate', { method: 'POST', body: JSON.stringify(data) });

  // Reports & Summary & 4-Way Balance
  static getSummary = () => this.request('/reports/summary');
  static getBalance = (projectId?: string | null) => this.request(projectId ? `/reports/balance?projectId=${encodeURIComponent(projectId)}` : '/reports/balance');

  // Universal Excel & Google Sheets Import
  static analyzeImport = (data: any) => this.request('/import/analyze', { method: 'POST', body: JSON.stringify(data) });
  static executeImport = (data: any) => this.request('/import/execute', { method: 'POST', body: JSON.stringify(data) });
  static importKaraelmas = () => this.request('/import/karaelmas', { method: 'POST' });

  // System Onboarding & Status
  static getSystemStatus = () => this.request('/system/status');
  static setupSystem = (data: any, setupToken: string) => this.request('/system/setup', { method: 'POST', headers: { 'x-setup-token': setupToken }, body: JSON.stringify(data) });
  static getIndustryTemplates = () => this.request('/system/templates');

  // Encrypted Backup (.tzrvault)
  static exportFullBackupV2 = (password: string) => this.request('/backup/export-v2', { method: 'POST', body: JSON.stringify({ backupPassword: password }) });

  // Audit
  static getAuditLogs = (limit = 100) => this.request(`/audit?limit=${limit}`);
  static verifyAudit = () => this.request('/audit/verify');

  // White Label Settings
  static getWhiteLabel = () => this.request('/settings/white-label');
  static updateWhiteLabel = (data: any) => this.request('/settings/white-label', { method: 'PUT', body: JSON.stringify(data) });
}
