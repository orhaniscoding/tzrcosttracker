import type { Transaction } from '@cost-core/types';

export type CurrencyReportTotals = {
  totalIncome: number;
  totalExpense: number;
  netBalance: number;
  transactionCount: number;
  totalPaidExpense: number;
  companyPaidExpenseTotal: number;
  personFundedExpenseTotal: number;
  totalPendingExpense: number;
  cashFlowNet: number;
  otoKasaExcludedTotal: number;
  unrecognizedCount: number;
};

const money = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

function emptyTotals(): CurrencyReportTotals {
  return { totalIncome: 0, totalExpense: 0, netBalance: 0, transactionCount: 0, totalPaidExpense: 0, companyPaidExpenseTotal: 0, personFundedExpenseTotal: 0, totalPendingExpense: 0, cashFlowNet: 0, otoKasaExcludedTotal: 0, unrecognizedCount: 0 };
}

function summarize(transactions: readonly Transaction[]): CurrencyReportTotals {
  const totals = emptyTotals();
  for (const t of transactions) {
    if (t.deletedAt) continue;
    if (t.status !== 'approved' && t.status !== 'pending' && t.status !== 'paid') {
      totals.unrecognizedCount++;
      continue;
    }
    const amount = money(t.amount);
    const person = t.paymentSource === 'person_out_of_pocket';
    const otoIncome = t.type === 'income' && (Boolean(t.otoKasaTransactionId) || person);
    if (otoIncome) {
      totals.otoKasaExcludedTotal += amount;
      continue;
    }
    if (t.type === 'transfer') continue;
    if (t.type === 'income') {
      totals.transactionCount++;
      totals.totalIncome += amount;
      if (!person && t.isPaid !== false && t.status !== 'pending') totals.cashFlowNet += amount;
    } else if (t.type === 'expense') {
      totals.transactionCount++;
      totals.totalExpense += amount;
      if (t.isPaid) {
        totals.totalPaidExpense += amount;
        if (person) totals.personFundedExpenseTotal += amount;
        else {
          totals.companyPaidExpenseTotal += amount;
          totals.cashFlowNet -= amount;
        }
      } else if (!person) totals.totalPendingExpense += amount;
    }
  }
  totals.netBalance = money(totals.totalIncome - totals.totalExpense);
  totals.totalIncome = money(totals.totalIncome);
  totals.totalExpense = money(totals.totalExpense);
  totals.totalPaidExpense = money(totals.totalPaidExpense);
  totals.companyPaidExpenseTotal = money(totals.companyPaidExpenseTotal);
  totals.personFundedExpenseTotal = money(totals.personFundedExpenseTotal);
  totals.totalPendingExpense = money(totals.totalPendingExpense);
  totals.cashFlowNet = money(totals.cashFlowNet);
  totals.otoKasaExcludedTotal = money(totals.otoKasaExcludedTotal);
  return totals;
}

/** Cash flow is for the supplied period, not an account or wallet balance. */
export function computeReportFinance(transactions: readonly Transaction[], baseCurrency: string) {
  const currencies = Array.from(new Set(transactions.map(t => t.currency))).sort();
  const excludedCurrencies = currencies.filter(currency => currency !== baseCurrency);
  const byCurrency: Record<string, CurrencyReportTotals> = Object.create(null);
  for (const currency of currencies) {
    byCurrency[currency] = summarize(transactions.filter(t => t.currency === currency));
  }
  const baseTotals = byCurrency[baseCurrency] ?? emptyTotals();
  return { ...baseTotals, baseCurrency, mixedCurrency: excludedCurrencies.length > 0, excludedCurrencies, byCurrency };
}
