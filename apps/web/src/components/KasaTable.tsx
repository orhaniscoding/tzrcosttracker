import React from "react";
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

const formatAmount = (amount: number, currency: string) => `${new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)} ${currency}`;

export const KasaTable: React.FC<KasaTableProps> = ({ transactions, onAddKasaEntry, canMutate = false, baseCurrency, isLoading = false }) => {
  const { settings } = useTheme();
  const currency = baseCurrency || settings?.baseCurrency || "TRY";
  if (isLoading) return <div role="status">Gelir kayıtları yükleniyor...</div>;
  const rawIncome = transactions.filter(t => t.type === "income");
  const totals = computeReportFinance(rawIncome, currency);
  const currencies = [currency, ...totals.excludedCurrencies];
  return (
    <section className="min-w-0 bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-slate-800">Gelir kayıtları ve gerçekleşmiş nakit girişleri</h2>
            <p className="text-xs text-slate-500 mt-1">Bu toplam yalnız yüklenen gelir kayıtlarını kapsar; giderleri, açılış bakiyelerini ve güncel cüzdan bakiyelerini içermez. OTO yansımaları nakit girişine eklenmez.</p>
          </div>
          {canMutate && <button type="button" onClick={() => { if (canMutate && !isLoading) onAddKasaEntry(); }} className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-xs font-semibold">Kasaya Nakit Ekle</button>}
        </div>
        <h3 className="text-xs text-slate-600 mt-4">Yüklenen kayıtlardaki gerçekleşmiş şirket nakit girişi</h3>
        <div className="flex flex-wrap gap-3 mt-2">
          {currencies.map(code => <section key={code} aria-label={`Gerçekleşmiş şirket nakit girişi ${code}`} className="rounded border border-slate-200 px-3 py-2"><span className="font-bold text-emerald-700">{formatAmount(code === currency ? totals.cashFlowNet : totals.byCurrency[code].cashFlowNet, code)}</span>{code === currency && <span> {code} (baz para birimi)</span>}</section>)}
        </div>
        <p className="text-xs text-slate-500 mt-2">{rawIncome.length} ham gelir kaydı</p>
      </div>
      <div className="overflow-x-auto max-w-full" role="region" aria-label="Gelir kayıtları tablosu" tabIndex={0}>
        <table className="w-full min-w-[760px] table-fixed text-left text-xs border-collapse">
          <thead><tr className="border-b bg-slate-100"><th scope="col" className="p-3 w-28">Tarih</th><th scope="col" className="p-3 w-36">Ekleyen Kişi / Ortak</th><th scope="col" className="p-3">Açıklama / Kaynak</th><th scope="col" className="p-3 w-40">Giriş Türü</th><th scope="col" className="p-3 w-36">Durum / Ödeme</th><th scope="col" className="p-3 w-32 text-right">Tutar</th></tr></thead>
          <tbody className="divide-y divide-slate-200">
            {rawIncome.length === 0 ? <tr><td colSpan={6} className="p-8 text-center text-slate-500">Henüz gelir kaydı bulunmuyor.</td></tr> : rawIncome.map(t => (
              <tr key={t.id} className="align-top">
                <td className="p-3">{t.date.split("T")[0]}</td>
                <td className="p-3 break-words">{t.payerPersonName || t.party || "Diğer"}</td>
                <td className="p-3 break-words"><div>{t.title}</div>{t.currency === "TRY" && t.amountInWords && <div className="text-slate-500">{t.amountInWords}</div>}</td>
                <td className="p-3 break-words">{t.otoKasaTransactionId || t.paymentSource === "person_out_of_pocket" ? "Şahıs finansmanı — OTO yansıması" : "Gelir kaydı"}</td>
                <td className="p-3 break-words"><div>Durum: {t.status}</div><div>Ödeme: {t.isPaid === false ? "Ödenmemiş" : t.isPaid === true ? "Ödenmiş" : "Belirtilmemiş"}</div>{t.deletedAt && <div>Silinmiş</div>}</td>
                <td className="p-3 text-right whitespace-nowrap">{formatAmount(t.amount, t.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
