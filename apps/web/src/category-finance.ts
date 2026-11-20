import type { Category, Transaction } from '@cost-core/types';
import { computeReportFinance } from './report-finance';

export function computeCategoryExpense(categoryId: string, categories: readonly Category[], transactions: readonly Transaction[], baseCurrency: string) {
  const byId = new Map(categories.map(category => [category.id, category]));
  const children = new Map<string, string[]>();
  for (const category of categories) {
    if (category.parentId != null) {
      const siblings = children.get(category.parentId) ?? [];
      siblings.push(category.id);
      children.set(category.parentId, siblings);
    }
  }

  let hasHierarchyIssue = false;
  const ancestors = new Set<string>();
  let current: string | null | undefined = categoryId;
  while (current != null) {
    if (ancestors.has(current)) { hasHierarchyIssue = true; break; }
    ancestors.add(current);
    const category = byId.get(current);
    if (!category) { hasHierarchyIssue = true; break; }
    current = category.parentId;
  }

  const categoryIds = new Set<string>();
  const pending = [categoryId];
  while (pending.length) {
    const id = pending.pop()!;
    if (categoryIds.has(id)) { hasHierarchyIssue = true; continue; }
    categoryIds.add(id);
    for (const child of children.get(id) ?? []) pending.push(child);
  }
  const selectedExpense = transactions.filter(t => t.type === 'expense' && ((t.categoryId != null && categoryIds.has(t.categoryId)) || (t.subcategoryId != null && categoryIds.has(t.subcategoryId))));
  return { categoryIds, hasHierarchyIssue, finance: computeReportFinance(selectedExpense, baseCurrency) };
}
