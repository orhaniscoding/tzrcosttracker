import { eq } from 'drizzle-orm';
import { whiteLabelSettings } from '@cost-core/database';
import type { Account, Transaction } from '@cost-core/types';
import { cashEffectOf, effectOf, isOtoKasaIncome, isRecognizedStatus, money } from './financial-effects.js';

export function readBaseCurrencyInTx(tx: any): string {
  return tx.select({ baseCurrency: whiteLabelSettings.baseCurrency }).from(whiteLabelSettings)
    .where(eq(whiteLabelSettings.id, 'global')).get()?.baseCurrency || 'TRY';
}

function currencyMetadata(currencies: string[], baseCurrency: string) {
  // Any non-base currency (even a single one) means the base scalars are partial.
  const excludedCurrencies = currencies.filter(c => c !== baseCurrency).sort();
  return { baseCurrency, mixedCurrency: excludedCurrencies.length > 0, excludedCurrencies };
}
function currenciesOf(accounts: readonly Account[], transactions: readonly Transaction[]) {
  return [...new Set([...accounts.map(a => a.currency), ...transactions.map(t => t.currency)])].sort();
}
const recognized = (t: Transaction) => !t.deletedAt && isRecognizedStatus(t.status);

function liquidityFor(all: readonly Account[]) {
  let totalCashBase = 0, totalBankBase = 0, totalOtherBase = 0;
  let totalCreditCardDebtBase = 0, totalCreditCardCreditBase = 0;
  const active = all.filter(a => a.isActive !== false);
  for (const a of active) {
    if (a.type === 'cash') totalCashBase += a.balance;
    else if (a.type === 'bank' || a.type === 'pos') totalBankBase += a.balance;
    else if (a.type === 'other') totalOtherBase += a.balance;
    else if (a.type === 'credit_card') {
      totalCreditCardDebtBase += Math.max(-a.balance, 0);
      totalCreditCardCreditBase += Math.max(a.balance, 0);
    }
  }
  totalCashBase = money(totalCashBase); totalBankBase = money(totalBankBase); totalOtherBase = money(totalOtherBase);
  totalCreditCardDebtBase = money(totalCreditCardDebtBase); totalCreditCardCreditBase = money(totalCreditCardCreditBase);
  const totalLiquidAssets = money(totalCashBase + totalBankBase + totalOtherBase);
  return { totalCashBase, totalBankBase, totalOtherBase, totalLiquidAssets, totalCreditCardDebtBase, totalCreditCardCreditBase,
    netLiquidityAfterCC: money(totalLiquidAssets + totalCreditCardCreditBase - totalCreditCardDebtBase),
    accountCount: all.length, activeAccountCount: active.length, inactiveAccountCount: all.length - active.length,
    // Inactive wallets are excluded from liquidity, but their money must stay visible.
    inactiveWalletBalanceBase: money(all.filter(a => a.isActive === false).reduce((sum, a) => sum + a.balance, 0)) };
}

export function computeLiquiditySummary({ accounts, baseCurrency }: { accounts: readonly Account[]; baseCurrency: string }) {
  const currencies = currenciesOf(accounts, []);
  const byCurrency = Object.fromEntries(currencies.map(c => [c, liquidityFor(accounts.filter(a => a.currency === c))]));
  const base = liquidityFor(accounts.filter(a => a.currency === baseCurrency));
  return { ...base, accountCount: accounts.length, activeAccountCount: accounts.filter(a => a.isActive !== false).length,
    inactiveAccountCount: accounts.filter(a => a.isActive === false).length, ...currencyMetadata(currencies, baseCurrency), byCurrency };
}

