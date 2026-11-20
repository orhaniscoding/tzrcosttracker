export type EditPaymentSource = "company_account" | "person_out_of_pocket";
export interface TransactionEditOriginal {
  type?: string | null; status?: string | null; isPaid?: boolean | null;
  paymentSource?: string | null; accountFromId?: string | null;
  accountToId?: string | null; otoKasaTransactionId?: string | null;
  [key: string]: unknown;
}
export interface TransactionEditForm {
  date: string; title: string; amount: number; currency: string;
  categoryId: string; subcategoryId?: string | null;
  party?: string | null; description?: string | null;
  paymentSource: EditPaymentSource; payerPersonName?: string | null;
  paymentMethod: string; isPaid: boolean; dueDate?: string | null;
  accountId?: string | null; accountCurrency?: string | null;
}
export type TransactionEditResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string; readonly?: boolean };
const BLOCKED_PAID_STATUSES = new Set(["draft", "pending_approval", "rejected", "cancelled"]);
export function readOnlyEditReason(original: TransactionEditOriginal): string | null {
  if (original.type === "transfer") return "Bu transfer kaydi yalnizca goruntulenebilir; duzenleme yapilamaz.";
  if (original.type === "income" && original.otoKasaTransactionId) return "Bu kayit, cebinden odemeye bagli Oto-Kasa geliridir. Ana gider kaydini duzenleyin.";
  return null;
}
export function initialAccountId(original: TransactionEditOriginal): string {
  if (original.paymentSource && original.paymentSource !== "company_account") return "";
  if (original.type === "expense") return original.accountFromId || "";
  if (original.type === "income") return original.accountToId || "";
  return "";
}
export function buildTransactionEditPayload(original: TransactionEditOriginal, form: TransactionEditForm): TransactionEditResult {
  const readonly = readOnlyEditReason(original);
  if (readonly) return { ok: false, error: readonly, readonly: true };
  const wantsPaid = form.isPaid === true; const wasPaid = original.isPaid === true;
  if (wantsPaid !== wasPaid && wantsPaid && BLOCKED_PAID_STATUSES.has(String(original.status || ""))) {
    return { ok: false, error: "Bu durumdaki kayit odendi olarak isaretlenemez (taslak/onay bekleyen/reddedilen/iptal). Baslik gibi diger duzenlemeler yapilabilir." };
  }
  const accountId = form.accountId ? String(form.accountId) : null;
  if (form.paymentSource === "company_account" && accountId && form.accountCurrency && form.accountCurrency !== form.currency) {
    return { ok: false, error: "Secilen cuzdanin para birimi islem para birimiyle uyusmuyor." };
  }
  const payload: Record<string, unknown> = {
    date: form.date, title: form.title, amount: form.amount, currency: form.currency,
    categoryId: form.categoryId, subcategoryId: form.subcategoryId || null,
    party: form.party || null, description: form.description || null,
    paymentSource: form.paymentSource,
    payerPersonName: form.paymentSource === "person_out_of_pocket" ? (form.payerPersonName || null) : null,
    paymentMethod: form.paymentMethod,
    dueDate: !form.isPaid && form.dueDate ? form.dueDate : null,
  };
  if (form.paymentSource === "person_out_of_pocket") { payload.accountFromId = null; payload.accountToId = null; }
  else if (original.type === "income") { payload.accountToId = accountId; payload.accountFromId = null; }
  else { payload.accountFromId = accountId; payload.accountToId = null; }
  if (wantsPaid !== wasPaid) payload.isPaid = form.isPaid;
  return { ok: true, payload };
}
