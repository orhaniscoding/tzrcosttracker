import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CostCoreDatabase } from '../client.js';
import { parties } from '../schema.js';
import { createBlindIndex } from '@cost-core/crypto';
import type { Party, CreatePartyInput } from '@cost-core/types';

export class PartyRepository {
  constructor(private db: CostCoreDatabase) {}

  async createParty(input: CreatePartyInput, pepper: string | Buffer): Promise<Party> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const nameBlindIndex = createBlindIndex(input.name, pepper);

    const row = {
      id,
      name: input.name,
      nameBlindIndex,
      type: input.type || 'supplier',
      phone: input.phone || null,
      email: input.email || null,
      iban: input.iban || null,
      taxNo: input.taxNo || null,
      taxOffice: input.taxOffice || null,
      notes: input.notes || null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(parties).values(row);
    return row;
  }

  async listParties(type?: string): Promise<Party[]> {
    if (type) {
      return this.db.select().from(parties).where(eq(parties.type, type as any));
    }
    return this.db.select().from(parties);
  }

  async getPartyById(id: string): Promise<Party | null> {
    const rows = await this.db.select().from(parties).where(eq(parties.id, id));
    return rows.length > 0 ? rows[0] : null;
  }

  async deleteParty(id: string): Promise<boolean> {
    const res = await this.db.delete(parties).where(eq(parties.id, id));
    return res.changes > 0;
  }
}
