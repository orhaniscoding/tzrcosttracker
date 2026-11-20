import { eq, or, and } from 'drizzle-orm';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { CostCoreDatabase } from '../client.js';
import { users } from '../schema.js';
import { hashPassword, verifyPassword, encryptField, decryptField } from '@cost-core/crypto';
import type { User, CreateUserInput } from '@cost-core/types';

export class UserRepository {
  constructor(private db: CostCoreDatabase) {}

  async createUser(input: CreateUserInput, masterKey: string | Buffer): Promise<User> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashPassword(input.password);
    const pinHash = input.pin ? await hashPassword(input.pin) : null;

    const row = {
      id,
      username: input.username,
      email: input.email,
      fullName: input.fullName,
      passwordHash,
      pinHash,
      role: input.role || 'viewer',
      isActive: true,
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorBackupCodes: JSON.stringify([]),
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(users).values(row);

    return {
      id: row.id,
      username: row.username,
      email: row.email,
      fullName: row.fullName,
      role: row.role as any,
      isActive: row.isActive,
      hasPin: !!row.pinHash,
      twoFactorEnabled: row.twoFactorEnabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async listUsers(): Promise<Array<Omit<User, 'twoFactorSecret'>>> {
    const rows = await this.db.select().from(users);
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      fullName: r.fullName,
      role: r.role as any,
      isActive: r.isActive,
      hasPin: !!r.pinHash,
      twoFactorEnabled: r.twoFactorEnabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async setUserPin(id: string, pin: string): Promise<boolean> {
    const pinHash = await hashPassword(pin);
    const now = new Date().toISOString();
    const res = await this.db
      .update(users)
      .set({ pinHash, updatedAt: now })
      .where(eq(users.id, id));
    return res.changes > 0;
  }

  async verifyUserPin(id: string, pin: string): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id));
    if (!rows.length) return null;
    const r = rows[0];
    if (!r.pinHash) return null;

    const isValid = await verifyPassword(pin, r.pinHash);
    if (!isValid) return null;

    return {
      id: r.id,
      username: r.username,
      email: r.email,
      fullName: r.fullName,
      role: r.role as any,
      isActive: r.isActive,
      hasPin: true,
      twoFactorEnabled: r.twoFactorEnabled,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async getUserById(id: string, masterKey: string | Buffer): Promise<(User & { passwordHash: string; rawTwoFactorSecret?: string | null }) | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id));
    if (!rows.length) return null;
    const r = rows[0];

    const rawSecret = r.twoFactorSecret ? decryptField<string>(r.twoFactorSecret, masterKey) : null;

    return {
      id: r.id,
      username: r.username,
      email: r.email,
      fullName: r.fullName,
      role: r.role as any,
      isActive: r.isActive,
      hasPin: !!r.pinHash,
      twoFactorEnabled: r.twoFactorEnabled,
      twoFactorSecret: rawSecret,
      rawTwoFactorSecret: rawSecret,
      passwordHash: r.passwordHash,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async getUserByUsernameOrEmail(identifier: string): Promise<(User & { passwordHash: string; rawTwoFactorSecret?: string | null; twoFactorSecretEncrypted?: string | null }) | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(or(eq(users.username, identifier), eq(users.email, identifier)));

    if (!rows.length) return null;
    const r = rows[0];

    return {
      id: r.id,
      username: r.username,
      email: r.email,
      fullName: r.fullName,
      role: r.role as any,
      isActive: r.isActive,
      hasPin: !!r.pinHash,
      twoFactorEnabled: r.twoFactorEnabled,
      twoFactorSecretEncrypted: r.twoFactorSecret,
      passwordHash: r.passwordHash,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async getAuthStateById(id: string): Promise<{ id: string; username: string; role: string; isActive: boolean } | null> {
    const rows = await this.db
      .select({
        id: users.id,
        username: users.username,
        role: users.role,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, id));

    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      username: r.username,
      role: r.role as string,
      isActive: !!r.isActive,
    };
  }

  async enableTwoFactor(id: string, secret: string, backupCodesHashed: string[], masterKey: string | Buffer): Promise<boolean> {
    const encryptedSecret = encryptField(secret, masterKey);
    const now = new Date().toISOString();

    const result = await this.db
      .update(users)
      .set({
        twoFactorEnabled: true,
        twoFactorSecret: encryptedSecret,
        twoFactorBackupCodes: JSON.stringify(backupCodesHashed),
        updatedAt: now,
      })
      .where(eq(users.id, id));

    return result.changes > 0;
  }

  enableTwoFactorInTx(tx: any, id: string, secret: string, backupCodesHashed: string[], masterKey: any): boolean {
    const row = tx.select().from(users).where(eq(users.id, id)).get();
    if (!row || !row.isActive || row.twoFactorEnabled) return false;
    const res = tx.update(users).set({ twoFactorEnabled: true, twoFactorSecret: encryptField(secret, masterKey), twoFactorBackupCodes: JSON.stringify(backupCodesHashed), updatedAt: new Date().toISOString() }).where(eq(users.id, id)).run();
    return res.changes > 0;
  }
  consumeBackupCodeInTx(tx: any, userId: string, codeHash: string): boolean {
    const invalid = 'INVALID_BACKUP_CODE_STATE';
    if (typeof userId !== 'string' || userId.length === 0) return false;
    if (typeof codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(codeHash)) return false;
    const row = tx.select().from(users).where(eq(users.id, userId)).get();
    if (!row || !row.isActive || !row.twoFactorEnabled) return false;
    const stored = row.twoFactorBackupCodes;
    if (typeof stored !== 'string') throw new Error(invalid);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch {
      throw new Error(invalid);
    }
    if (!Array.isArray(parsed) || parsed.length > 256) throw new Error(invalid);
    const hashes: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item)) throw new Error(invalid);
      hashes.push(item);
    }
    const supplied = Buffer.from(codeHash, 'hex');
    let matched = false;
    const remaining: string[] = [];
    for (const h of hashes) {
      let same = false;
      try {
        same = timingSafeEqual(Buffer.from(h, 'hex'), supplied);
      } catch {
        throw new Error(invalid);
      }
      if (same) matched = true;
      else remaining.push(h);
    }
    if (!matched) return false;
    const now = new Date().toISOString();
    const nextJson = JSON.stringify(remaining);
    const res = tx.update(users).set({ twoFactorBackupCodes: nextJson, updatedAt: now }).where(and(eq(users.id, userId), eq(users.isActive, true), eq(users.twoFactorEnabled, true), eq(users.twoFactorBackupCodes, stored))).run();
    return res.changes > 0;
  }
}
