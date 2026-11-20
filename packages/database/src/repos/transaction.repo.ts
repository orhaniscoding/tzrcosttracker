import { convertPositiveLedgerAmount, normalizeLedgerCurrency } from '@cost-core/types';

import { eq, and, gte, lte, desc, isNull, isNotNull, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CostCoreDatabase } from '../client.js';
import { transactions } from '../schema.js';
import { encryptField, decryptField, createBlindIndex, numberToTurkishWords } from '@cost-core/crypto';
import type { Transaction, CreateTransactionInput } from '@cost-core/types';

export interface TransactionFilter {
  projectId?: string;
  categoryId?: string;
  subcategoryId?: string;
  startDate?: string;
  endDate?: string;
  /** Internal opt-in for UTC instant bounds; omitted keeps legacy lexical comparison. */
  dateComparison?: 'instant';
  status?: string;
  type?: string;
  isPaid?: boolean;
  searchTitle?: string;
  searchParty?: string;
  includeDeleted?: boolean;
}

export type TransactionReadScope = { all: true } | { all: false; projectIds: readonly string[] };

type NormalizedScope = { kind: 'all' } | { kind: 'restricted'; projectIds: string[] } | { kind: 'deny' };

function normalizeScope(scope: unknown): NormalizedScope {
  if (!scope || typeof scope !== 'object') return { kind: 'deny' };
  const s = scope as { all?: unknown; projectIds?: unknown };
  if (s.all === true) return { kind: 'all' };
  if (s.all !== false) return { kind: 'deny' };
  if (!Array.isArray(s.projectIds) || s.projectIds.length === 0) return { kind: 'deny' };
  for (const id of s.projectIds) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128 || id.trim().length === 0) return { kind: 'deny' };
  }
  return { kind: 'restricted', projectIds: [...s.projectIds] as string[] };
}

export interface FinancialBalanceSummary {
  totalIncome: number;
  totalPaidExpense: number;
  actualCashInHand: number;
  totalPendingExpense: number;
  overdueDebt: number;
  netPositionAfterDue: number;
  totalTransactions: number;
  personContributions: Array<{
    personName: string;
    directKasaAmount: number;
    otoKasaAmount: number;
    totalAmount: number;
    transactionCount: number;
  }>;
}

export class TransactionRepository {
  constructor(private db: CostCoreDatabase) {}

