import React, { useState, useEffect } from 'react';
import { useLocale } from '../context/LocaleContext.js';
import {
  ArrowLeft,
  Plus,
  AlertTriangle,
  UserCheck,
  Calendar,
  DollarSign,
  Building2,
  Tag,
  CheckCircle2,
  Clock,
  Save,
} from 'lucide-react';
import type { Category } from '@cost-core/types';
import { useTheme } from '../context/ThemeContext.js';
import { ApiClient } from '../api/client.js';
import { useFormLifetime, useScopedAccounts, validateFormAccount } from '../account-management.js';

interface NewTransactionViewProps {
  canMutate?: boolean;
  categories: Category[];
  onAddTransaction: (tx: any) => Promise<void>;
  onNavigateBack: () => void;
  selectedProjectId?: string | null;
}

export const NewTransactionView: React.FC<NewTransactionViewProps> = ({
  canMutate = false,
  categories,
  onAddTransaction,
  onNavigateBack,
  selectedProjectId,
}) => {
  const { settings } = useTheme();
  const { t, intlLocale } = useLocale();
  const localize = t;

  const [date, setDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('TRY');
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [party, setParty] = useState('');
  const [description, setDescription] = useState('');
  const [paymentSource, setPaymentSource] = useState<'company_account' | 'person_out_of_pocket'>('company_account');
  const [payerPersonName, setPayerPersonName] = useState('');
  const [accountFromId, setAccountFromId] = useState('');
  const accountState = useScopedAccounts(selectedProjectId, canMutate);
  const { accounts } = accountState;
  const lifetime = useFormLifetime(selectedProjectId, canMutate);
  const [formError, setFormError] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Banka');
  const [isPaid, setIsPaid] = useState(true);
  const [dueDate, setDueDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(false);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  useEffect(() => { setAccountFromId(id => accounts.some(a => a.id === id) ? id : ''); }, [accounts]);
  useEffect(() => { setDuplicateWarning(false); setSuccessNotice(null); setIsSubmitting(false); setFormError(''); }, [selectedProjectId, canMutate, lifetime.generation]);

  // Mükerrer Kontrolü (Debounced Radar)
  useEffect(() => {
    let active = true;
    const current = lifetime.capture();
    if (!canMutate || !title || !amount || parseFloat(amount) <= 0) {
      setDuplicateWarning(false);
      return;
    }

    const timer = setTimeout(async () => {
      if (!active || !current()) return;
      try {
        const res = await ApiClient.checkDuplicate({
          projectId: selectedProjectId || undefined,
          date: new Date(date).toISOString(),
          title,
          amount: parseFloat(amount),
        });
        if (active && current()) setDuplicateWarning(res.isDuplicate);
      } catch {
        if (active && current()) setDuplicateWarning(false);
      }
    }, 400);

    return () => { active = false; clearTimeout(timer); };
  }, [title, amount, date, selectedProjectId, canMutate, lifetime.generation]);

  const rootCategories = categories.filter((c) => !c.parentId);
  const subCategories = categories.filter((c) => c.parentId === categoryId);

  const handleSubmit = async (e: React.FormEvent, shouldStay = false) => {
    e.preventDefault();
    if (!canMutate || isSubmitting) return;
    const current = lifetime.capture();
    if (!current()) return;
    const accountError = paymentSource === 'company_account' ? validateFormAccount(accountState, accountFromId, currency) : null;
    if (accountError) { setFormError(accountError); return; }
    if (!title || !amount || !categoryId) {
      setFormError(t('Başlık, tutar ve kategori girin.', 'Enter a title, amount, and category.'));
      return;
    }

    if (paymentSource === 'person_out_of_pocket' && !payerPersonName.trim()) {
      setFormError(t('Harcamayı ödeyen kişinin adını girin.', 'Enter the name of the person who paid.'));
      return;
    }

    try {
      setIsSubmitting(true);
      await onAddTransaction({
        projectId: selectedProjectId || undefined,
        type: 'expense',
        date: new Date(date).toISOString(),
        title,
        amount: parseFloat(amount),
        currency,
        categoryId,
        subcategoryId: subcategoryId || undefined,
        party: party || undefined,
        description: description || undefined,
        paymentSource,
        payerPersonName: paymentSource === 'person_out_of_pocket' ? payerPersonName.trim() : undefined,
        accountFromId: paymentSource === 'company_account' && accountFromId ? accountFromId : undefined,
        paymentMethod,
        isPaid,
        dueDate: !isPaid && dueDate ? new Date(dueDate).toISOString() : undefined,
      });

      if (!current()) return;
      if (shouldStay) {
        setTitle('');
        setAmount('');
        setParty('');
        setDescription('');
        setDuplicateWarning(false);
        setSuccessNotice(t('Harcama kaydedildi.', 'Expense saved.'));
      } else {
        onNavigateBack();
      }
    } catch { if (current()) setFormError(t('Harcama kaydedilemedi. Lütfen yeniden deneyin.', 'Could not save the expense. Please try again.')); } finally {
      if (current()) setIsSubmitting(false);
    }
  };

  if (!canMutate) return <p role="alert">{t('Harcama oluşturma yetkiniz bulunmuyor.', 'You do not have permission to create expenses.')}</p>;
  return (
    <div className="space-y-6 max-w-4xl">
      {formError && <p role="alert">{formError}</p>}
      {accountState.error && <p role="alert">{localize("Cüzdanlar yüklenemedi: ", "Could not load accounts: ")}{accountState.error} <button type="button" onClick={() => void accountState.retry()}>{t('Yeniden dene', 'Retry')}</button></p>}
      {/* BAŞLIK VE GERİ DÖNÜŞ BAR */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onNavigateBack}
            className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition"
            title={t('Harcama Listesine Dön', 'Back to Expenses')}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Plus className="h-5 w-5 text-blue-600" />
              <span>{t('Yeni Harcama / Maliyet Girişi', 'New Expense / Cost Entry')}</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {localize("Harcama detaylarını girin. Veriler AES-256-GCM ile anında şifrelenir.", "Enter the expense details. The server encrypts selected financial fields with AES-256-GCM.")}
            </p>
          </div>
        </div>

        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />{localize(" Sıfır Bilgi Güvenliği", " Field encryption")}
        </span>
      </div>

      {successNotice && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-4 rounded-xl text-xs font-semibold flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          <span>{successNotice}</span>
        </div>
      )}

      {/* MÜKERRER KAYIT RADARI */}
      {duplicateWarning && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-xs text-amber-800 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
          <span>
            <strong>{t('🚨 Mükerrer Kayıt Radarı:', '🚨 Possible Duplicate:')}</strong> {t('Bugün aynı başlık ve tutarda başka bir kayıt zaten mevcut! Çift giriş yapmadığınızdan emin olun.', 'A record with the same title and amount already exists today. Check before adding another.')}
          </span>
        </div>
      )}

      {/* FORM ALANI */}
      <form onSubmit={(e) => handleSubmit(e, false)} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-5 text-xs text-slate-700">
        {/* Satır 1: Tarih & Başlık */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-4">
            <label className="block text-slate-700 font-semibold mb-1.5">{t('İşlem Tarihi', 'Transaction Date')} *</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-medium focus:outline-none focus:border-blue-600"
              required
            />
          </div>

          <div className="sm:col-span-8">
            <label className="block text-slate-700 font-semibold mb-1.5">{t('Harcama Başlığı / Kalem Adı', 'Expense Title / Item Name')} *</label>
            <input
              type="text"
              placeholder={t('Örn: 35m³ C35 Hazır Beton Dökümü, Demir Bağlama İşçiliği, Noter Harcı...', 'e.g. C35 Concrete Pour, Rebar Work, Notary Fee...')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3.5 py-2 text-slate-900 font-semibold focus:outline-none focus:border-blue-600 text-sm"
              autoFocus
              required
            />
          </div>
        </div>

        {/* Satır 2: Tutar, Para Birimi & Tedarikçi */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-6 flex gap-2">
            <div className="flex-1">
              <label className="block text-slate-700 font-semibold mb-1.5">{t('Fatura / Harcama Tutarı', 'Invoice / Expense Amount')} *</label>
              <input
                type="number"
                step="0.01"
                placeholder="0.00 ₺"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3.5 py-2 text-slate-900 font-bold font-mono focus:outline-none focus:border-blue-600 text-right text-base"
                required
              />
            </div>

            <div className="w-28">
            <label className="block text-slate-700 font-semibold mb-1.5">{t('Para Birimi', 'Currency')}</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-800 font-bold focus:outline-none focus:border-blue-600"
              >
                <option value="TRY">TRY (₺)</option>
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
              </select>
            </div>
          </div>

          <div className="sm:col-span-6">
            <label className="block text-slate-700 font-semibold mb-1.5">{t('Tedarikçi / Cari / Alacaklı Firma', 'Supplier / Account / Payee')}</label>
            <input
              type="text"
              placeholder={t('Örn: Akçansa Çimento, Noterlik, Karotçu, Taşeron...', 'e.g. Acme Cement, Notary, Drilling Contractor...')}
              value={party}
              onChange={(e) => setParty(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>
        </div>

        {/* Satır 3: Ana Kategori & Alt Kategori */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-6">
            <label className="block text-slate-700 font-semibold mb-1.5">{t('Ana Kategori / İş Grubu', 'Main Category / Work Group')} *</label>
            <select
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setSubcategoryId('');
              }}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
              required
            >
              <option value="">{t('-- Ana Kategori Seçiniz --', '-- Select Main Category --')}</option>
              {rootCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-6">
            <label className="block text-slate-700 font-semibold mb-1.5">{t('Alt Kategori (Kırılım)', 'Subcategory (Breakdown)')}</label>
            <select
              value={subcategoryId}
              onChange={(e) => setSubcategoryId(e.target.value)}
              disabled={!categoryId || subCategories.length === 0}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600 disabled:opacity-40"
            >
              <option value="">{t('-- Alt Kategori (Opsiyonel) --', '-- Subcategory (Optional) --')}</option>
              {subCategories.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Satır 4: Finansman Modu (Oto-Kasa vs Şirket Kasası) */}
        <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-bold text-slate-800">{t('Ödeme Kaynağı (Finansman Türü):', 'Payment Source (Funding Type):')}</span>
            <div className="flex rounded-lg bg-white border border-slate-300 p-0.5">
              <button
                type="button"
                onClick={() => setPaymentSource('company_account')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                  paymentSource === 'company_account'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {localize("🏢 Şirket / Şantiye Kasasından", "🏢 Company or project funds")}
              </button>
              <button
                type="button"
                onClick={() => setPaymentSource('person_out_of_pocket')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                  paymentSource === 'person_out_of_pocket'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                👤 Oto-Kasa (Ortak Kendi Cebinden)
              </button>
            </div>
          </div>

          {paymentSource === 'company_account' && accounts.length > 0 && (
            <div className="pt-2 border-t border-slate-200">
              <label className="block text-slate-700 font-semibold mb-1">
                {localize("Ödemenin Çıktığı Hesap / Cüzdan (Reel Likidite Düşümü)", "Account used for payment")}
              </label>
              <select
                value={accountFromId}
                onChange={(e) => setAccountFromId(e.target.value)}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-semibold focus:outline-none"
              >
                <option value="">{t('-- Cüzdan Seçiniz (Otomatik Düşüm Yapılmaz) --', '-- Select Wallet (No Automatic Deduction) --')}</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.type === 'bank' ? '🏦' : acc.type === 'credit_card' ? '💳' : '💵'} {acc.name} - {t('Güncel Bakiye:', 'Current Balance:')} {acc.balance.toLocaleString(intlLocale)} {acc.currency}
                  </option>
                ))}
              </select>
            </div>
          )}

          {paymentSource === 'person_out_of_pocket' && (
            <div className="pt-2 border-t border-slate-200">
              <label className="block text-emerald-800 font-semibold mb-1">
                {localize("Harcamayı Kendi Cebinden Ödeyen Ortak / Personel Adı *", "Name of the partner or employee who paid out of pocket *")}
              </label>
              <input
                type="text"
              placeholder={t('Örn: Yılmaz Sağır, Ahmet Usta...', 'e.g. Jane Doe, Alex Smith...')}
                value={payerPersonName}
                onChange={(e) => setPayerPersonName(e.target.value)}
                className="w-full bg-white border border-emerald-400 rounded-lg px-3 py-2 text-slate-900 font-semibold focus:outline-none"
                required
              />
              <p className="text-[11px] text-emerald-700 mt-1">
                {localize("💡 Sistem bu harcama kaydedildiğinde otomatik olarak Kasa'ya bu kişinin alacağı olarak çift taraflı mahsup fişi kesecektir.", "Saving this expense records the out-of-pocket payment and the amount owed to the person.")}
              </p>
            </div>
          )}
        </div>

        {/* Satır 5: Ödeme Yöntemi & Vade Durumu */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-6">
            <label className="block text-slate-700 font-semibold mb-1.5">{t('Ödeme Yöntemi', 'Payment Method')}</label>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-blue-600"
            >
              <option value="Banka">{t('Banka Havalesi / EFT', 'Bank Transfer')}</option>
              <option value="Nakit">{t('Elden Nakit', 'Cash')}</option>
              <option value="Kredi Kartı">{t('Kredi Kartı', 'Credit Card')}</option>
              <option value="Çek / Senet">{t('Çek / Senet (Vadeli)', 'Check / Promissory Note (Deferred)')}</option>
            </select>
          </div>

          <div className="sm:col-span-6">
            <label className="block text-slate-700 font-semibold mb-1.5">{t('Ödeme Durumu', 'Payment Status')}</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsPaid(!isPaid)}
                className={`px-3 py-2 rounded-lg font-semibold border flex items-center gap-1.5 transition ${
                  isPaid
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                    : 'bg-amber-50 border-amber-300 text-amber-700'
                }`}
              >
                <span>{isPaid ? '✅ Peşin Ödendi' : '⏳ Bekliyor / Vadeli'}</span>
              </button>
              {!isPaid && (
                <input
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="flex-1 bg-slate-50 border border-amber-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none"
                  title={t('Vade Tarihi', 'Due Date')}
                />
              )}
            </div>
          </div>
        </div>

        {/* Satır 6: Açıklama & Not */}
        <div>
          <label className="block text-slate-700 font-semibold mb-1.5">{t('Açıklama / Fatura No / Not', 'Description / Invoice No. / Note')}</label>
          <textarea
            rows={3}
            placeholder={t('Fatura numarası, irsaliye detayları, blok/kat bilgisi...', 'Invoice number, delivery details, block/floor...')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
          />
        </div>

        {/* AKSİYON BUTONLARI */}
        <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onNavigateBack}
            className="px-4 py-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold transition"
          >
            {localize("İptal & Listeye Dön", "Cancel and return to expenses")}
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={(e) => handleSubmit(e, true)}
              className="px-5 py-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold transition disabled:opacity-50"
            >
              Kaydet ve Yeni Ekle
            </button>

            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold flex items-center gap-1.5 transition shadow-sm disabled:opacity-50"
              style={{ backgroundColor: settings.primaryColor }}
            >
              <Save className="h-4 w-4" />
              <span>{isSubmitting ? t('Kaydediliyor…', 'Saving…') : t('Harcamayı kaydet ve listeye dön', 'Save expense and return to list')}</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
