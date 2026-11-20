import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CostCoreDatabase } from '../client.js';
import { customFields } from '../schema.js';
import type { CustomFieldDefinition } from '@cost-core/types';

export class CustomFieldRepository {
  constructor(private db: CostCoreDatabase) {}

  async createCustomField(input: Omit<CustomFieldDefinition, 'id'>): Promise<CustomFieldDefinition> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const row = {
      id,
      name: input.name,
      label: input.label,
      type: input.type,
      optionsJson: input.options ? JSON.stringify(input.options) : null,
      unit: input.unit || null,
      required: input.required ?? false,
      placeholder: input.placeholder || null,
      defaultValue: input.defaultValue ? String(input.defaultValue) : null,
      createdAt: now,
    };

    await this.db.insert(customFields).values(row);

    return {
      id,
      name: row.name,
      label: row.label,
      type: row.type as any,
      options: input.options,
      unit: input.unit,
      required: row.required,
      placeholder: input.placeholder,
      defaultValue: input.defaultValue,
    };
  }

  async listCustomFields(): Promise<CustomFieldDefinition[]> {
    const rows = await this.db.select().from(customFields);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      label: r.label,
      type: r.type as any,
      options: r.optionsJson ? JSON.parse(r.optionsJson) : undefined,
      unit: r.unit || undefined,
      required: r.required,
      placeholder: r.placeholder || undefined,
      defaultValue: r.defaultValue || undefined,
    }));
  }

  async getCustomFieldById(id: string): Promise<CustomFieldDefinition | null> {
    const rows = await this.db.select().from(customFields).where(eq(customFields.id, id));
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      label: r.label,
      type: r.type as any,
      options: r.optionsJson ? JSON.parse(r.optionsJson) : undefined,
      unit: r.unit || undefined,
      required: r.required,
      placeholder: r.placeholder || undefined,
      defaultValue: r.defaultValue || undefined,
    };
  }
}
