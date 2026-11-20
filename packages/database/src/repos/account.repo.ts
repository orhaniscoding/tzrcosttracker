import { eq, desc, and, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CostCoreDatabase } from '../client.js';
import { accounts, transactions } from '../schema.js';
import { encryptField, decryptField, createBlindIndex } from '@cost-core/crypto';
import type { Account, CreateAccountInput, InternalTransferInput } from '@cost-core/types';

export type AccountReadScope = { all: true } | { all: false; projectIds: readonly string[] };

export class AccountRepository {
  constructor(private db: CostCoreDatabase) {}

  createAccount(
    input: CreateAccountInput,
    masterKey: string | Buffer,
    pepper: string | Buffer
  ): Account {
    const id = randomUUID();
    const now = new Date().toISOString();
    const nameBlindIndex = createBlindIndex(input.name, pepper);

    const initialBalance = input.initialBalance ?? 0;
    const balanceEncrypted = encryptField(initialBalance, masterKey);
    const creditLimitEncrypted = input.creditLimit ? encryptField(input.creditLimit, masterKey) : null;
    const ibanEncrypted = input.iban ? encryptField(input.iban, masterKey) : null;

    const row = {
      id,
      name: input.name,
      nameBlindIndex,
      type: input.type || 'cash',
      currency: input.currency || 'TRY',
      balanceEncrypted,
      creditLimitEncrypted,
      statementClosingDay: input.statementClosingDay || null,
      paymentDueDay: input.paymentDueDay || null,
      ibanEncrypted,
      bankName: input.bankName || null,
      projectId: input.projectId ?? null,
      description: input.description || null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    this.db.insert(accounts).values(row).run();

    return {
      id,
      name: row.name,
      type: row.type as any,
      currency: row.currency,
      balance: initialBalance,
      creditLimit: input.creditLimit || 0,
      statementClosingDay: row.statementClosingDay,
      paymentDueDay: row.paymentDueDay,
      iban: input.iban || null,
      bankName: row.bankName,
      projectId: row.projectId,
      description: row.description,
      isActive: row.isActive,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToAccount(r: typeof accounts.$inferSelect, masterKey: string | Buffer): Account {
    const balance = decryptField<number>(r.balanceEncrypted, masterKey);
    const creditLimit = r.creditLimitEncrypted ? decryptField<number>(r.creditLimitEncrypted, masterKey) : 0;
    const iban = r.ibanEncrypted ? decryptField<string>(r.ibanEncrypted, masterKey) : null;
    return {
      id: r.id,
      name: r.name,
      type: r.type as any,
      currency: r.currency,
      balance,
      creditLimit,
      statementClosingDay: r.statementClosingDay,
      paymentDueDay: r.paymentDueDay,
      iban,
      bankName: r.bankName,
      projectId: r.projectId ?? null,
      description: r.description,
      isActive: r.isActive,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  listAccountsInScope(scope: AccountReadScope, masterKey: string | Buffer): Account[] {
    if (!scope.all && scope.projectIds.length === 0) return [];
    const query = this.db.select().from(accounts);
    const rows = scope.all ? query.orderBy(desc(accounts.createdAt)).all() : query.where(inArray(accounts.projectId, [...scope.projectIds])).orderBy(desc(accounts.createdAt)).all();
    return rows.map((r) => this.rowToAccount(r, masterKey));
  }

  getAccountInScope(id: string, scope: AccountReadScope, masterKey: string | Buffer): Account | null {
    if (!scope.all && scope.projectIds.length === 0) return null;
    const rows = scope.all ? this.db.select().from(accounts).where(eq(accounts.id, id)).all() : this.db.select().from(accounts).where(and(eq(accounts.id, id), inArray(accounts.projectId, [...scope.projectIds]))).all();
    if (!rows.length) return null;
    return this.rowToAccount(rows[0], masterKey);
  }

  getAccountById(id: string, masterKey: string | Buffer): Account | null {
    return this.getAccountInScope(id, { all: true }, masterKey);
  }

  listAccounts(masterKey: string | Buffer): Account[] {
    return this.listAccountsInScope({ all: true }, masterKey);
  }
  updateAccount(
    id: string,
    updates: Partial<CreateAccountInput>,
    masterKey: string | Buffer,
    pepper: string | Buffer
  ): Account | null {
    const existing = this.getAccountById(id, masterKey);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updateValues: Record<string, any> = { updatedAt: now };

    if (updates.name !== undefined) {
      updateValues.name = updates.name;
      updateValues.nameBlindIndex = createBlindIndex(updates.name, pepper);
    }
    if (updates.type !== undefined) updateValues.type = updates.type;
    if (updates.currency !== undefined && updates.currency !== existing.currency) { const refFrom = this.db.select().from(transactions).where(eq(transactions.accountFromId, id)).limit(1).all(); const refTo = this.db.select().from(transactions).where(eq(transactions.accountToId, id)).limit(1).all(); if (refFrom.length || refTo.length) { throw new Error("Bu hesap mali kayıtlarda kullanıldığı için para birimi değiştirilemez."); } updateValues.currency = updates.currency; }
    if (updates.bankName !== undefined) updateValues.bankName = updates.bankName;
    if (updates.projectId !== undefined) updateValues.projectId = updates.projectId;
    if (updates.description !== undefined) updateValues.description = updates.description;
    if (updates.statementClosingDay !== undefined) updateValues.statementClosingDay = updates.statementClosingDay;
    if (updates.paymentDueDay !== undefined) updateValues.paymentDueDay = updates.paymentDueDay;

    if (updates.iban !== undefined) {
      updateValues.ibanEncrypted = updates.iban ? encryptField(updates.iban, masterKey) : null;
    }
    if (updates.creditLimit !== undefined) {
      updateValues.creditLimitEncrypted = updates.creditLimit ? encryptField(updates.creditLimit, masterKey) : null;
    }
    if (updates.initialBalance !== undefined) {
      updateValues.balanceEncrypted = encryptField(updates.initialBalance, masterKey);
    }

    this.db.update(accounts).set(updateValues).where(eq(accounts.id, id)).run();
    return this.getAccountById(id, masterKey);
  }

  /**
   * Cüzdan bakiyesini belirtilen miktar kadar artırır veya azaltır.
   */
  adjustBalance(id: string, delta: number, masterKey: string | Buffer): number { return this.db.transaction(() => {
    const existing = this.getAccountById(id, masterKey);
    if (!existing) throw new Error('Hesap bulunamadı.');

    const newBalance = Math.round(((existing.balance || 0) + delta + Number.EPSILON) * 100) / 100;
    const balanceEncrypted = encryptField(newBalance, masterKey);
    const now = new Date().toISOString();

    this.db
      .update(accounts)
      .set({ balanceEncrypted, updatedAt: now })
      .where(eq(accounts.id, id)).run();

    return newBalance; }, { behavior: 'immediate' });
  }

  /**
   * Virman / İç Transfer (Cüzdanlar arası para aktarımı - P&L Nötr)
   */
  executeInternalTransfer(
    input: InternalTransferInput,
    masterKey: string | Buffer
  ): { fromAccount: Account; toAccount: Account; transferredAmount: number } { return this.db.transaction(() => {
    const from = this.getAccountById(input.fromAccountId, masterKey);
    const to = this.getAccountById(input.toAccountId, masterKey);

    if (!from || !to) throw new Error('Kaynak veya hedef hesap bulunamadı.');
    if (from.id === to.id) throw new Error('Aynı hesaplar arasında virman yapılamaz.');

    // Kur dönüşümü
    const exchangeRate = input.exchangeRate || 1;
    const targetAmount = input.amount * exchangeRate;

    // Kaynaktan düş, hedefe ekle
    this.adjustBalance(from.id, -input.amount, masterKey);
    this.adjustBalance(to.id, targetAmount, masterKey);

    const updatedFrom = (this.getAccountById(from.id, masterKey))!;
    const updatedTo = (this.getAccountById(to.id, masterKey))!;

    return {
      fromAccount: updatedFrom,
      toAccount: updatedTo,
      transferredAmount: input.amount,
    }; }, { behavior: 'immediate' });
  }

  deleteAccount(id: string): boolean {
    const res = this.db.delete(accounts).where(eq(accounts.id, id)).run();
    return res.changes > 0;
  }
}
