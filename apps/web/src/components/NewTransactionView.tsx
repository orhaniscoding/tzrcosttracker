import React, { useState, useEffect } from 'react';
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
      alert('Lütfen en azından Başlık, Tutar ve Kategori alanlarını doldurunuz.');
      return;
    }

    if (paymentSource === 'person_out_of_pocket' && !payerPersonName.trim()) {
      alert('Lütfen harcamayı kendi cebinden ödeyen kişinin adını giriniz.');
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
        setSuccessNotice('Kayıt başarıyla eklendi. Yeni kayıt girebilirsiniz.');
      } else {
        onNavigateBack();
      }
    } catch { if (current()) setFormError('Harcama kaydedilemedi. Lütfen yeniden deneyin.'); } finally {
      if (current()) setIsSubmitting(false);
    }
  };

  if (!canMutate) return <p role="alert">Harcama oluşturma yetkiniz bulunmuyor.</p>;
  return (
    <div className="space-y-6 max-w-4xl">
      {formError && <p role="alert">{formError}</p>}
      {accountState.error && <p role="alert">Cüzdanlar yüklenemedi: {accountState.error} <button type="button" onClick={() => void accountState.retry()}>Yeniden dene</button></p>}
      {/* BAŞLIK VE GERİ DÖNÜŞ BAR */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onNavigateBack}
            className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition"
            title="Harcama Listesine Dön"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Plus className="h-5 w-5 text-blue-600" />
              <span>Yeni Harcama / Maliyet Girişi</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Harcama detaylarını girin. Veriler AES-256-GCM ile anında şifrelenir.
            </p>
          </div>
        </div>

        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Sıfır Bilgi Güvenliği
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
            <strong>🚨 Mükerrer Kayıt Radarı:</strong> Bugün aynı başlık ve tutarda başka bir kayıt zaten mevcut! Çift giriş yapmadığınızdan emin olun.
          </span>
        </div>
      )}

      {/* FORM ALANI */}
      <form onSubmit={(e) => handleSubmit(e, false)} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-5 text-xs text-slate-700">
        {/* Satır 1: Tarih & Başlık */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-4">
            <label className="block text-slate-700 font-semibold mb-1.5">İşlem Tarihi *</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-medium focus:outline-none focus:border-blue-600"
              required
            />
          </div>

          <div className="sm:col-span-8">
            <label className="block text-slate-700 font-semibold mb-1.5">Harcama Başlığı / Kalem Adı *</label>
            <input
              type="text"
              placeholder="Örn: 35m³ C35 Hazır Beton Dökümü, Demir Bağlama İşçiliği, Noter Harcı..."
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
              <label className="block text-slate-700 font-semibold mb-1.5">Fatura / Harcama Tutarı *</label>
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
              <label className="block text-slate-700 font-semibold mb-1.5">Para Birimi</label>
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
            <label className="block text-slate-700 font-semibold mb-1.5">Tedarikçi / Cari / Alacaklı Firma</label>
            <input
              type="text"
              placeholder="Örn: Akçansa Çimento, Noterlik, Karotçu, Taşeron..."
              value={party}
              onChange={(e) => setParty(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>
        </div>

        {/* Satır 3: Ana Kategori & Alt Kategori */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-6">
            <label className="block text-slate-700 font-semibold mb-1.5">Ana Kategori / İş Grubu *</label>
            <select
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setSubcategoryId('');
              }}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
              required
            >
              <option value="">-- Ana Kategori Seçiniz --</option>
              {rootCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-6">
            <label className="block text-slate-700 font-semibold mb-1.5">Alt Kategori (Kırılım)</label>
            <select
              value={subcategoryId}
              onChange={(e) => setSubcategoryId(e.target.value)}
              disabled={!categoryId || subCategories.length === 0}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600 disabled:opacity-40"
            >
              <option value="">-- Alt Kategori (Opsiyonel) --</option>
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
            <span className="font-bold text-slate-800">Ödeme Kaynağı (Finansman Türü):</span>
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
                🏢 Şirket / Şantiye Kasasından
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
                Ödemenin Çıktığı Hesap / Cüzdan (Reel Likidite Düşümü)
              </label>
              <select
                value={accountFromId}
                onChange={(e) => setAccountFromId(e.target.value)}
                className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-semibold focus:outline-none"
              >
                <option value="">-- Cüzdan Seçiniz (Otomatik Düşüm Yapılmaz) --</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.type === 'bank' ? '🏦' : acc.type === 'credit_card' ? '💳' : '💵'} {acc.name} - Güncel Bakiye: {acc.balance.toLocaleString('tr-TR')} {acc.currency}
                  </option>
                ))}
              </select>
            </div>
          )}

          {paymentSource === 'person_out_of_pocket' && (
            <div className="pt-2 border-t border-slate-200">
              <label className="block text-emerald-800 font-semibold mb-1">
                Harcamayı Kendi Cebinden Ödeyen Ortak / Personel Adı *
              </label>
              <input
                type="text"
                placeholder="Örn: Yılmaz Sağır, Ahmet Usta..."
                value={payerPersonName}
                onChange={(e) => setPayerPersonName(e.target.value)}
                className="w-full bg-white border border-emerald-400 rounded-lg px-3 py-2 text-slate-900 font-semibold focus:outline-none"
                required
              />
              <p className="text-[11px] text-emerald-700 mt-1">
                💡 Sistem bu harcama kaydedildiğinde otomatik olarak Kasa'ya bu kişinin alacağı olarak çift taraflı mahsup fişi kesecektir.
              </p>
            </div>
          )}
        </div>

        {/* Satır 5: Ödeme Yöntemi & Vade Durumu */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-6">
            <label className="block text-slate-700 font-semibold mb-1.5">Ödeme Yöntemi</label>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              className="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-slate-800 focus:outline-none focus:border-blue-600"
            >
              <option value="Banka">Banka Havalesi / EFT</option>
              <option value="Nakit">Elden Nakit</option>
              <option value="Kredi Kartı">Kredi Kartı</option>
              <option value="Çek / Senet">Çek / Senet (Vadeli)</option>
            </select>
          </div>

          <div className="sm:col-span-6">
            <label className="block text-slate-700 font-semibold mb-1.5">Ödeme Durumu</label>
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
                  title="Vade Tarihi"
                />
              )}
            </div>
          </div>
        </div>

        {/* Satır 6: Açıklama & Not */}
        <div>
          <label className="block text-slate-700 font-semibold mb-1.5">Açıklama / Fatura No / Not</label>
          <textarea
            rows={3}
            placeholder="Fatura numarası, irsaliye detayları, blok/kat bilgisi..."
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
            İptal & Listeye Dön
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
              <span>{isSubmitting ? 'Kaydediliyor...' : 'Harcamayı Kaydet ve Listeye Dön'}</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
