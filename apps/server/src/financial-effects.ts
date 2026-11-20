export class DomainError extends Error { statusCode: number; constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; } }
export const GENERIC = "Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.";
export function money(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }
export function sanitizeMoney(n: any, label = "Tutar"): number {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new DomainError(400, label + " gecersiz.");
  const cents = Math.round(n * 100);
  if (!Number.isSafeInteger(cents)) throw new DomainError(400, label + " guvenli sinir disinda.");
  if (Math.abs(n * 100 - cents) > 1e-7) throw new DomainError(400, label + " en fazla 2 ondalik basamak icerebilir.");
  return cents / 100;
}
export function effectOf(tx: any, includeDeleted = false): { accountId: string; delta: number } | null {
  if (!tx) return null;
  if (tx.deletedAt && !includeDeleted) return null;
  if (tx.paymentSource === "person_out_of_pocket") return null;
  const noCash: string[] = ["draft", "pending_approval", "rejected", "cancelled"];
  if (noCash.includes(tx.status)) return null;
  if (tx.type === "expense") {
    if (!tx.isPaid || !tx.accountFromId) return null;
    return { accountId: tx.accountFromId, delta: -money(tx.amount) };
  }
  if (tx.type === "income") {
    if (tx.otoKasaTransactionId) return null;
    if (!tx.accountToId) return null;
    if (tx.isPaid === false) return null;
    if (tx.status === "pending") return null;
    return { accountId: tx.accountToId, delta: money(tx.amount) };
  }
  return null;
}
export function isRecognizedStatus(status: unknown): boolean {
  return status === 'approved' || status === 'pending' || status === 'paid';
}
export function isOtoKasaIncome(tx: any): boolean {
  return tx.type === 'income' && (Boolean(tx.otoKasaTransactionId) || tx.paymentSource === 'person_out_of_pocket');
}
// Native-currency company cash only. Wallet linkage is deliberately independent:
// reports use this delta OR the already-adjusted wallet balance, never both.
export function cashEffectOf(tx: any): number {
  if (!tx || tx.deletedAt || !isRecognizedStatus(tx.status) || tx.paymentSource === 'person_out_of_pocket') return 0;
  if (tx.type === 'expense' && tx.isPaid) return -money(tx.amount);
  if (tx.type === 'income' && !isOtoKasaIncome(tx) && tx.isPaid !== false && tx.status !== 'pending') return money(tx.amount);
  return 0;
}
export function snapshot(tx: any): any {
  if (!tx) return null;
  return { id: tx.id, type: tx.type, amount: tx.amount, currency: tx.currency, exchangeRate: tx.exchangeRate, baseAmount: tx.baseAmount, accountFromId: tx.accountFromId ?? null, accountToId: tx.accountToId ?? null, paymentSource: tx.paymentSource, payerPersonName: tx.payerPersonName ?? null, isPaid: tx.isPaid, status: tx.status, categoryId: tx.categoryId, projectId: tx.projectId ?? null, date: tx.date, title: tx.title, otoKasaTransactionId: tx.otoKasaTransactionId ?? null, deletedAt: tx.deletedAt ?? null };
}
export function accountSnapshot(a: any): any {
  if (!a) return null;
  return { id: a.id, name: a.name, type: a.type, currency: a.currency, balance: a.balance, isActive: a.isActive, projectId: a.projectId ?? null };
}
