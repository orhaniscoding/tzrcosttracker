import type { NavView } from './components/Sidebar.js';

export const validRoles = ['admin', 'manager', 'accountant', 'auditor', 'viewer'] as const;
export function isValidRole(role: unknown): role is typeof validRoles[number] {
  return typeof role === 'string' && (validRoles as readonly string[]).includes(role);
}
export const canCreateProject = (role: unknown): boolean => role === 'admin';
export const canMutateTransactions = (role: unknown): boolean => typeof role === 'string' && ['admin', 'manager', 'accountant'].includes(role);
export const canMutateAccounts = canMutateTransactions;
export const canMutateTrash = canMutateTransactions;
export const canReassignAccountProject = canCreateProject;
export const canManageCategories = canCreateProject;
const adminViews: readonly NavView[] = ['users_list', 'users_new', 'categories_new', 'parties_ledger', 'audit_logs', 'audit_verify', 'backup_vault', 'settings_branding'];
const sharedViews: readonly NavView[] = ['transactions_list', 'kasa_list', 'accounts_hub', 'kasa_balance', 'kasa_contributions', 'reports_charts', 'reports_date_range', 'reports_daily', 'reports_yearly', 'categories_tree', 'users_pin', 'trash_list', 'security_lock', 'security_2fa'];
export function canAccessView(role: unknown, view: string): boolean {
  if (!isValidRole(role)) return false;
  if (adminViews.includes(view as NavView)) return role === 'admin';
  if (view === 'transactions_new') return ['admin', 'manager', 'accountant'].includes(role);
  return sharedViews.includes(view as NavView);
}
export function isPersonalView(view: NavView): boolean {
  return ['users_pin', 'security_lock', 'security_2fa', 'settings_branding', 'users_list', 'users_new'].includes(view);
}
