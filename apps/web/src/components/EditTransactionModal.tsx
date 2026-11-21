import React, { useState, useEffect } from 'react';
import { useLocale } from '../context/LocaleContext.js';
import { X, Check, Edit3, Trash2 } from 'lucide-react';
import type { Transaction, Category } from '@cost-core/types';
import { useTheme } from '../context/ThemeContext.js';
import { buildTransactionEditPayload, initialAccountId, readOnlyEditReason } from '../transaction-edit.js';
import { useFormLifetime, useScopedAccounts, validateFormAccount } from '../account-management.js';

interface EditTransactionModalProps {
  canMutate?: boolean;
  isOpen: boolean;
  onClose: () => void;
  transaction: Transaction | null;
  categories: Category[];
  onSave: (id: string, updates: any) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export const EditTransactionModal: React.FC<EditTransactionModalProps> = ({
  canMutate = false,
  isOpen,
  onClose,
  transaction,
  categories,
  onSave,
  onDelete,
}) => {
  const { settings } = useTheme();
  const { t } = useLocale();

  const [date, setDate] = useState('');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('TRY');
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [party, setParty] = useState('');
  const [description, setDescription] = useState('');
  const [paymentSource, setPaymentSource] = useState<'company_account' | 'person_out_of_pocket'>('company_account');
  const [payerPersonName, setPayerPersonName] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Banka');
  const [isPaid, setIsPaid] = useState(true);
  const [dueDate, setDueDate] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const accountState = useScopedAccounts(transaction?.projectId ?? null, isOpen && !!transaction && canMutate, transaction?.id, transaction ? initialAccountId(transaction) || null : null);
  const { accounts } = accountState;
  const lifetime = useFormLifetime(`${transaction?.id ?? ''}:${transaction?.projectId ?? ''}`, isOpen && !!transaction && canMutate);
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setIsSaving(false); setError(''); }, [isOpen, transaction?.id, transaction?.projectId, canMutate, lifetime.generation]);

  useEffect(() => {
    if (transaction) {
      setDate(transaction.date.split('T')[0]);
      setTitle(transaction.title || '');
      setAmount(String(transaction.amount || ''));
      setCurrency(transaction.currency || 'TRY');
      setCategoryId(transaction.categoryId || '');
      setSubcategoryId(transaction.subcategoryId || '');
      setParty(transaction.party || '');
      setDescription(transaction.description || '');
      setPaymentSource(transaction.paymentSource || 'company_account');
      setPayerPersonName(transaction.payerPersonName || '');
      setPaymentMethod(transaction.paymentMethod || 'Banka');
      setIsPaid(transaction.isPaid);
      setDueDate(transaction.dueDate ? transaction.dueDate.split('T')[0] : '');
      setAccountId(initialAccountId(transaction));
      setError('');
    }
  }, [transaction, isOpen]);
  if (!isOpen || !transaction || !canMutate) return null;

  const rootCategories = categories.filter((c) => !c.parentId);
  const subCategories = categories.filter((c) => c.parentId === categoryId);

  const readonlyReason = transaction ? readOnlyEditReason(transaction) : null;
  const selectedAccount = accounts.find((x) => x.id === accountId) || null;
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transaction || !canMutate) return;
    if (readonlyReason) { setError(readonlyReason); return; } if (isSaving) return;
    const isCurrent = lifetime.capture(); const txId = transaction.id;
    if (!isCurrent()) return;
    if (paymentSource === 'company_account') {
      const accountError = validateFormAccount(accountState, accountId, currency);
      if (accountError) { setError(accountError); return; }
    }
    try {
      const result = buildTransactionEditPayload(transaction, { date: new Date(date).toISOString(), title, amount: parseFloat(amount), currency, categoryId, subcategoryId: subcategoryId || null, party: party || null, description: description || null, paymentSource, payerPersonName: paymentSource === 'person_out_of_pocket' ? payerPersonName : null, paymentMethod, isPaid, dueDate: !isPaid && dueDate ? new Date(dueDate).toISOString() : null, accountId: accountId || null, accountCurrency: selectedAccount?.currency || null });
      if (!result.ok) { setError(result.error); return; }
      setIsSaving(true); setError('');
      await onSave(txId, result.payload);
      if (!isCurrent()) return;
      onClose();
    } catch (err: any) { if (isCurrent()) setError(err?.message || t('Kaydetme basarisiz. Lutfen tekrar deneyin.', 'Save failed. Please try again.')); }
    finally { if (isCurrent()) setIsSaving(false); }
  };
  const handleDelete = async () => {
    if (!transaction || !canMutate) return;
    if (readonlyReason) { setError(readonlyReason); return; } if (isSaving) return;
    if (!confirm(t('Bu kaydi kalici olarak silmek istediginizden emin misiniz?', 'Are you sure you want to permanently delete this record?'))) return;
    const isCurrent = lifetime.capture(); const txId = transaction.id;
    if (!isCurrent()) return;
    try { setIsSaving(true); setError(''); await onDelete(txId); if (!isCurrent()) return; onClose(); }
    catch (err: any) { if (isCurrent()) setError(err?.message || t('Silme basarisiz. Lutfen tekrar deneyin.', 'Delete failed. Please try again.')); }
    finally { if (isCurrent()) setIsSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Başlık */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
            <Edit3 className="h-4 w-4 text-blue-600" />
            <span>{t('Kaydı Düzenle', 'Edit Record')} (ID: {transaction.id.slice(0, 8)}...)</span>
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-3.5 overflow-y-auto text-xs text-slate-700">
          {readonlyReason && (<div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800 font-medium">{readonlyReason}</div>)}
          {error && (<div role="alert" className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-rose-700 font-medium">{error}</div>)}
          {accountState.error && <p role="alert">{t('Cüzdanlar yüklenemedi:', 'Wallets could not be loaded:')} {accountState.error} <button type="button" onClick={() => void accountState.retry()}>{t('Yeniden dene', 'Retry')}</button></p>}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-4">
              <label className="block text-slate-600 font-medium mb-1">{t('Tarih', 'Date')} *</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                required
              />
            </div>

            <div className="sm:col-span-8">
              <label className="block text-slate-600 font-medium mb-1">{t('Harcama Başlığı / Kalem', 'Expense Title / Item')} *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-semibold focus:outline-none focus:border-blue-600"
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-6 flex gap-1.5">
              <div className="flex-1">
                <label className="block text-slate-600 font-medium mb-1">{t('Tutar', 'Amount')} *</label>
                <input
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-bold font-mono focus:outline-none focus:border-blue-600 text-right"
                  required
                />
              </div>
              <div className="w-24">
                <label className="block text-slate-600 font-medium mb-1">{t('Döviz', 'Currency')}</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg px-2 py-2 text-slate-900 focus:outline-none focus:border-blue-600 font-bold"
                >
                  <option value="TRY">TRY (₺)</option>
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                </select>
              </div>
            </div>

            <div className="sm:col-span-6">
              <label className="block text-slate-600 font-medium mb-1">{t('Tedarikçi / Cari', 'Supplier / Account')}</label>
              <input
                type="text"
                placeholder={t('Firma / Şahıs Adı', 'Company / Person Name')}
                value={party}
                onChange={(e) => setParty(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-6">
              <label className="block text-slate-600 font-medium mb-1">{t('Ana Kategori', 'Main Category')} *</label>
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
              <label className="block text-slate-600 font-medium mb-1">{t('Alt Kategori', 'Subcategory')}</label>
              <select
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
                disabled={!categoryId || subCategories.length === 0}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600 disabled:opacity-50"
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

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 p-3 bg-slate-50 border border-slate-200 rounded-xl">
            <div className="sm:col-span-6">
              <label className="block text-slate-600 font-medium mb-1">{t('Ödeme Kaynağı', 'Payment Source')}</label>
              <div className="flex gap-2">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="editPaymentSource"
                    checked={paymentSource === 'company_account'}
                    onChange={() => setPaymentSource('company_account')}
                  />
                  <span>🏢 {t('Şirket Kasası', 'Company Account')}</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="editPaymentSource"
                    checked={paymentSource === 'person_out_of_pocket'}
                    onChange={() => setPaymentSource('person_out_of_pocket')}
                  />
                  <span>👤 {t('Oto-Kasa (Cebinden)', 'Out of Pocket')}</span>
                </label>
              </div>
            </div>

            {paymentSource === 'person_out_of_pocket' && (
              <div className="sm:col-span-6">
                <label className="block text-emerald-700 font-medium mb-1">{t('Cebinden Ödeyen Kişi', 'Person Paying Out of Pocket')} *</label>
                <input
                  type="text"
                  value={payerPersonName}
                  onChange={(e) => setPayerPersonName(e.target.value)}
                  className="w-full bg-white border border-emerald-300 rounded-lg px-3 py-1.5 text-slate-900 focus:outline-none"
                  placeholder={t('Örn: Yılmaz Sağır', 'e.g. Jane Doe')}
                  required
                />
              </div>
            )}
          </div>

          {paymentSource === 'company_account' && (
            <div>
              <label className="block text-slate-600 font-medium mb-1">{transaction.type === 'income' ? t('Hedef Cüzdan (Şirket Hesabı)', 'Destination Wallet (Company Account)') : t('Kaynak Cüzdan (Şirket Hesabı)', 'Source Wallet (Company Account)')}</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={!!readonlyReason} className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600 disabled:opacity-50">
                <option value="">{t('Cüzdan seçilmedi — bakiye etkisi yok (yalnızca kayıt)', 'No wallet selected — no balance effect (record only)')}</option>
                {accounts.map((a) => (<option key={a.id} value={a.id}>{a.name} ({a.currency})</option>))}
              </select>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-6">
              <label className="block text-slate-600 font-medium mb-1">{t('Ödeme Türü', 'Payment Method')}</label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
              >
                <option value="Banka">{t('Banka Havalesi / EFT', 'Bank Transfer')}</option>
                <option value="Nakit">{t('Elden Nakit', 'Cash')}</option>
                <option value="Kredi Kartı">{t('Kredi Kartı', 'Credit Card')}</option>
                <option value="Çek / Senet">{t('Çek / Senet (Vadeli)', 'Check / Promissory Note (Deferred)')}</option>
              </select>
            </div>

            <div className="sm:col-span-6">
              <label className="block text-slate-600 font-medium mb-1">{t('Ödeme Durumu', 'Payment Status')}</label>
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
                  <span>{isPaid ? t('✅ Peşin Ödendi', '✅ Paid Upfront') : t('⏳ Bekliyor / Vadeli', '⏳ Pending / Deferred')}</span>
                </button>
                {!isPaid && (
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="flex-1 bg-slate-50 border border-amber-300 rounded-lg px-2 py-1.5 text-slate-900 focus:outline-none"
                    title={t('Vade Tarihi', 'Due Date')}
                  />
                )}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-slate-600 font-medium mb-1">{t('Açıklama / Detay', 'Description / Details')}</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
              placeholder={t('Fatura numarası, şantiye notu vb.', 'Invoice number, site note, etc.')}
            />
          </div>

          {/* Aksiyon Butonları */}
          <div className="pt-4 border-t border-slate-200 flex items-center justify-between">
            <button
              type="button"
              onClick={handleDelete}
              disabled={isSaving || !!readonlyReason}
              className="px-4 py-2 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 font-medium flex items-center gap-1.5 transition disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" />
              <span>{t('Kaydı Sil', 'Delete Record')}</span>
            </button>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 font-medium transition"
              >
                {t('Vazgeç', 'Cancel')}
              </button>
              <button
                type="submit"
                disabled={isSaving || !!readonlyReason}
                className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium flex items-center gap-1.5 transition shadow-sm disabled:opacity-50"
                style={{ backgroundColor: settings.primaryColor }}
              >
                <Check className="h-4 w-4" />
                <span>{isSaving ? 'Kaydediliyor...' : 'Değişiklikleri Kaydet'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
