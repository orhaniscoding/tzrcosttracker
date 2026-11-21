import type { Transaction } from './index.js';

type FinancialRow = Pick<Transaction, 'type' | 'status' | 'amount' | 'paymentSource' | 'isPaid'>
  & Partial<Pick<Transaction, 'deletedAt' | 'otoKasaTransactionId'>>;

export function roundLedgerMoney(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function isRecognizedStatus(status: unknown): boolean {
  return status === 'approved' || status === 'pending' || status === 'paid';
}

export function isOtoKasaIncome(row: FinancialRow): boolean {
  return row.type === 'income' && (Boolean(row.otoKasaTransactionId) || row.paymentSource === 'person_out_of_pocket');
}

/** The company cash delta in a row's own currency. Wallet balance is separate. */
export function cashEffectOf(row: FinancialRow): number {
  if (row.deletedAt || !isRecognizedStatus(row.status) || row.paymentSource === 'person_out_of_pocket') return 0;
  if (row.type === 'expense' && row.isPaid) return -roundLedgerMoney(row.amount);
  if (row.type === 'income' && !isOtoKasaIncome(row) && row.isPaid !== false && row.status !== 'pending') return roundLedgerMoney(row.amount);
  return 0;
}
