import React, { useRef, useState } from "react";
import { useLocale } from "../context/LocaleContext.js";
import { X, Check, Wallet } from "lucide-react";
import { useTheme } from "../context/ThemeContext.js";

interface AddKasaModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (data: any) => Promise<void>;
  categories: any[];
  baseCurrency?: string;
}

const validCurrency = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/.test(value);
const validCategory = (category: any) => category && typeof category.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(category.id) && typeof category.name === "string" && category.name.trim().length > 0;

export const AddKasaModal: React.FC<AddKasaModalProps> = ({ isOpen, onClose, onAdd, categories, baseCurrency }) => {
  const { settings } = useTheme();
  const { t } = useLocale();
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [personName, setPersonName] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [draftCurrency, setDraftCurrency] = useState<string | undefined>(baseCurrency);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const latestBase = useRef(baseCurrency);
  latestBase.current = baseCurrency;
  const currentBase = validCurrency(baseCurrency) ? baseCurrency : undefined;
  const displayedCurrency = amount !== "" ? draftCurrency : currentBase;
  const currencyChanged = amount !== "" && (!currentBase || draftCurrency !== currentBase);
  const options = Array.isArray(categories) ? categories.filter(validCategory) : [];
  const categoryValid = options.some(category => category.id === categoryId);
  const parsedAmount = Number(amount);
  const amountValid = amount.trim() !== "" && Number.isFinite(parsedAmount) && parsedAmount > 0;
  const dateValid = date.trim() !== "" && Number.isFinite(new Date(date).getTime());
  const canSubmit = !!currentBase && !currencyChanged && categoryValid && amountValid && dateValid && personName.trim() !== "" && !isSubmitting;

  if (!isOpen) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (locked.current) return;
    if (!canSubmit) { setError(t("Lütfen geçerli tarih, kişi, tutar, kategori ve para birimi girin.", "Enter a valid date, person, amount, category, and currency.")); return; }
    locked.current = true;
    setIsSubmitting(true);
    setError("");
    try {
      await onAdd({
        type: "income",
        date: new Date(date).toISOString(),
        amount: parsedAmount,
        currency: currentBase,
        categoryId,
        title: `Kasa Girişi (${personName})`,
        description: description || `Doğrudan Kasa Girişi [${personName}]`,
        party: personName,
        payerPersonName: personName,
        paymentSource: "company_account",
        paymentMethod: "Banka",
        isPaid: true,
      });
      setPersonName("");
      setAmount("");
      setDescription("");
      setCategoryId("");
      setDraftCurrency(latestBase.current);
      onClose();
    } catch {
      setError(t("Kasa girişi kaydedilemedi. Lütfen tekrar deneyin.", "Could not save the cash entry. Please try again."));
    } finally {
      locked.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md max-h-full overflow-y-auto shadow-2xl flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2"><Wallet className="h-4 w-4 text-emerald-600" /><span>{t("Kasaya Yeni Nakit Girişi Ekle", "Add Cash Entry")}</span></h3>
          <button type="button" aria-label={t("Kapat", "Close")} onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200"><X className="h-5 w-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs text-slate-700">
          <div><label htmlFor="kasa-date" className="block text-slate-600 font-medium mb-1">{t("Tarih", "Date")} *</label><input id="kasa-date" type="date" value={date} onChange={e => setDate(e.target.value)} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900" required /></div>
          <div><label htmlFor="kasa-person" className="block text-slate-600 font-medium mb-1">{t("Kasaya Parayı Koyan Kişi / Ortak", "Person / Partner Funding the Cash Account")} *</label><input id="kasa-person" type="text" placeholder={t("Örn: Yılmaz Sağır", "e.g. Jane Doe")} value={personName} onChange={e => setPersonName(e.target.value)} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-semibold" required /></div>
          <div><label htmlFor="kasa-amount" className="block text-slate-600 font-medium mb-1">Tutar ({displayedCurrency || "para birimi bilinmiyor"}) *</label><input id="kasa-amount" type="number" step="0.01" placeholder="0.00" value={amount} onChange={e => { const value = e.target.value; if (value === "" || amount === "") setDraftCurrency(currentBase); setAmount(value); }} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-bold font-mono text-right" required /></div>
          <div><span className="block text-slate-600 font-medium mb-1">{t("Para birimi", "Currency")}</span><span>{displayedCurrency || t("Bilinmiyor", "Unknown")}</span></div>
          {!currentBase && <p role="alert">{t("Sunucu para birimi eksik veya geçersiz; kayıt yapılamaz.", "The server currency is missing or invalid; this entry cannot be saved.")}</p>}
          {currencyChanged && <p role="alert">{t("Para birimi değişti. Güncel sunucu para birimi:", "Currency changed. Current server currency:")} {currentBase || t('bilinmiyor', 'unknown')}. {t("Tutarı temizleyip yeni para biriminde tekrar girin.", "Clear the amount and enter it again in the new currency.")}</p>}
          <div><label htmlFor="kasa-category" className="block text-slate-600 font-medium mb-1">{t("Kategori", "Category")} *</label><select id="kasa-category" value={categoryId} onChange={e => setCategoryId(e.target.value)} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2" required><option value="">{t("Kategori seçin", "Select a category")}</option>{options.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></div>
          {options.length === 0 && <p role="alert">{t("Kullanılabilir geçerli kategori yok.", "No valid categories are available.")}</p>}
          {categoryId && !categoryValid && <p role="alert">{t("Seçilen kategori artık kullanılamıyor; başka kategori seçin.", "The selected category is no longer available; choose another.")}</p>}
          <div><label htmlFor="kasa-description" className="block text-slate-600 font-medium mb-1">{t("Açıklama / Not", "Description / Note")}</label><input id="kasa-description" type="text" placeholder={t("Örn: 1. Hak ediş öncesi avans", "e.g. Advance before first progress payment")} value={description} onChange={e => setDescription(e.target.value)} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900" /></div>
          {error && <p role="alert">{error}</p>}
          <div className="pt-3 border-t border-slate-200 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 font-medium transition">{t("Vazgeç", "Cancel")}</button>
            <button type="submit" disabled={!canSubmit} style={{ backgroundColor: settings.primaryColor }} className="px-5 py-2 rounded-lg text-white font-semibold flex items-center gap-1.5 transition shadow-sm disabled:opacity-50"><Check className="h-4 w-4" /><span>{isSubmitting ? t("Kaydediliyor...", "Saving...") : t("Kasaya İşle", "Record Cash Entry")}</span></button>
          </div>
        </form>
      </div>
    </div>
  );
};
