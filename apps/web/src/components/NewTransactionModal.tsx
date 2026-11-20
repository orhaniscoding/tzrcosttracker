import React, { useState, useEffect } from 'react';
import { useLocale } from '../context/LocaleContext.js';
import { X, Plus, AlertTriangle, UserCheck, Calendar, FileText } from 'lucide-react';
import type { Category } from '@cost-core/types';
import { useTheme } from '../context/ThemeContext.js';
import { ApiClient } from '../api/client.js';
import { useFormLifetime, useScopedAccounts, validateFormAccount } from '../account-management.js';

interface NewTransactionModalProps {
  canMutate?: boolean;
  isOpen: boolean;
  onClose: () => void;
  categories: Category[];
  onAddTransaction: (tx: any) => Promise<void>;
  selectedProjectId?: string | null;
}

export const NewTransactionModal: React.FC<NewTransactionModalProps> = ({
  canMutate = false,
  isOpen,
  onClose,
  categories,
  onAddTransaction,
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
  const accountState = useScopedAccounts(selectedProjectId, isOpen && canMutate);
  const { accounts } = accountState;
  const lifetime = useFormLifetime(selectedProjectId, isOpen && canMutate);
  const [formError, setFormError] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Banka');
  const [isPaid, setIsPaid] = useState(true);
  const [dueDate, setDueDate] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState(false);

  useEffect(() => { setAccountFromId(id => accounts.some(a => a.id === id) ? id : ''); }, [accounts]);
  useEffect(() => { setDuplicateWarning(false); setIsSubmitting(false); setFormError(''); }, [isOpen, selectedProjectId, canMutate, lifetime.generation]);

  // Mükerrer Kontrolü (Debounced Radar)
  useEffect(() => {
    let active = true;
    const current = lifetime.capture();
    if (!isOpen || !canMutate || !title || !amount || parseFloat(amount) <= 0) {
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
  }, [title, amount, date, selectedProjectId, isOpen, canMutate, lifetime.generation]);

  if (!isOpen || !canMutate) return null;

  const rootCategories = categories.filter((c) => !c.parentId);
  const subCategories = categories.filter((c) => c.parentId === categoryId);

  const handleSubmit = async (e: React.FormEvent) => {
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

      // Formu temizle ve kapat
      if (!current()) return;
      setTitle('');
      setAmount('');
      setParty('');
      setDescription('');
      setDuplicateWarning(false);
      onClose();
    } catch { if (current()) setFormError(t('Harcama kaydedilemedi. Lütfen yeniden deneyin.', 'Could not save the expense. Please try again.')); } finally {
      if (current()) setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Modal Başlığı */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-blue-100 flex items-center justify-center text-blue-700">
              <Plus className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">{t('Yeni Maliyet & Harcama Kaydı Ekle', 'Add Cost & Expense')}</h3>
              <p className="text-[11px] text-slate-500">{t('Sunucu hassas mali alanları şifreler.', 'The server encrypts selected financial fields.')}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Mükerrer Kayıt Radarı Bildirimi */}
        {formError && <p role="alert">{formError}</p>}
        {accountState.error && <p role="alert">{localize("Cüzdanlar yüklenemedi: ", "Could not load accounts: ")}{accountState.error} <button type="button" onClick={() => void accountState.retry()}>{t('Yeniden dene', 'Retry')}</button></p>}
        {duplicateWarning && (
          <div className="bg-amber-50 border-b border-amber-200 px-6 py-2.5 flex items-center gap-2 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              <strong>{t('🚨 Mükerrer Kayıt Radarı:', '🚨 Possible Duplicate:')}</strong> {t('Bugün aynı başlık ve tutarda başka bir kayıt zaten mevcut!', 'A record with the same title and amount already exists today!')}
            </span>
          </div>
        )}

        {/* Form Alanı */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto text-xs text-slate-700">
          {/* 1. Satır: Tarih & Kalem Başlığı */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-4">
              <label className="block text-slate-600 font-semibold mb-1">{t('Tarih', 'Date')} *</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600 font-medium"
                required
              />
            </div>

            <div className="sm:col-span-8">
              <label className="block text-slate-600 font-semibold mb-1">{t('Harcama Başlığı / Kalem', 'Expense Title / Item')} *</label>
              <input
                type="text"
                placeholder={t('Örn: 35m³ C35 Hazır Beton, Demir İşçiliği, Noter...', 'e.g. 35m³ C35 Ready-Mix Concrete, Steelwork, Notary...')}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-semibold focus:outline-none focus:border-blue-600"
                autoFocus
                required
              />
            </div>
          </div>

          {/* 2. Satır: Tutar, Para Birimi & Kategori */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-6 flex gap-1.5">
              <div className="flex-1">
                <label className="block text-slate-600 font-semibold mb-1">{t('Tutar', 'Amount')} *</label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="0.00 ₺"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-bold font-mono focus:outline-none focus:border-blue-600 text-right text-sm"
                  required
                />
              </div>
              <div className="w-24">
              <label className="block text-slate-600 font-semibold mb-1">{t('Para Birimi', 'Currency')}</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-2 py-2 text-slate-800 font-bold focus:outline-none focus:border-blue-600"
                >
                  <option value="TRY">TRY (₺)</option>
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                </select>
              </div>
            </div>

            <div className="sm:col-span-6">
              <label className="block text-slate-600 font-semibold mb-1">{t('Tedarikçi / Cari / Alacaklı', 'Supplier / Account / Payee')}</label>
              <input
                type="text"
                placeholder={t('Örn: Akçansa Beton A.Ş., Demirci Usta...', 'e.g. Acme Concrete, Steel Contractor...')}
                value={party}
                onChange={(e) => setParty(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          {/* 3. Satır: Ana Kategori ve Alt Kategori */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-6">
              <label className="block text-slate-600 font-semibold mb-1">{t('Ana Kategori', 'Main Category')} *</label>
              <select
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  setSubcategoryId('');
                }}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                required
              >
                <option value="">{t('-- Ana Kategori Seçin --', '-- Select Main Category --')}</option>
                {rootCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-6">
              <label className="block text-slate-600 font-semibold mb-1">{t('Alt Kategori (Opsiyonel)', 'Subcategory (Optional)')}</label>
              <select
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
                disabled={!categoryId || subCategories.length === 0}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600 disabled:opacity-40"
              >
                <option value="">{t('-- Alt Kategori --', '-- Subcategory --')}</option>
                {subCategories.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 4. Satır: Finansman Modu (Şirket Kasası vs Oto-Kasa Cebinden) */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-800">{t('Ödeme Kaynağı (Finansman Modu):', 'Payment Source (Funding Mode):')}</span>
              <div className="flex rounded-lg bg-white border border-slate-300 p-0.5">
                <button
                  type="button"
                  onClick={() => setPaymentSource('company_account')}
                  className={`px-3 py-1 rounded text-xs font-semibold transition ${
                    paymentSource === 'company_account'
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {localize("🏢 Şirket Kasasından", "🏢 Company funds")}
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentSource('person_out_of_pocket')}
                  className={`px-3 py-1 rounded text-xs font-semibold transition ${
                    paymentSource === 'person_out_of_pocket'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  👤 Oto-Kasa (Cebinden)
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
                  {localize("Harcamayı Kendi Cebinden Ödeyen Ortak / Personel *", "Partner or employee who paid out of pocket *")}
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
                  {localize("💡 Bu seçenek işaretlendiğinde sistem otomatik olarak Kasa'ya bu kişinin alacağı olarak çift taraflı mahsup fişi kesecektir.", "This option records the out-of-pocket payment and the amount owed to the person.")}
                </p>
              </div>
            )}
          </div>

          {/* 5. Satır: Ödeme Türü ve Ödeme Durumu (Vadeli mi?) */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-6">
              <label className="block text-slate-600 font-semibold mb-1">{t('Ödeme Yöntemi', 'Payment Method')}</label>
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
              <label className="block text-slate-600 font-semibold mb-1">{t('Ödeme Durumu', 'Payment Status')}</label>
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
                    className="flex-1 bg-slate-50 border border-amber-300 rounded-lg px-2.5 py-2 text-slate-900 focus:outline-none"
                    title={t('Vade Tarihi', 'Due Date')}
                  />
                )}
              </div>
            </div>
          </div>

          {/* 6. Satır: Açıklama / Not */}
          <div>
            <label className="block text-slate-600 font-semibold mb-1">{t('Açıklama / Fatura No / Şantiye Notu', 'Description / Invoice No. / Site Note')}</label>
            <textarea
              rows={2}
              placeholder={t('İrsaliye no, blok/kat bilgisi, sözleşme detayı...', 'Delivery note, block/floor, contract details...')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>

          {/* Alt Butonlar */}
          <div className="pt-4 border-t border-slate-200 flex justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 font-semibold transition"
            >
              {localize("Vazgeç", "Cancel")}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold flex items-center gap-1.5 transition shadow-sm disabled:opacity-50"
              style={{ backgroundColor: settings.primaryColor }}
            >
              <Plus className="h-4 w-4" />
              <span>{isSubmitting ? t('Kaydediliyor…', 'Saving…') : t('Harcamayı kaydet', 'Save expense')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
