import { describe, expect, it } from 'vitest';
import type { Transaction } from '@cost-core/types';
import { computeReportFinance } from '../src/report-finance';

const transaction = (overrides: Record<string, unknown> = {}): Transaction => ({
  type: 'income', amount: 100, baseAmount: 100, currency: 'TRY',
  status: 'approved', isPaid: true, paymentSource: 'company_account',
  categoryId: 'category', date: '2026-01-01', ...overrides,
} as unknown as Transaction);

describe('computeReportFinance', () => {
  it('separates operating results, expense funding and period cash flow', () => {
    const records = [
      transaction(),
      transaction({ type: 'expense', amount: 40 }),
      transaction({ type: 'expense', amount: 10, status: 'pending', isPaid: false }),
      transaction({ type: 'expense', amount: 20, paymentSource: 'person_out_of_pocket' }),
      transaction({ amount: 20, paymentSource: 'person_out_of_pocket' }),
      transaction({ amount: 30, status: 'pending' }),
      transaction({ amount: 50, isPaid: false }),
      transaction({ type: 'transfer', amount: 200 }),
      transaction({ amount: 999999, status: 'draft' }),
      transaction({ amount: 999999, deletedAt: '2026-01-02' }),
    ];
    records.forEach(Object.freeze);
    Object.freeze(records);
    const before = JSON.stringify(records);
    const result = computeReportFinance(records, 'TRY');
    expect(result).toMatchObject({
      baseCurrency: 'TRY', mixedCurrency: false, excludedCurrencies: [],
      totalIncome: 180, totalExpense: 70, netBalance: 110, transactionCount: 6,
      totalPaidExpense: 60, companyPaidExpenseTotal: 40, personFundedExpenseTotal: 20,
      totalPendingExpense: 10, cashFlowNet: 60, otoKasaExcludedTotal: 20, unrecognizedCount: 1,
    });
    expect(result.byCurrency.TRY).toMatchObject({ totalIncome: 180, cashFlowNet: 60 });
    expect(JSON.stringify(records)).toBe(before);
  });

  it('keeps original currencies separate and ignores baseAmount', () => {
    const result = computeReportFinance([transaction({ currency: 'USD', amount: 200, baseAmount: 999999 })], 'TRY');
    expect(result).toMatchObject({ baseCurrency: 'TRY', mixedCurrency: true, excludedCurrencies: ['USD'], totalIncome: 0, netBalance: 0, transactionCount: 0, cashFlowNet: 0 });
    expect(result.byCurrency.USD).toMatchObject({ totalIncome: 200, netBalance: 200, transactionCount: 1, cashFlowNet: 200 });
    const multiple = computeReportFinance([transaction({currency: 'USD'}), transaction({currency: 'EUR'}), transaction()], 'TRY');
    expect(multiple.excludedCurrencies).toEqual(['EUR', 'USD']);
    expect(multiple.totalIncome).toBe(100);
  });

  it('recognizes only accepted statuses and excludes deleted records from counts', () => {
    const statuses = ['approved', 'pending', 'paid', undefined, 'unknown', 'draft', 'pending_approval', 'rejected', 'cancelled'];
    const records = statuses.map(status => transaction({ status, amount: 10 }));
    records.push(transaction({ status: 'unknown', deletedAt: '2026-01-01', amount: 9999 }));
    const result = computeReportFinance(records, 'TRY');
    expect(result).toMatchObject({ totalIncome: 30, transactionCount: 3, unrecognizedCount: 6, cashFlowNet: 20 });
  });

  it('excludes both OTO forms, ignores transfers and distinguishes unpaid personal expenses', () => {
    const result = computeReportFinance([
      transaction({ amount: 12, otoKasaTransactionId: 'linked' }),
      transaction({ amount: 8, paymentSource: 'person_out_of_pocket' }),
      transaction({ type: 'transfer', amount: 1000 }),
      transaction({ type: 'expense', amount: 7, isPaid: false, paymentSource: 'person_out_of_pocket' }),
      transaction({ type: 'expense', amount: 3, status: 'paid', isPaid: false }),
    ], 'TRY');
    expect(result).toMatchObject({ totalIncome: 0, totalExpense: 10, netBalance: -10, transactionCount: 2, otoKasaExcludedTotal: 20, totalPendingExpense: 3, totalPaidExpense: 0, cashFlowNet: 0 });
  });

  it('rounds each original amount to cents and final totals', () => {
    const result = computeReportFinance([
      transaction({ amount: 1.005 }), transaction({ amount: 0.1 }), transaction({ amount: 0.2 }),
      transaction({ type: 'expense', amount: 0.335 }),
    ], 'TRY');
    expect(result).toMatchObject({ totalIncome: 1.31, totalExpense: 0.34, netBalance: 0.97, totalPaidExpense: 0.34, companyPaidExpenseTotal: 0.34, cashFlowNet: 0.97 });
  });
});
