import { moneyFromMinor, moneyToMinor, type MoneyPolicy, type MoneyV1 } from '@cost-core/types';

export type ExactFinancialInput = Readonly<{
  type: 'expense' | 'income' | 'transfer';
  status: 'draft' | 'pending_approval' | 'pending' | 'approved' | 'paid' | 'rejected' | 'cancelled';
  paymentSource: 'company_account' | 'person_out_of_pocket';
  isPaid: boolean;
  currency: string;
  amount: MoneyV1;
  accountFromId: string | null;
  accountToId: string | null;
  otoKasaTransactionId: string | null;
  deletedAt: string | null;
}>;

export type ExactAccountEffect = Readonly<{ accountId: string; delta: MoneyV1 }>;

const required = ['type', 'status', 'paymentSource', 'isPaid', 'currency', 'amount', 'accountFromId', 'accountToId', 'otoKasaTransactionId', 'deletedAt'] as const;

function invalid(): never {
  throw new Error('Invalid exact financial effect');
}

function validId(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length <= 128 && value.trim().length > 0 && Buffer.from(value, 'utf8').toString('utf8') === value);
}

function validate(tx: ExactFinancialInput, policy: MoneyPolicy): bigint {
  if (typeof tx !== 'object' || tx === null || Array.isArray(tx)) return invalid();
  if (required.some(key => !Object.prototype.hasOwnProperty.call(tx, key))) return invalid();
  if (tx.type !== 'expense' && tx.type !== 'income' && tx.type !== 'transfer') return invalid();
  if (tx.status !== 'draft' && tx.status !== 'pending_approval' && tx.status !== 'pending' && tx.status !== 'approved' && tx.status !== 'paid' && tx.status !== 'rejected' && tx.status !== 'cancelled') return invalid();
  if (tx.paymentSource !== 'company_account' && tx.paymentSource !== 'person_out_of_pocket') return invalid();
  if (typeof tx.isPaid !== 'boolean') return invalid();
  if (!validId(tx.accountFromId) || !validId(tx.accountToId) || !validId(tx.otoKasaTransactionId)) return invalid();
  if (tx.deletedAt !== null && (typeof tx.deletedAt !== 'string' || tx.deletedAt.length === 0)) return invalid();
  return moneyToMinor(tx.amount, tx.currency, policy);
}

function eligible(tx: ExactFinancialInput): boolean {
  if (tx.status !== 'approved' && tx.status !== 'pending' && tx.status !== 'paid') return false;
  if (tx.paymentSource !== 'company_account' || !tx.isPaid) return false;
  if (tx.type === 'expense') return true;
  return tx.type === 'income' && tx.status !== 'pending' && tx.otoKasaTransactionId === null;
}

export function exactAccountEffect(tx: ExactFinancialInput | null, policy: MoneyPolicy, includeDeleted?: boolean): ExactAccountEffect | null {
  try {
    if (includeDeleted !== undefined && typeof includeDeleted !== 'boolean') return invalid();
    if (tx === null) return null;
    const minor = validate(tx, policy);
    if ((tx.deletedAt !== null && !includeDeleted) || !eligible(tx)) return null;
    const accountId = tx.type === 'expense' ? tx.accountFromId : tx.accountToId;
    if (accountId === null) return null;
    return { accountId, delta: moneyFromMinor(tx.type === 'expense' ? -minor : minor, tx.currency, policy) };
  } catch {
    return invalid();
  }
}

export function exactCashEffect(tx: ExactFinancialInput | null, policy: MoneyPolicy): MoneyV1 | null {
  try {
    if (tx === null) return null;
    const minor = validate(tx, policy);
    if (tx.deletedAt !== null || !eligible(tx)) return null;
    return moneyFromMinor(tx.type === 'expense' ? -minor : minor, tx.currency, policy);
  } catch {
    return invalid();
  }
}
