import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { initDatabase, TransactionRepository, transactions } from '../src/index.js';
import type {
  CostCoreDatabase,
  DatabaseInstance,
  FinancialBalanceSummary,
  TransactionFilter,
  TransactionReadScope,
} from '../src/index.js';

const KEY = 'unit-test-master-encryption-key-32b!';
const PEPPER = 'unit-test-blind-index-pepper-key!';
const CORRUPT = 'enc:v1:000102030405060708090a0b:000102030405060708090a0b0c0d0e0f:deadbeef';
const scopeA: TransactionReadScope = { all: false, projectIds: ['proj-a'] };
const scopeAB: TransactionReadScope = { all: false, projectIds: ['proj-a', 'proj-b'] };
const allScope: TransactionReadScope = { all: true };
const ZERO: FinancialBalanceSummary = {
  totalIncome: 0,
  totalPaidExpense: 0,
  actualCashInHand: 0,
  totalPendingExpense: 0,
  overdueDebt: 0,
  netPositionAfterDue: 0,
  totalTransactions: 0,
  personContributions: [],
};

type CreateInput = Parameters<TransactionRepository['createTransaction']>[0];
let db: DatabaseInstance['db'];
let sqlite: DatabaseInstance['sqlite'];
let repo: TransactionRepository;

function create(projectId: string | null, overrides: Partial<CreateInput> = {}, target = repo) {
  return target.createTransaction({
    type: 'expense',
    date: '2024-06-10T10:00:00.000Z',
    amount: 100,
    currency: 'TRY',
    exchangeRate: 1,
    categoryId: 'cat-synthetic',
    title: 'Synthetic balance row',
    createdById: 'user-synthetic',
    projectId: projectId ?? undefined,
    ...overrides,
  }, KEY, PEPPER);
}

function balance(filters: TransactionFilter = {}, scope: TransactionReadScope = scopeA) {
  return repo.getFinancialBalanceInScope(filters, scope, KEY, PEPPER);
}

beforeEach(() => {
  ({ db, sqlite } = initDatabase({ path: ':memory:' }));
  repo = new TransactionRepository(db);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sqlite.close();
});

