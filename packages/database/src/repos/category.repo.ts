import { eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CostCoreDatabase } from '../client.js';
import { categories } from '../schema.js';
import type { CreateCategoryInput, Category } from '@cost-core/types';

export interface CategoryTreeNode extends Category {
  children: CategoryTreeNode[];
}

export class CategoryRepository {
  constructor(private db: CostCoreDatabase) {}

  async createCategory(input: CreateCategoryInput): Promise<Category> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const newCategory = {
      id,
      name: input.name,
      code: input.code || null,
      parentId: input.parentId || null,
      description: input.description || null,
      budget: input.budget ?? 0,
      color: input.color || '#3B82F6',
      icon: input.icon || 'folder',
      orderIndex: input.orderIndex ?? 0,
      customFieldIds: JSON.stringify(input.customFieldIds || []),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(categories).values(newCategory);

    return {
      ...newCategory,
      customFieldIds: input.customFieldIds || [],
    };
  }

  async getCategoryById(id: string): Promise<Category | null> {
    const rows = await this.db.select().from(categories).where(eq(categories.id, id));
    if (!rows.length) return null;

    const row = rows[0];
    return {
      ...row,
      customFieldIds: JSON.parse(row.customFieldIds || '[]'),
    };
  }

  async listCategories(): Promise<Category[]> {
    const rows = await this.db.select().from(categories);
    return rows.map((row) => ({
      ...row,
      customFieldIds: JSON.parse(row.customFieldIds || '[]'),
    }));
  }

  /**
   * Sınırsız derinlikte hiyerarşik kategori ağacı döndürür.
   */
  async getCategoryTree(): Promise<CategoryTreeNode[]> {
    const all = await this.listCategories();
    const map = new Map<string, CategoryTreeNode>();

    // Düğümleri hazırla
    for (const cat of all) {
      map.set(cat.id, { ...cat, children: [] });
    }

    const roots: CategoryTreeNode[] = [];

    // Ağacı inşa et
    for (const cat of all) {
      const node = map.get(cat.id)!;
      if (cat.parentId && map.has(cat.parentId)) {
        map.get(cat.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  async deleteCategory(id: string): Promise<boolean> {
    const deleted = await this.db.delete(categories).where(eq(categories.id, id));
    return deleted.changes > 0;
  }

  async updateCategory(id: string, updates: Partial<CreateCategoryInput>): Promise<Category | null> {
    const existing = await this.getCategoryById(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    const updateValues: Record<string, any> = { updatedAt: now };
    if (updates.name !== undefined) updateValues.name = updates.name;
    if (updates.code !== undefined) updateValues.code = updates.code;
    if (updates.parentId !== undefined) updateValues.parentId = updates.parentId;
    if (updates.description !== undefined) updateValues.description = updates.description;
    if (updates.budget !== undefined) updateValues.budget = updates.budget;
    if (updates.color !== undefined) updateValues.color = updates.color;
    if (updates.icon !== undefined) updateValues.icon = updates.icon;
    if (updates.orderIndex !== undefined) updateValues.orderIndex = updates.orderIndex;
    if (updates.customFieldIds !== undefined) updateValues.customFieldIds = JSON.stringify(updates.customFieldIds);

    await this.db.update(categories).set(updateValues).where(eq(categories.id, id));
    return this.getCategoryById(id);
  }
}