function balanceFor(accounts: readonly Account[], transactions: readonly Transaction[], todayStr: string, isPeriodFiltered: boolean) {
  const liquid = liquidityFor(accounts);
  const scopedAccountIds = new Set(accounts.map(a => a.id));
  let totalIncome = 0, totalPaidExpense = 0, companyPaidExpenseTotal = 0, personFundedExpenseTotal = 0;
  let totalPendingExpense = 0, overdueDebt = 0, totalTransactions = 0, unallocatedCashTotal = 0, periodCash = 0;
  let crossScopeWalletNetTotal = 0;
  const people = new Map<string, { personName: string; directKasaAmount: number; otoKasaAmount: number; totalAmount: number; transactionCount: number }>();
  for (const tx of transactions.filter(recognized)) {
    const amount = money(tx.amount), cash = cashEffectOf(tx);
    const effect = effectOf(tx);
    periodCash += cash;
    // Strictly disjoint from walletLinked (effectOf !== null). Do not substitute
    // wallet presence in the scope: an out-of-scope/inactive wallet is NOT cashless.
    if (effect === null && cash !== 0) unallocatedCashTotal += cash;
    // Wallet money that moved outside the requested wallet scope (e.g. a site expense
    // paid from a global wallet). Never merged into cash to avoid double counting.
    if (!isPeriodFiltered && effect !== null && !scopedAccountIds.has(effect.accountId)) crossScopeWalletNetTotal += effect.delta;
    if (!isOtoKasaIncome(tx) && tx.type !== 'transfer') totalTransactions++;
    if (tx.type === 'income') {
      const oto = isOtoKasaIncome(tx);
      if (!oto) totalIncome += amount;
      // Person contributions only count realized person money: an unpaid or pending
      // direct income and an unpaid Oto-Kasa reflection are not contributions yet.
      const payable = oto ? tx.isPaid !== false : tx.isPaid !== false && tx.status !== 'pending';
      if (payable) {
        const personName = tx.payerPersonName || tx.party || 'Diğer';
        const p = people.get(personName) || { personName, directKasaAmount: 0, otoKasaAmount: 0, totalAmount: 0, transactionCount: 0 };
        if (oto) p.otoKasaAmount = money(p.otoKasaAmount + amount);
        else p.directKasaAmount = money(p.directKasaAmount + amount);
        p.totalAmount = money(p.directKasaAmount + p.otoKasaAmount); p.transactionCount++;
        people.set(personName, p);
      }
    } else if (tx.type === 'expense') {
      if (tx.isPaid) {
        totalPaidExpense += amount;
        if (tx.paymentSource === 'person_out_of_pocket') personFundedExpenseTotal += amount;
        else companyPaidExpenseTotal += amount;
      } else if (tx.paymentSource !== 'person_out_of_pocket') {
        totalPendingExpense += amount;
        if (tx.dueDate && tx.dueDate.slice(0, 10) <= todayStr) overdueDebt += amount;
      }
    }
  }
  const walletBalanceTotal = liquid.totalLiquidAssets;
  const ccDebt = liquid.totalCreditCardDebtBase, ccCredit = liquid.totalCreditCardCreditBase;
  unallocatedCashTotal = money(unallocatedCashTotal);
  const actualCashInHand = money(isPeriodFiltered ? periodCash : walletBalanceTotal + unallocatedCashTotal - ccDebt + ccCredit);
  return { totalIncome: money(totalIncome), totalPaidExpense: money(totalPaidExpense), companyPaidExpenseTotal: money(companyPaidExpenseTotal),
    personFundedExpenseTotal: money(personFundedExpenseTotal), totalPendingExpense: money(totalPendingExpense), overdueDebt: money(overdueDebt),
    actualCashInHand, netPositionAfterDue: money(actualCashInHand - totalPendingExpense), totalTransactions,
    personContributions: [...people.values()].sort((a, b) => b.totalAmount - a.totalAmount), walletBalanceTotal, unallocatedCashTotal, ccDebt, ccCredit,
    crossScopeWalletNetTotal: money(isPeriodFiltered ? 0 : crossScopeWalletNetTotal),
    inactiveAccountCount: liquid.inactiveAccountCount, inactiveWalletBalanceTotal: liquid.inactiveWalletBalanceBase,
    excludedDraftOrRejectedCount: transactions.filter(t => !t.deletedAt && !isRecognizedStatus(t.status)).length,
    cashScopeMode: isPeriodFiltered ? 'filtered_period' as const : 'current' as const };
}

export function computeBalanceReport({ accounts, transactions, baseCurrency, todayStr, isPeriodFiltered }: {
  accounts: readonly Account[]; transactions: readonly Transaction[]; baseCurrency: string; todayStr: string; isPeriodFiltered: boolean;
}) {
  const currencies = currenciesOf(accounts, transactions);
  const forCurrency = (c: string) => balanceFor(accounts.filter(a => a.currency === c), transactions.filter(t => t.currency === c), todayStr, isPeriodFiltered);
  return { ...forCurrency(baseCurrency), ...currencyMetadata(currencies, baseCurrency), byCurrency: Object.fromEntries(currencies.map(c => [c, forCurrency(c)])) };
}

function summaryFor(transactions: readonly Transaction[], categoryMap: ReadonlyMap<string, string>) {
  let totalIncome = 0, totalExpense = 0, transactionCount = 0, otoKasaExcludedTotal = 0, unrecognizedCount = 0;
  const categories = new Map<string, { name: string; amount: number }>();
  for (const tx of transactions) {
    if (tx.deletedAt) continue;
    if (!isRecognizedStatus(tx.status)) { unrecognizedCount++; continue; }
    const amount = money(tx.amount);
    if (isOtoKasaIncome(tx)) { otoKasaExcludedTotal += amount; continue; }
    if (tx.type === 'transfer') continue;
    transactionCount++;
    if (tx.type === 'income') totalIncome += amount;
    else if (tx.type === 'expense') {
      totalExpense += amount;
      const cat = categories.get(tx.categoryId) || { name: categoryMap.get(tx.categoryId) || 'Diğer', amount: 0 };
      cat.amount = money(cat.amount + amount); categories.set(tx.categoryId, cat);
    }
  }
  return { totalIncome: money(totalIncome), totalExpense: money(totalExpense), netBalance: money(totalIncome - totalExpense), transactionCount,
    categoryBreakdown: [...categories.values()], otoKasaExcludedTotal: money(otoKasaExcludedTotal), unrecognizedCount };
}

export function computeSummaryReport({ transactions, categoryMap, baseCurrency }: {
  transactions: readonly Transaction[]; categoryMap: ReadonlyMap<string, string>; baseCurrency: string;
}) {
  const currencies = currenciesOf([], transactions);
  const forCurrency = (c: string) => summaryFor(transactions.filter(t => t.currency === c), categoryMap);
  return { ...forCurrency(baseCurrency), ...currencyMetadata(currencies, baseCurrency), byCurrency: Object.fromEntries(currencies.map(c => [c, forCurrency(c)])) };
}
