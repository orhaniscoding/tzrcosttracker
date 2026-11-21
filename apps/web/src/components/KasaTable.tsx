import React from "react";
import { useLocale } from "../context/LocaleContext.js";
import type { Transaction } from "@cost-core/types";
import { useTheme } from "../context/ThemeContext.js";
import { computeReportFinance } from "../report-finance.js";

interface KasaTableProps {
  transactions: Transaction[];
  onAddKasaEntry: () => void;
  canMutate?: boolean;
  baseCurrency?: string;
  isLoading?: boolean;
}

const formatAmount = (amount: number, currency: string, locale = "tr-TR") => `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)} ${currency}`;

export const KasaTable: React.FC<KasaTableProps> = ({ transactions, onAddKasaEntry, canMutate = false, baseCurrency, isLoading = false }) => {
  const { settings } = useTheme();
  const { t, intlLocale, language } = useLocale();
  const localize = t;
  const currency = baseCurrency || settings?.baseCurrency || "TRY";
  if (isLoading) return <div role="status">{t('Gelir kayıtları yükleniyor...', 'Loading income records...')}</div>;
  const rawIncome = transactions.filter(t => t.type === "income");
  const totals = computeReportFinance(rawIncome, currency);
  const currencies = [currency, ...totals.excludedCurrencies];
  return (
    <section className="min-w-0 bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-slate-800">{t('Gelir kayıtları ve gerçekleşmiş nakit girişleri', 'Income records and realized cash inflows')}</h2>
            <p className="text-xs text-slate-500 mt-1">{localize("Bu toplam yalnız yüklenen gelir kayıtlarını kapsar; giderleri, açılış bakiyelerini ve güncel cüzdan bakiyelerini içermez. OTO yansımaları nakit girişine eklenmez.", "This total covers loaded income records. It excludes expenses, opening balances, current account balances, and offset entries for personal funds.")}</p>
          </div>
          {canMutate && <button type="button" onClick={() => { if (canMutate && !isLoading) onAddKasaEntry(); }} className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold">{t('Kasaya Nakit Ekle', 'Add Cash')}</button>}
        </div>
        <h3 className="text-xs text-slate-600 mt-4">{localize("Yüklenen kayıtlardaki gerçekleşmiş şirket nakit girişi", "Realized company cash inflows in these records")}</h3>
        <div className="flex flex-wrap gap-3 mt-2">
          {currencies.map(code => <section key={code} aria-label={`${t('Gerçekleşmiş şirket nakit girişi', 'Realized company cash inflow')} ${code}`} className="rounded border border-slate-200 px-3 py-2"><span className="font-bold text-emerald-700">{formatAmount(code === currency ? totals.cashFlowNet : totals.byCurrency[code].cashFlowNet, code, intlLocale)}</span>{code === currency && <span> {code} ({t('baz para birimi', 'base currency')})</span>}</section>)}
        </div>
        <p className="text-xs text-slate-500 mt-2">{rawIncome.length}{localize(" ham gelir kaydı", " income records")}</p>
      </div>
      <div className="overflow-x-auto max-w-full" role="region" aria-label={localize("Gelir kayıtları tablosu", "Income records table")} tabIndex={0}>
        <table className="w-full min-w-[760px] table-fixed text-left text-xs border-collapse">
          <thead><tr className="border-b bg-slate-100"><th scope="col" className="p-3 w-28">{localize("Tarih", "Date")}</th><th scope="col" className="p-3 w-36">{localize("Ekleyen Kişi / Ortak", "Contributor / Partner")}</th><th scope="col" className="p-3">{localize("Açıklama / Kaynak", "Description / Source")}</th><th scope="col" className="p-3 w-40">{localize("Giriş Türü", "Income type")}</th><th scope="col" className="p-3 w-36">{localize("Durum / Ödeme", "Status / Payment")}</th><th scope="col" className="p-3 w-32 text-right">{localize("Tutar", "Amount")}</th></tr></thead>
          <tbody className="divide-y divide-slate-200">
            {rawIncome.length === 0 ? <tr><td colSpan={6} className="p-8 text-center text-slate-500">{localize("Henüz gelir kaydı bulunmuyor.", "There are no income records yet.")}</td></tr> : rawIncome.map(t => (
              <tr key={t.id} className="align-top">
                <td className="p-3">{t.date.split("T")[0]}</td>
                <td className="p-3 break-words">{t.payerPersonName || t.party || localize("Diğer", "Other")}</td>
                <td className="p-3 break-words"><div>{t.title}</div>{language === "tr" && t.currency === "TRY" && t.amountInWords && <div className="text-slate-500">{t.amountInWords}</div>}</td>
                <td className="p-3 break-words">{t.otoKasaTransactionId || t.paymentSource === "person_out_of_pocket" ? localize("Şahıs finansmanı — OTO yansıması", "Personal funds offset") : localize("Gelir kaydı", "Income record")}</td>
                <td className="p-3 break-words"><div>{localize("Durum: ", "Status: ")}{t.status}</div><div>{localize("Ödeme: ", "Payment: ")}{t.isPaid === false ? localize("Ödenmemiş", "Unpaid") : t.isPaid === true ? localize("Ödenmiş", "Paid") : localize("Belirtilmemiş", "Unspecified")}</div>{t.deletedAt && <div>{localize("Silinmiş", "Deleted")}</div>}</td>
                <td className="p-3 text-right whitespace-nowrap">{formatAmount(t.amount, t.currency, intlLocale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