// These assertions freeze legacy aggregation semantics, not financial correctness.
describe('TransactionRepository scoped financial balance', () => {
  it('aggregates one or multiple allowed projects without outside or null legacy rows', () => {
    create('proj-a', { type: 'income', amount: 500, party: 'A contributor' });
    create('proj-a', { amount: 80, isPaid: true });
    create('proj-a', { amount: 30, isPaid: false, dueDate: '2024-06-15T23:00:00.000Z' });
    create('proj-a', { amount: 40, isPaid: false, dueDate: '2024-06-16T00:00:00.000Z' });
    create('proj-a', { type: 'transfer', amount: 900 });
    create('proj-b', { type: 'income', amount: 200, party: 'B contributor' });
    create('proj-b', { amount: 20, isPaid: true });
    create('proj-c', { type: 'income', amount: 9000, party: 'Outside identity' });
    create(null, { type: 'income', amount: 8000, party: 'Legacy identity' });

    expect(balance()).toEqual({
      totalIncome: 500,
      totalPaidExpense: 80,
      actualCashInHand: 420,
      totalPendingExpense: 70,
      overdueDebt: 30,
      netPositionAfterDue: 350,
      totalTransactions: 5,
      personContributions: [{
        personName: 'A contributor', directKasaAmount: 500, otoKasaAmount: 0,
        totalAmount: 500, transactionCount: 1,
      }],
    });
    expect(balance({}, scopeAB)).toEqual({
      totalIncome: 700,
      totalPaidExpense: 100,
      actualCashInHand: 600,
      totalPendingExpense: 70,
      overdueDebt: 30,
      netPositionAfterDue: 530,
      totalTransactions: 7,
      personContributions: [
        { personName: 'A contributor', directKasaAmount: 500, otoKasaAmount: 0, totalAmount: 500, transactionCount: 1 },
        { personName: 'B contributor', directKasaAmount: 200, otoKasaAmount: 0, totalAmount: 200, transactionCount: 1 },
      ],
    });
    expect(balance({}, allScope).totalIncome).toBe(17700);
    expect(balance({}, allScope).totalTransactions).toBe(9);
  });

  it('intersects an explicit project filter with the allowed project set', () => {
    create('proj-a', { type: 'income', amount: 100 });
    create('proj-b', { type: 'income', amount: 200 });
    create('proj-c', { type: 'income', amount: 300 });
    expect(balance({ projectId: 'proj-a' }, scopeAB)).toEqual(balance());
    expect(balance({ projectId: 'proj-b' }, scopeAB).totalIncome).toBe(200);
    expect(balance({ projectId: 'proj-b' })).toEqual(ZERO);
    expect(balance({ projectId: 'proj-c' }, scopeAB)).toEqual(ZERO);
    expect(balance({ projectId: 'missing' }, allScope)).toEqual(ZERO);
  });

  it('returns the complete zero summary for empty and malformed scopes without decrypting', () => {
    const row = create('proj-a').transaction;
    db.update(transactions).set({ amountEncrypted: CORRUPT }).where(eq(transactions.id, row.id)).run();
    const malformed: unknown[] = [
      { all: false, projectIds: [] }, { all: false, projectIds: [''] },
      { all: false, projectIds: ['   '] }, { all: false, projectIds: ['x'.repeat(129)] },
      { all: false, projectIds: [123] }, { all: false, projectIds: [null] },
      { all: false, projectIds: ['proj-a', ''] }, { all: false },
      { all: false, projectIds: 'proj-a' }, { all: 'true' }, {}, null, undefined,
    ];
    for (const scope of malformed) {
      expect(repo.getFinancialBalanceInScope({}, scope as TransactionReadScope, KEY, PEPPER)).toEqual(ZERO);
    }
    expect(balance({}, { all: false, projectIds: ['missing'] })).toEqual(ZERO);
  });

  it('excludes deleted rows by default and honors includeDeleted without broadening scope', () => {
    create('proj-a', { type: 'income', amount: 100 });
    const deleted = create('proj-a', { amount: 25 }).transaction;
    const outside = create('proj-b', { type: 'income', amount: 900 }).transaction;
    repo.softDeleteTransaction(deleted.id, KEY);
    repo.softDeleteTransaction(outside.id, KEY);
    expect(balance()).toMatchObject({ totalIncome: 100, totalPaidExpense: 0, totalTransactions: 1 });
    expect(balance({ includeDeleted: true })).toMatchObject({ totalIncome: 100, totalPaidExpense: 25, totalTransactions: 2 });
  });

  it('applies inclusive date bounds to the same scoped aggregate and contributions', () => {
    const startDate = '2024-06-10T00:00:00.000Z';
    const endDate = '2024-06-11T23:59:59.999Z';
    create('proj-a', { type: 'income', amount: 1000, date: '2024-06-09T23:59:59.999Z', party: 'Too early' });
    create('proj-a', { type: 'income', amount: 100, date: startDate, party: 'In range' });
    create('proj-a', { amount: 20, date: endDate, isPaid: false, dueDate: '2024-06-14' });
    create('proj-a', { type: 'income', amount: 2000, date: '2024-06-12T00:00:00.000Z', party: 'Too late' });
    create('proj-b', { type: 'income', amount: 9000, date: startDate, party: 'Outside' });
    expect(balance({ startDate, endDate })).toEqual({
      totalIncome: 100, totalPaidExpense: 0, actualCashInHand: 100,
      totalPendingExpense: 20, overdueDebt: 20, netPositionAfterDue: 80, totalTransactions: 2,
      personContributions: [{ personName: 'In range', directKasaAmount: 100, otoKasaAmount: 0, totalAmount: 100, transactionCount: 1 }],
    });
    expect(balance({ startDate }).totalTransactions).toBe(3);
    expect(balance({ endDate }).totalTransactions).toBe(3);
    expect(balance({ startDate: endDate, endDate: startDate })).toEqual(ZERO);
  });

  it('isolates contribution identities and amounts, preserving payer/party/fallback precedence', () => {
    create('proj-a', { type: 'income', amount: 20, payerPersonName: 'Shared', party: 'Not the payer' });
    create('proj-a', { type: 'income', amount: 10, party: 'Shared' });
    create('proj-a', { type: 'income', amount: 5 });
    create('proj-b', { type: 'income', amount: 700, party: 'Shared' });
    create('proj-b', { type: 'income', amount: 800, payerPersonName: 'Foreign only' });
    create(null, { type: 'income', amount: 900, party: 'Legacy only' });
    expect(balance().personContributions).toEqual([
      { personName: 'Shared', directKasaAmount: 30, otoKasaAmount: 0, totalAmount: 30, transactionCount: 2 },
      { personName: 'Diğer', directKasaAmount: 5, otoKasaAmount: 0, totalAmount: 5, transactionCount: 1 },
    ]);
  });

  it.each(['', '.0', '.00', '.000'])('compares equivalent instants in SQL with %s query fractions and inclusive exact bounds', (fraction) => {
    const rows = ['', '.0', '.00', '.000'].map((storedFraction, index) => create('proj-a', {
      type: 'income', amount: index + 1, date: `2024-06-10T12:00:00${storedFraction}Z`,
    }).transaction);
    const before = create('proj-a', { date: '2024-06-10T11:59:59.999Z' }).transaction;
    const after = create('proj-a', { date: '2024-06-10T12:00:00.001Z' }).transaction;
    const foreign = create('proj-b', { date: '2024-06-10T12:00:00Z' }).transaction;
    for (const row of [before, after, foreign]) {
      db.update(transactions).set({ titleEncrypted: CORRUPT }).where(eq(transactions.id, row.id)).run();
    }
    const instant = `2024-06-10T12:00:00${fraction}Z`;
    const filters: TransactionFilter = { dateComparison: 'instant', startDate: instant, endDate: instant };
    expect(repo.listTransactionsInScope(filters, scopeA, KEY, PEPPER).map(r => r.id).sort()).toEqual(rows.map(r => r.id).sort());
    expect(balance(filters)).toMatchObject({ totalIncome: 10, totalTransactions: 4 });
    // These failures also prove the corrupt fixtures really would be decrypted
    // if the SQL date/project predicates were omitted or broadened.
    expect(() => balance({ ...filters, startDate: '2024-06-10T11:59:59.999Z' })).toThrow();
    expect(() => balance({ ...filters, endDate: '2024-06-10T12:00:00.001Z' })).toThrow();
    expect(() => balance(filters, scopeAB)).toThrow();
  });

  it('keeps adjacent milliseconds distinct and includes equivalent fractional boundaries', () => {
    const rows = ['.099', '.1', '.10', '.100', '.101'].map((fraction, index) => create('proj-a', {
      type: 'income', amount: index + 1, date: `2024-06-10T12:00:00${fraction}Z`,
    }).transaction);
    for (const fraction of ['.1', '.10', '.100']) {
      const instant = `2024-06-10T12:00:00${fraction}Z`;
      const filters: TransactionFilter = { dateComparison: 'instant', startDate: instant, endDate: instant };
      expect(repo.listTransactionsInScope(filters, scopeA, KEY, PEPPER).map(r => r.id).sort()).toEqual(rows.slice(1, 4).map(r => r.id).sort());
      expect(balance(filters)).toMatchObject({ totalIncome: 9, totalTransactions: 3 });
    }
    expect(balance({ dateComparison: 'instant', startDate: rows[0].date, endDate: rows[4].date })).toMatchObject({ totalIncome: 15, totalTransactions: 5 });
    expect(balance({ dateComparison: 'instant', startDate: rows[1].date })).toMatchObject({ totalIncome: 14, totalTransactions: 4 });
    expect(balance({ dateComparison: 'instant', endDate: rows[3].date })).toMatchObject({ totalIncome: 10, totalTransactions: 4 });
    expect(balance({ dateComparison: 'instant', startDate: rows[4].date, endDate: rows[0].date })).toEqual(ZERO);
  });

  it('uses UTC midnight for stored date-only values and includes every last-second spelling through end-of-day', () => {
    const dates = [
      '2024-06-10', '2024-06-10T00:00:00Z', '2024-06-10T00:00:00.0Z',
      '2024-06-10T00:00:00.00Z', '2024-06-10T00:00:00.000Z',
      ...['', '.0', '.00', '.000', '.9', '.99', '.999'].map(f => `2024-06-10T23:59:59${f}Z`),
    ];
    const rows = dates.map(date => create('proj-a', { type: 'income', amount: 1, date }).transaction);
    create('proj-a', { type: 'income', amount: 1000, date: '2024-06-09T23:59:59.999Z' });
    create('proj-a', { type: 'income', amount: 2000, date: '2024-06-11T00:00:00Z' });
    const exactMidnight: TransactionFilter = { dateComparison: 'instant', startDate: '2024-06-10T00:00:00.000Z', endDate: '2024-06-10T00:00:00Z' };
    expect(repo.listTransactionsInScope(exactMidnight, scopeA, KEY, PEPPER).map(r => r.id).sort()).toEqual(rows.slice(0, 5).map(r => r.id).sort());
    expect(balance(exactMidnight)).toMatchObject({ totalIncome: 5, totalTransactions: 5 });
    expect(balance({ dateComparison: 'instant', startDate: '2024-06-10', endDate: '2024-06-10T23:59:59.999Z' })).toMatchObject({ totalIncome: 12, totalTransactions: 12 });
    expect(balance({ dateComparison: 'instant', startDate: '2024-06-10T23:59:59Z', endDate: '2024-06-10T23:59:59.000Z' })).toMatchObject({ totalIncome: 4, totalTransactions: 4 });
    expect(balance({ dateComparison: 'instant', startDate: '2024-06-10T23:59:59.990Z', endDate: '2024-06-10T23:59:59.999Z' })).toMatchObject({ totalIncome: 2, totalTransactions: 2 });
    for (const [fraction, count] of [['.9', 10], ['.99', 11], ['.999', 12]] as const) {
      expect(balance({ dateComparison: 'instant', startDate: '2024-06-10', endDate: `2024-06-10T23:59:59${fraction}Z` })).toMatchObject({ totalIncome: count, totalTransactions: count });
    }
  });

  it('retains lexical date filtering for default list/balance callers and leaves the legacy wrapper unfiltered', () => {
    const rows = ['2024-06-10', ...['', '.0', '.00', '.000'].map(f => `2024-06-10T00:00:00${f}Z`)]
      .map(date => create('proj-a', { type: 'income', amount: 1, date }).transaction);
    const filters = { startDate: '2024-06-10T00:00:00.000Z', endDate: '2024-06-10T00:00:00.000Z' };
    expect(repo.listTransactions(filters, KEY, PEPPER).map(r => r.id)).toEqual([rows[4].id]);
    expect(repo.listTransactionsInScope(filters, scopeA, KEY, PEPPER).map(r => r.id)).toEqual([rows[4].id]);
    expect(balance(filters)).toMatchObject({ totalIncome: 1, totalTransactions: 1 });
    expect(balance({ ...filters, dateComparison: 'instant' })).toMatchObject({ totalIncome: 5, totalTransactions: 5 });
    expect(repo.getFinancialBalance('proj-a', KEY, PEPPER)).toMatchObject({ totalIncome: 5, totalTransactions: 5 });
  });

  it('keeps OTO pairs inside their project and preserves legacy offset counting', () => {
    const pair = create('proj-a', { amount: 75, paymentSource: 'person_out_of_pocket', payerPersonName: 'Allowed payer' });
    create('proj-b', { amount: 900, paymentSource: 'person_out_of_pocket', payerPersonName: 'Foreign payer' });
    create(null, { amount: 800, paymentSource: 'person_out_of_pocket', payerPersonName: 'Legacy payer' });
    expect(pair.transaction.otoKasaTransactionId).toBe(pair.otoKasaTransaction!.id);
    expect(pair.otoKasaTransaction!.otoKasaTransactionId).toBe(pair.transaction.id);
    expect(balance()).toEqual({
      totalIncome: 75, totalPaidExpense: 75, actualCashInHand: 0,
      totalPendingExpense: 0, overdueDebt: 0, netPositionAfterDue: 0, totalTransactions: 2,
      personContributions: [{ personName: 'Allowed payer', directKasaAmount: 0, otoKasaAmount: 75, totalAmount: 75, transactionCount: 1 }],
    });
    repo.softDeleteTransaction(pair.transaction.id, KEY);
    expect(balance()).toEqual(ZERO);
    expect(balance({ includeDeleted: true }).totalTransactions).toBe(2);
  });

  it('preserves legacy baseAmount, status and unpaid-expense calculations without policy fixes', () => {
    create('proj-a', { type: 'income', amount: 25, exchangeRate: 2, status: 'draft' });
    create('proj-a', { amount: 3, exchangeRate: 2, isPaid: true, status: 'rejected' });
    create('proj-a', { amount: 7, isPaid: false, status: 'draft', dueDate: '2024-06-14' });
    create('proj-a', { amount: 9, isPaid: false });
    expect(balance()).toMatchObject({
      totalIncome: 50, totalPaidExpense: 6, actualCashInHand: 44,
      totalPendingExpense: 16, overdueDebt: 7, netPositionAfterDue: 28, totalTransactions: 4,
    });
  });

  it('keeps the legacy wrapper equivalent to all:true, including null-project rows', () => {
    create('proj-a', { type: 'income', amount: 100 });
    create('proj-b', { amount: 30 });
    create(null, { type: 'income', amount: 50, party: 'Legacy contributor' });
    const deleted = create('proj-a', { type: 'income', amount: 900 }).transaction;
    repo.softDeleteTransaction(deleted.id, KEY);
    for (const projectId of [undefined, 'proj-a', 'proj-b', 'missing']) {
      expect(repo.getFinancialBalance(projectId, KEY, PEPPER)).toEqual(balance({ projectId }, allScope));
    }
    expect(repo.getFinancialBalance(undefined, KEY, PEPPER)).toMatchObject({ totalIncome: 150, totalPaidExpense: 30, totalTransactions: 3 });
  });

  it.each([
    'amountEncrypted', 'baseAmountEncrypted', 'titleEncrypted',
    'descriptionEncrypted', 'partyEncrypted', 'customValuesEncrypted',
  ] as const)('never decrypts excluded corrupt %s but throws when the row is included', (field) => {
    create('proj-a', { type: 'income', amount: 100, party: 'Allowed' });
    const foreign = create('proj-b').transaction;
    const legacy = create(null).transaction;
    for (const row of [foreign, legacy]) {
      db.update(transactions).set({ [field]: CORRUPT }).where(eq(transactions.id, row.id)).run();
    }
    expect(balance()).toMatchObject({ totalIncome: 100, totalTransactions: 1 });
    expect(balance({ projectId: 'proj-b' })).toEqual(ZERO);
    expect(() => balance({}, { all: false, projectIds: ['proj-b'] })).toThrow();
    expect(() => balance({}, allScope)).toThrow();
    db.delete(transactions).where(eq(transactions.id, foreign.id)).run();
    expect(() => balance({}, allScope)).toThrow(); // Null-project ciphertext is included only by all:true.
  });

  it('filters deleted and out-of-date corrupt authorized rows before decryption', () => {
    create('proj-a', { type: 'income', amount: 100 });
    const old = create('proj-a', { date: '2024-01-01T00:00:00.000Z' }).transaction;
    const deleted = create('proj-a').transaction;
    repo.softDeleteTransaction(deleted.id, KEY);
    for (const row of [old, deleted]) {
      db.update(transactions).set({ titleEncrypted: CORRUPT }).where(eq(transactions.id, row.id)).run();
    }
    const filters = { startDate: '2024-06-01T00:00:00.000Z' };
    expect(balance(filters)).toMatchObject({ totalIncome: 100, totalTransactions: 1 });
    expect(() => balance({ ...filters, includeDeleted: true })).toThrow();
    expect(() => balance()).toThrow();
  });

  it('reads caller-transaction changes through a tx-bound repository and respects rollback', () => {
    create('proj-a', { type: 'income', amount: 100 });
    const before = balance();
    expect(() => db.transaction((tx) => {
      const txRepo = new TransactionRepository(tx as unknown as CostCoreDatabase);
      create('proj-a', { amount: 25 }, txRepo);
      create('proj-b', { type: 'income', amount: 900 }, txRepo);
      expect(txRepo.getFinancialBalanceInScope({}, scopeA, KEY, PEPPER)).toMatchObject({
        totalIncome: 100, totalPaidExpense: 25, actualCashInHand: 75, totalTransactions: 2,
      });
      expect(txRepo.getFinancialBalanceInScope({}, scopeAB, KEY, PEPPER).totalIncome).toBe(1000);
      throw new Error('synthetic-balance-rollback');
    }, { behavior: 'immediate' })).toThrow('synthetic-balance-rollback');
    expect(balance()).toEqual(before);
    expect(balance({}, scopeAB)).toEqual(before);
    create('proj-a', { amount: 10 });
    expect(balance().actualCashInHand).toBe(90);
  });
});