  private rowToTransaction(r: typeof transactions.$inferSelect, masterKey: string | Buffer): Transaction {
    const amount = decryptField<number>(r.amountEncrypted, masterKey);
    const baseAmount = decryptField<number>(r.baseAmountEncrypted, masterKey);
    const title = decryptField<string>(r.titleEncrypted, masterKey);
    const description = r.descriptionEncrypted ? decryptField<string>(r.descriptionEncrypted, masterKey) : null;
    const party = r.partyEncrypted ? decryptField<string>(r.partyEncrypted, masterKey) : null;
    const customValues = r.customValuesEncrypted ? decryptField<Record<string, any>>(r.customValuesEncrypted, masterKey) : {};
    return {
      id: r.id, projectId: r.projectId, type: r.type as any, date: r.date, amount,
      amountInWords: numberToTurkishWords(amount, 'Türk Lirası'), currency: normalizeLedgerCurrency(r.currency),
      exchangeRate: r.exchangeRate, baseAmount, categoryId: r.categoryId,
      subcategoryId: r.subcategoryId, title, description, party,
      accountFromId: r.accountFromId, accountToId: r.accountToId,
      paymentSource: r.paymentSource as any, payerPersonName: r.payerPersonName,
      paymentMethod: r.paymentMethod, otoKasaTransactionId: r.otoKasaTransactionId,
      dueDate: r.dueDate, isPaid: r.isPaid, customValues,
      attachments: JSON.parse(r.attachmentsJson || '[]'), status: r.status as any,
      deletedAt: r.deletedAt, createdById: r.createdById, approvedById: r.approvedById,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }

  /**
   * Mükerrer (çift) kayıt kontrolü yapar.
   * Aynı gün, aynı proje, aynı başlık ve tutarda başka bir kayıt varsa tespit eder.
   */
  listTransactionsInScope(filters: TransactionFilter, scope: TransactionReadScope, masterKey: string | Buffer, pepper: string | Buffer, maxRows?: number): Transaction[] {
    const norm = normalizeScope(scope);
    if (norm.kind === 'deny') return [];
    if (filters.projectId && norm.kind === 'restricted' && !norm.projectIds.includes(filters.projectId)) return [];
    const conditions = [];
    if (norm.kind === 'restricted') conditions.push(inArray(transactions.projectId, norm.projectIds));
    if (filters.projectId) conditions.push(eq(transactions.projectId, filters.projectId));
    if (filters.categoryId) conditions.push(eq(transactions.categoryId, filters.categoryId));
    if (filters.subcategoryId) conditions.push(eq(transactions.subcategoryId, filters.subcategoryId));
    if (filters.type) conditions.push(eq(transactions.type, filters.type as any));
    if (filters.status) conditions.push(eq(transactions.status, filters.status as any));
    if (filters.isPaid !== undefined) conditions.push(eq(transactions.isPaid, filters.isPaid));
    // SQLite parses both sides before comparison: equivalent fractional-second
    // spellings compare equally, and a date-only value is UTC midnight. Bounds
    // remain parameterized and are applied in SQL before any field is decrypted.
    if (filters.startDate) conditions.push(filters.dateComparison === 'instant'
      ? sql`julianday(${transactions.date}) >= julianday(${filters.startDate})`
      : gte(transactions.date, filters.startDate));
    if (filters.endDate) conditions.push(filters.dateComparison === 'instant'
      ? sql`julianday(${transactions.date}) <= julianday(${filters.endDate})`
      : lte(transactions.date, filters.endDate));
    if (filters.searchTitle) conditions.push(eq(transactions.titleBlindIndex, createBlindIndex(filters.searchTitle, pepper)));
    if (filters.searchParty) conditions.push(eq(transactions.partyBlindIndex, createBlindIndex(filters.searchParty, pepper)));
    if (!filters.includeDeleted) conditions.push(isNull(transactions.deletedAt));
    const query = this.db.select().from(transactions).where(and(...conditions)).orderBy(desc(transactions.date));
    const rows = maxRows === undefined ? query.all() : query.limit(maxRows).all();
    return rows.map((r) => this.rowToTransaction(r, masterKey));
  }

  getTransactionInScope(id: string, scope: TransactionReadScope, masterKey: string | Buffer, includeDeleted = false): Transaction | null {
    const norm = normalizeScope(scope);
    if (norm.kind === 'deny') return null;
    const conditions = [eq(transactions.id, id)];
    if (norm.kind === 'restricted') conditions.push(inArray(transactions.projectId, norm.projectIds));
    const rows = this.db.select().from(transactions).where(and(...conditions)).all();
    if (!rows.length) return null;
    const r = rows[0];
    if (r.deletedAt && !includeDeleted) return null;
    return this.rowToTransaction(r, masterKey);
  }

  listTrashInScope(scope: TransactionReadScope, masterKey: string | Buffer): Transaction[] {
    const norm = normalizeScope(scope);
    if (norm.kind === 'deny') return [];
    const conditions = [isNotNull(transactions.deletedAt)];
    if (norm.kind === 'restricted') conditions.push(inArray(transactions.projectId, norm.projectIds));
    const rows = this.db.select().from(transactions).where(and(...conditions)).orderBy(desc(transactions.deletedAt)).all();
    return rows.map((r) => this.rowToTransaction(r, masterKey));
  }

  checkDuplicateInScope(input: CreateTransactionInput, scope: TransactionReadScope, pepper: string | Buffer): { isDuplicate: boolean; existingTransactionId?: string } {
    const norm = normalizeScope(scope);
    if (norm.kind === 'deny') return { isDuplicate: false };
    if (input.projectId && norm.kind === 'restricted' && !norm.projectIds.includes(input.projectId)) return { isDuplicate: false };
    const titleBlindIndex = createBlindIndex(input.title, pepper);
    const dateStr = input.date.split('T')[0];
    const conditions: any[] = [eq(transactions.titleBlindIndex, titleBlindIndex), gte(transactions.date, dateStr + 'T00:00:00.000Z'), lte(transactions.date, dateStr + 'T23:59:59.999Z')];
    if (norm.kind === 'restricted') conditions.push(inArray(transactions.projectId, norm.projectIds));
    if (input.projectId) conditions.push(eq(transactions.projectId, input.projectId));
    const matches = this.db.select().from(transactions).where(and(...conditions)).all();
    if (matches.length > 0) return { isDuplicate: true, existingTransactionId: matches[0].id };
    return { isDuplicate: false };
  }

  checkDuplicate(input: CreateTransactionInput, pepper: string | Buffer): { isDuplicate: boolean; existingTransactionId?: string } {
    return this.checkDuplicateInScope(input, { all: true }, pepper);
  }

  /**
   * Yeni bir mali hareket oluşturur.
   * Şahıs cebinden ödediyse (Oto-Kasa), çift taraflı mahsup kaydını otomatik üretir ve bağlar.
   */
  createTransaction(
    input: CreateTransactionInput & { createdById: string },
    masterKey: string | Buffer,
    pepper: string | Buffer
  ): { transaction: Transaction; otoKasaTransaction?: Transaction } { return this.db.transaction(() => {
    const id = randomUUID();
    const now = new Date().toISOString();
    const exchangeRate = input.exchangeRate || 1;
    const baseAmount = convertPositiveLedgerAmount(input.amount, exchangeRate);

    const amountEncrypted = encryptField(input.amount, masterKey);
    const baseAmountEncrypted = encryptField(baseAmount, masterKey);
    const titleEncrypted = encryptField(input.title, masterKey);
    const titleBlindIndex = createBlindIndex(input.title, pepper);
    const descriptionEncrypted = input.description ? encryptField(input.description, masterKey) : null;
    const partyEncrypted = input.party ? encryptField(input.party, masterKey) : null;
    const partyBlindIndex = input.party ? createBlindIndex(input.party, pepper) : '';
    const customValuesEncrypted = input.customValues ? encryptField(input.customValues, masterKey) : '';

    const isPaid = input.isPaid ?? (input.status !== 'pending');
    const isPersonCreate = input.paymentSource === 'person_out_of_pocket';
    const accountFromId = isPersonCreate ? null : (input.accountFromId || null);
    const accountToId = isPersonCreate ? null : (input.accountToId || null);
    let otoKasaTransactionId: string | null = null;
    let createdOtoKasa: Transaction | undefined = undefined;

    // Oto-Kasa Çift Taraflı Mahsup Mantığı:
    if (input.paymentSource === 'person_out_of_pocket' && input.payerPersonName) {
      otoKasaTransactionId = randomUUID();
    }

    const row = {
      id,
      projectId: input.projectId || null,
      type: input.type || 'expense',
      date: input.date,
      amountEncrypted,
      currency: input.currency || 'TRY',
      exchangeRate,
      baseAmountEncrypted,
      categoryId: input.categoryId,
      subcategoryId: input.subcategoryId || null,
      titleEncrypted,
      titleBlindIndex,
      descriptionEncrypted,
      partyEncrypted,
      partyBlindIndex,
      accountFromId: accountFromId,
      accountToId: accountToId,
      paymentSource: input.paymentSource || 'company_account',
      payerPersonName: input.payerPersonName || null,
      paymentMethod: input.paymentMethod || 'Banka',
      otoKasaTransactionId,
      dueDate: input.dueDate || null,
      isPaid,
      customValuesEncrypted,
      attachmentsJson: JSON.stringify(input.attachments || []),
      status: input.status || (isPaid ? 'approved' : 'pending'),
      createdById: input.createdById,
      approvedById: null,
      createdAt: now,
      updatedAt: now,
    };

    this.db.insert(transactions).values(row).run();

    // Oto-Kasa kaydını Kasa'ya otomatik ekle:
    if (otoKasaTransactionId && input.payerPersonName) {
      const otoTitle = `🔗 Oto-Kasa: ${input.title}`;
      const otoDesc = `Harcamadan otomatik aktarılan şahsi alacak/kasa kaydı. [${input.payerPersonName}]`;
      const otoAmountEnc = encryptField(input.amount, masterKey);
      const otoBaseEnc = encryptField(baseAmount, masterKey);
      const otoTitleEnc = encryptField(otoTitle, masterKey);
      const otoTitleBidx = createBlindIndex(otoTitle, pepper);
      const otoDescEnc = encryptField(otoDesc, masterKey);
      const otoPartyEnc = encryptField(input.payerPersonName, masterKey);
      const otoPartyBidx = createBlindIndex(input.payerPersonName, pepper);

      const otoRow = {
        id: otoKasaTransactionId,
        projectId: input.projectId || null,
        type: 'income' as const,
        date: input.date,
        amountEncrypted: otoAmountEnc,
        currency: input.currency || 'TRY',
        exchangeRate,
        baseAmountEncrypted: otoBaseEnc,
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId || null,
        titleEncrypted: otoTitleEnc,
        titleBlindIndex: otoTitleBidx,
        descriptionEncrypted: otoDescEnc,
        partyEncrypted: otoPartyEnc,
        partyBlindIndex: otoPartyBidx,
        accountFromId: null,
        accountToId: null,
        paymentSource: 'person_out_of_pocket' as const,
        payerPersonName: input.payerPersonName,
        paymentMethod: input.paymentMethod || 'Banka',
        otoKasaTransactionId: id, // Asıl harcamaya geri bağla
        dueDate: null,
        isPaid,
        customValuesEncrypted: '',
        attachmentsJson: JSON.stringify([]),
        status: (input.status || (isPaid ? 'approved' : 'pending')) as any,
        createdById: input.createdById,
        approvedById: null,
        createdAt: now,
        updatedAt: now,
      };

      this.db.insert(transactions).values(otoRow).run();

      createdOtoKasa = {
        ...otoRow,
        amount: input.amount,
        amountInWords: numberToTurkishWords(input.amount, 'Türk Lirası'),
        baseAmount,
        title: otoTitle,
        description: otoDesc,
        party: input.payerPersonName,
        customValues: {},
        attachments: [],
      };
    }

    const mainTx: Transaction = {
      id,
      projectId: row.projectId,
      type: row.type as any,
      date: row.date,
      amount: input.amount,
      amountInWords: numberToTurkishWords(input.amount, 'Türk Lirası'),
      currency: row.currency,
      exchangeRate: row.exchangeRate,
      baseAmount,
      categoryId: row.categoryId,
      subcategoryId: row.subcategoryId,
      title: input.title,
      description: input.description || null,
      party: input.party || null,
      accountFromId: row.accountFromId,
      accountToId: row.accountToId,
      paymentSource: row.paymentSource as any,
      payerPersonName: row.payerPersonName,
      paymentMethod: row.paymentMethod,
      otoKasaTransactionId: row.otoKasaTransactionId,
      dueDate: row.dueDate,
      isPaid: row.isPaid,
      customValues: input.customValues || {},
      attachments: input.attachments || [],
      status: row.status as any,
      createdById: row.createdById,
      approvedById: null,
      createdAt: now,
      updatedAt: now,
    };

    return { transaction: mainTx, otoKasaTransaction: createdOtoKasa };
  }, { behavior: 'immediate' });
  }

  /**
   * Şifreli hareketleri filtreleyip şifresini çözerek döndürür.
   */
  listTransactions(filters: TransactionFilter, masterKey: string | Buffer, pepper: string | Buffer): Transaction[] {
    return this.listTransactionsInScope(filters, { all: true }, masterKey, pepper);
  }

  getTransactionById(id: string, masterKey: string | Buffer, includeDeleted = false): Transaction | null {
    return this.getTransactionInScope(id, { all: true }, masterKey, includeDeleted);
  }

  /**
   * 4'lü Bilanço Barı ve Kişi Bazlı Katkı Özeti (Apps Script V30 Bilanço Mantığı)
   */
  getFinancialBalance(
    projectId: string | undefined,
    masterKey: string | Buffer,
    pepper: string | Buffer
  ): FinancialBalanceSummary {
    return this.getFinancialBalanceInScope({ projectId }, { all: true }, masterKey, pepper);
  }

  /**
   * Applies SQL project/filter scope before decryption, then preserves the legacy
   * balance calculations unchanged. This is not a financial correctness fix.
   */
  getFinancialBalanceInScope(
    filters: TransactionFilter,
    scope: TransactionReadScope,
    masterKey: string | Buffer,
    pepper: string | Buffer
  ): FinancialBalanceSummary {
    const all = this.listTransactionsInScope(filters, scope, masterKey, pepper);

    let totalIncome = 0;
    let totalPaidExpense = 0;
    let totalPendingExpense = 0;
    let overdueDebt = 0;

    const todayStr = new Date().toISOString().split('T')[0];
    const personMap = new Map<string, { direct: number; oto: number; count: number }>();

    for (const tx of all) {
      if (tx.type === 'income') {
        totalIncome += tx.baseAmount;

        // Kasaya para koyan kişi analizi
        const pName = tx.payerPersonName || tx.party || 'Diğer';
        const current = personMap.get(pName) || { direct: 0, oto: 0, count: 0 };
        current.count++;
        if (tx.otoKasaTransactionId) {
          current.oto += tx.baseAmount;
        } else {
          current.direct += tx.baseAmount;
        }
        personMap.set(pName, current);
      } else if (tx.type === 'expense') {
        if (tx.isPaid) {
          totalPaidExpense += tx.baseAmount;
        } else {
          totalPendingExpense += tx.baseAmount;
          if (tx.dueDate && tx.dueDate.split('T')[0] <= todayStr) {
            overdueDebt += tx.baseAmount;
          }
        }
      }
    }

    const actualCashInHand = totalIncome - totalPaidExpense;
    const netPositionAfterDue = actualCashInHand - totalPendingExpense;

    const personContributions = Array.from(personMap.entries()).map(([personName, data]) => ({
      personName,
      directKasaAmount: data.direct,
      otoKasaAmount: data.oto,
      totalAmount: data.direct + data.oto,
      transactionCount: data.count,
    })).sort((a, b) => b.totalAmount - a.totalAmount);

    return {
      totalIncome,
      totalPaidExpense,
      actualCashInHand,
      totalPendingExpense,
      overdueDebt,
      netPositionAfterDue,
      totalTransactions: all.length,
      personContributions,
    };
  }

  /**
   * Kaydı günceller ve eğer Oto-Kasa kaydıysa Kasa'daki bağlı mahsup kaydını da eşzamanlı senkronize eder.
   */
  updateTransaction(
    id: string,
    updates: Partial<CreateTransactionInput>,
    masterKey: string | Buffer,
    pepper: string | Buffer
  ): Transaction | null { return this.db.transaction(() => {
    const existing = this.getTransactionById(id, masterKey);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updateValues: Record<string, any> = { updatedAt: now };

    if (updates.amount !== undefined || updates.exchangeRate !== undefined) {
      const exchangeRate = updates.exchangeRate ?? existing.exchangeRate;
      const effectiveAmount = updates.amount ?? existing.amount;
      const baseAmount = convertPositiveLedgerAmount(effectiveAmount, exchangeRate);
      if (updates.amount !== undefined) updateValues.amountEncrypted = encryptField(updates.amount, masterKey);
      updateValues.baseAmountEncrypted = encryptField(baseAmount, masterKey);
      updateValues.exchangeRate = exchangeRate;
    }

    if (updates.title !== undefined) {
      updateValues.titleEncrypted = encryptField(updates.title, masterKey);
      updateValues.titleBlindIndex = createBlindIndex(updates.title, pepper);
    }

    if (updates.description !== undefined) {
      updateValues.descriptionEncrypted = updates.description ? encryptField(updates.description, masterKey) : null;
    }

    if (updates.party !== undefined) {
      updateValues.partyEncrypted = updates.party ? encryptField(updates.party, masterKey) : null;
      updateValues.partyBlindIndex = updates.party ? createBlindIndex(updates.party, pepper) : '';
    }

    if (updates.date !== undefined) updateValues.date = updates.date;
    if (updates.categoryId !== undefined) updateValues.categoryId = updates.categoryId;
    if (updates.subcategoryId !== undefined) updateValues.subcategoryId = updates.subcategoryId;
    if (updates.currency !== undefined) updateValues.currency = updates.currency;
    if (updates.paymentMethod !== undefined) updateValues.paymentMethod = updates.paymentMethod;
    if (updates.isPaid !== undefined) {
      updateValues.isPaid = updates.isPaid;
      updateValues.status = updates.isPaid ? 'approved' : 'pending';
    }
    if (updates.dueDate !== undefined) updateValues.dueDate = updates.dueDate;
    if (updates.customValues !== undefined) {
      updateValues.customValuesEncrypted = encryptField(updates.customValues, masterKey);
    }
    if (updates.attachments !== undefined) {
      updateValues.attachmentsJson = JSON.stringify(updates.attachments);
    }
    if (updates.paymentSource !== undefined) updateValues.paymentSource = updates.paymentSource;
    if (updates.accountFromId !== undefined) updateValues.accountFromId = updates.accountFromId;
    if (updates.accountToId !== undefined) updateValues.accountToId = updates.accountToId;
    const wantsPersonUpd = (updates.paymentSource !== undefined ? updates.paymentSource : existing.paymentSource) === 'person_out_of_pocket';
    if (wantsPersonUpd) { updateValues.accountFromId = null; updateValues.accountToId = null; }
    if (updates.status !== undefined) updateValues.status = updates.status;
    if (updates.payerPersonName !== undefined) updateValues.payerPersonName = updates.payerPersonName;

    this.db.update(transactions).set(updateValues).where(eq(transactions.id, id)).run();

    const eff: any = this.getTransactionById(id, masterKey) || existing;
    const mergedAmount = eff.amount;
    const mergedCurrency = eff.currency;
    const mergedRate = eff.exchangeRate;
    const mergedTitle = eff.title;
    const mergedDate = eff.date;
    const mergedCategory = eff.categoryId;
    const mergedSub = eff.subcategoryId;
    const mergedProject = eff.projectId;
    const mergedMethod = eff.paymentMethod;
    const wantsPerson = (updates.paymentSource !== undefined ? updates.paymentSource : existing.paymentSource) === "person_out_of_pocket";
    const payerMerged = updates.payerPersonName !== undefined ? updates.payerPersonName : existing.payerPersonName;
    const otoIdExisting = existing.otoKasaTransactionId;
    if (otoIdExisting && !wantsPerson) {
      this.db.delete(transactions).where(eq(transactions.id, otoIdExisting)).run();
      this.db.update(transactions).set({ otoKasaTransactionId: null, updatedAt: now }).where(eq(transactions.id, id)).run();
    } else if (!otoIdExisting && wantsPerson && payerMerged) {
      const newOtoId = randomUUID();
      const otoTitle2 = "🔗 Oto-Kasa: " + mergedTitle;
      const otoDesc2 = "Harcamadan otomatik aktarılan şahsi alacak/kasa kaydı. [" + payerMerged + "]";
      this.db.insert(transactions).values({ id: newOtoId, projectId: mergedProject || null, type: "income" as const, date: mergedDate, amountEncrypted: updateValues.amountEncrypted || encryptField(mergedAmount, masterKey), currency: mergedCurrency, exchangeRate: mergedRate, baseAmountEncrypted: updateValues.baseAmountEncrypted || encryptField(existing.baseAmount, masterKey), categoryId: mergedCategory, subcategoryId: mergedSub || null, titleEncrypted: encryptField(otoTitle2, masterKey), titleBlindIndex: createBlindIndex(otoTitle2, pepper), descriptionEncrypted: encryptField(otoDesc2, masterKey), partyEncrypted: encryptField(payerMerged, masterKey), partyBlindIndex: createBlindIndex(payerMerged, pepper), accountFromId: null, accountToId: null, paymentSource: "person_out_of_pocket" as const, payerPersonName: payerMerged, paymentMethod: mergedMethod || "Banka", otoKasaTransactionId: id, dueDate: null, isPaid: eff.isPaid, customValuesEncrypted: "", attachmentsJson: "[]", status: eff.status as any, createdById: existing.createdById, approvedById: null, createdAt: now, updatedAt: now }).run();
      this.db.update(transactions).set({ otoKasaTransactionId: newOtoId, updatedAt: now }).where(eq(transactions.id, id)).run();
    } else if (otoIdExisting && wantsPerson) {
      const otoUpdateValues: Record<string, any> = { updatedAt: now, accountFromId: null, accountToId: null };
      if (updateValues.amountEncrypted) { otoUpdateValues.amountEncrypted = updateValues.amountEncrypted; otoUpdateValues.baseAmountEncrypted = updateValues.baseAmountEncrypted; }
      else if (updates.exchangeRate !== undefined) { otoUpdateValues.baseAmountEncrypted = updateValues.baseAmountEncrypted; otoUpdateValues.exchangeRate = updates.exchangeRate; }
      if (updates.title !== undefined) { const otoTitle = "🔗 Oto-Kasa: " + updates.title; otoUpdateValues.titleEncrypted = encryptField(otoTitle, masterKey); otoUpdateValues.titleBlindIndex = createBlindIndex(otoTitle, pepper); }
      if (updates.date !== undefined) otoUpdateValues.date = updates.date;
      if (updates.currency !== undefined) otoUpdateValues.currency = updates.currency;
      if (updates.exchangeRate !== undefined) otoUpdateValues.exchangeRate = updates.exchangeRate;
      if (updates.categoryId !== undefined) otoUpdateValues.categoryId = updates.categoryId;
      if (updates.subcategoryId !== undefined) otoUpdateValues.subcategoryId = updates.subcategoryId;
      otoUpdateValues.projectId = eff.projectId ?? null;
      otoUpdateValues.isPaid = eff.isPaid; otoUpdateValues.status = eff.status;
      if (updates.paymentMethod !== undefined) otoUpdateValues.paymentMethod = updates.paymentMethod;
      if (updates.payerPersonName !== undefined) { otoUpdateValues.partyEncrypted = updates.payerPersonName ? encryptField(updates.payerPersonName, masterKey) : null; otoUpdateValues.partyBlindIndex = updates.payerPersonName ? createBlindIndex(updates.payerPersonName, pepper) : ""; otoUpdateValues.payerPersonName = updates.payerPersonName; }
      this.db.update(transactions).set(otoUpdateValues).where(eq(transactions.id, otoIdExisting)).run();
    }
    return this.getTransactionById(id, masterKey);
  }, { behavior: 'immediate' });
  }

  /**
   * Kaydı çöp kutusuna taşır (Soft Delete). Eğer Oto-Kasa kaydıysa Kasa'daki bağlı kaydı da çöp kutusuna taşır.
   */
  softDeleteTransaction(id: string, masterKey: string | Buffer): boolean { return this.db.transaction(() => {
    const existing = this.getTransactionById(id, masterKey);
    if (!existing) return false;

    const now = new Date().toISOString();
    if (existing.otoKasaTransactionId) {
      this.db.update(transactions).set({ deletedAt: now, updatedAt: now }).where(eq(transactions.id, existing.otoKasaTransactionId)).run();
    }

    const res = this.db.update(transactions).set({ deletedAt: now, updatedAt: now }).where(eq(transactions.id, id)).run();
    return res.changes > 0; }, { behavior: 'immediate' });
  }

  /**
   * Çöp kutusundaki kaydı geri yükler. Eğer Oto-Kasa kaydıysa Kasa'daki bağlı kaydı da geri yükler.
   */
  restoreTransaction(id: string, masterKey: string | Buffer): Transaction | null { return this.db.transaction(() => {
    const rows = this.db.select().from(transactions).where(eq(transactions.id, id)).all();
    if (!rows.length) return null;
    const r = rows[0];

    const now = new Date().toISOString();
    this.db.update(transactions).set({ deletedAt: null, updatedAt: now }).where(eq(transactions.id, id)).run();

    if (r.otoKasaTransactionId) {
      this.db.update(transactions).set({ deletedAt: null, updatedAt: now }).where(eq(transactions.id, r.otoKasaTransactionId)).run();
    }

    return this.getTransactionById(id, masterKey);
  }, { behavior: 'immediate' });
  }

  /**
   * Çöp kutusundaki silinmiş kayıtları listeler.
   */
  listTrash(masterKey: string | Buffer): Transaction[] {
    return this.listTrashInScope({ all: true }, masterKey);
  }

  /**
   * Kaydı kalıcı olarak veritabanından siler (Hard Delete).
   */
  permanentDeleteTransaction(id: string, masterKey: string | Buffer): boolean { return this.db.transaction(() => {
    const rows = this.db.select().from(transactions).where(eq(transactions.id, id)).all();
    if (!rows.length) return false;
    const r = rows[0];

    if (r.otoKasaTransactionId) {
      this.db.delete(transactions).where(eq(transactions.id, r.otoKasaTransactionId)).run();
    }

    const res = this.db.delete(transactions).where(eq(transactions.id, id)).run();
    return res.changes > 0; }, { behavior: 'immediate' });
  }

  /**
   * Kaydı siler. Varsayılan olarak çöp kutusuna taşır (soft delete), permanent=true ise kalıcı siler.
   */
  deleteTransaction(
    id: string,
    masterKey: string | Buffer,
    permanent = false
    ): boolean {
    if (permanent) {
      return this.permanentDeleteTransaction(id, masterKey);
    }
    return this.softDeleteTransaction(id, masterKey);
  }

  /**
   * Vadeli bir harcamayı tek tıkla "Ödendi" yapar (Apps Script SECILI_VADELIYI_ODENDI_YAP mantığı).
   */
  markTransactionPaid(id: string, masterKey: string | Buffer): Transaction | null { return this.db.transaction(() => {
        const existing: any = this.getTransactionById(id, masterKey);
    if (!existing) return null;
    if (['draft','pending_approval','rejected','cancelled'].includes(existing.status)) throw new Error('Invalid state cannot be marked paid.');
    const now = new Date().toISOString();
    this.db.update(transactions).set({ isPaid: true, status: 'approved', updatedAt: now }).where(eq(transactions.id, id)).run();
    if (existing.otoKasaTransactionId) this.db.update(transactions).set({ isPaid: true, status: 'approved', updatedAt: now }).where(eq(transactions.id, existing.otoKasaTransactionId)).run();


    return this.getTransactionById(id, masterKey);
  }, { behavior: 'immediate' });
  }
}
