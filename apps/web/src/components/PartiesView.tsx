import React, { useState, useEffect } from 'react';
import {
  Users,
  Building,
  UserPlus,
  Search,
  Phone,
  Mail,
  FileText,
  CreditCard,
  ArrowRight,
  TrendingUp,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Trash2,
  X,
  Plus,
} from 'lucide-react';
import type { Party, Transaction, Category } from '@cost-core/types';
import { ApiClient } from '../api/client.js';
import { useTheme } from '../context/ThemeContext.js';

interface PartiesViewProps {
  transactions: Transaction[];
  categories: Category[];
}

export const PartiesView: React.FC<PartiesViewProps> = ({ transactions, categories }) => {
  const { settings } = useTheme();
  const currency = settings.baseCurrency || 'TRY';

  const [parties, setParties] = useState<Party[]>([]);
  const [selectedParty, setSelectedParty] = useState<Party | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(false);

  // Yeni Cari Ekleme Form State
  const [isAddingParty, setIsAddingParty] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<any>('supplier');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [iban, setIban] = useState('');
  const [taxNo, setTaxNo] = useState('');
  const [taxOffice, setTaxOffice] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const formatMoney = (val: number) => {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(val || 0);
  };

  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  const fetchParties = async () => {
    try {
      setIsLoading(true);
      const list = await ApiClient.getParties();
      setParties(list);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchParties();
  }, []);

  const handleCreateParty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    try {
      setIsSubmitting(true);
      await ApiClient.createParty({
        name: name.trim(),
        type,
        phone: phone || undefined,
        email: email || undefined,
        iban: iban || undefined,
        taxNo: taxNo || undefined,
        taxOffice: taxOffice || undefined,
        notes: notes || undefined,
      });

      setName('');
      setPhone('');
      setEmail('');
      setIban('');
      setTaxNo('');
      setTaxOffice('');
      setNotes('');
      setIsAddingParty(false);
      await fetchParties();
    } catch (err: any) {
      alert('Cari oluşturulamadı: ' + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteParty = async (id: string, pName: string) => {
    if (!confirm(`"${pName}" cari kaydını silmek istediğinizden emin misiniz?`)) return;
    try {
      await ApiClient.deleteParty(id);
      if (selectedParty?.id === id) setSelectedParty(null);
      await fetchParties();
    } catch (err: any) {
      alert('Cari silinemedi: ' + err.message);
    }
  };

  // Carilerin hareket metriklerini transactions listesinden dinamik hesapla
  const partyMetrics = new Map<string, {
    totalBilled: number;
    totalPaid: number;
    pendingDebt: number;
    overdueDebt: number;
    count: number;
    transactions: Transaction[];
  }>();

  for (const t of transactions) {
    const pName = (t.party || t.payerPersonName || '').trim();
    if (!pName) continue;

    const current = partyMetrics.get(pName.toLowerCase()) || {
      totalBilled: 0,
      totalPaid: 0,
      pendingDebt: 0,
      overdueDebt: 0,
      count: 0,
      transactions: [],
    };

    current.count++;
    current.totalBilled += t.amount;
    current.transactions.push(t);

    if (t.isPaid) {
      current.totalPaid += t.amount;
    } else {
      current.pendingDebt += t.amount;
      if (t.dueDate && t.dueDate.split('T')[0] <= new Date().toISOString().split('T')[0]) {
        current.overdueDebt += t.amount;
      }
    }

    partyMetrics.set(pName.toLowerCase(), current);
  }

  // Filtreleme
  const filteredParties = parties.filter((p) => {
    if (filterType !== 'all' && p.type !== filterType) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      const matchName = p.name.toLowerCase().includes(q);
      const matchPhone = (p.phone || '').includes(q);
      const matchTax = (p.taxNo || '').includes(q);
      if (!matchName && !matchPhone && !matchTax) return false;
    }
    return true;
  });

  // Toplam İstatistikler
  const totalBilledAll = Array.from(partyMetrics.values()).reduce((s, m) => s + m.totalBilled, 0);
  const totalPaidAll = Array.from(partyMetrics.values()).reduce((s, m) => s + m.totalPaid, 0);
  const totalPendingAll = Array.from(partyMetrics.values()).reduce((s, m) => s + m.pendingDebt, 0);

  const typeLabels: Record<string, { label: string; color: string }> = {
    subcontractor: { label: 'Taşeron', color: 'bg-purple-100 text-purple-800 border-purple-200' },
    supplier: { label: 'Tedarikçi / Malzeme', color: 'bg-blue-100 text-blue-800 border-blue-200' },
    partner: { label: 'Ortak / Yatırımcı', color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
    person: { label: 'Şahıs / Personel', color: 'bg-amber-100 text-amber-800 border-amber-200' },
    client: { label: 'Müşteri / İşveren', color: 'bg-cyan-100 text-cyan-800 border-cyan-200' },
  };

  // Seçili Carinin Hareketleri
  const selectedMetrics = selectedParty
    ? partyMetrics.get(selectedParty.name.toLowerCase()) || {
        totalBilled: 0,
        totalPaid: 0,
        pendingDebt: 0,
        overdueDebt: 0,
        count: 0,
        transactions: [],
      }
    : null;

  return (
    <div className="space-y-6">
      {/* 1. ÜST BAŞLIK & GENEL ÖZET */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Building className="h-5 w-5 text-blue-600" />
              <span>Cari & Taşeron Karnesi (Hesap Ekstreleri)</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Taşeronlar, malzeme tedarikçileri ve firmaların hesap özetleri, fatura dökümleri ve kalan borç bakiyeleri
            </p>
          </div>

          <button
            onClick={() => setIsAddingParty(!isAddingParty)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-sm transition"
            style={{ backgroundColor: settings.primaryColor }}
          >
            <UserPlus className="h-4 w-4" />
            <span>{isAddingParty ? 'Formu Kapat' : '+ Yeni Cari / Taşeron Ekle'}</span>
          </button>
        </div>

        {/* YENİ CARİ EKLEME FORMU */}
        {isAddingParty && (
          <div className="mt-5 p-5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
            <h3 className="font-bold text-slate-800 mb-3 flex items-center gap-1.5 text-sm">
              <UserPlus className="h-4 w-4 text-blue-600" />
              <span>Yeni Cari / Tedarikçi Tanımla</span>
            </h3>

            <form onSubmit={handleCreateParty} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="sm:col-span-6">
                  <label className="block text-slate-700 font-semibold mb-1">Firma / Cari / Kişi Adı *</label>
                  <input
                    type="text"
                    placeholder="Örn: Akçansa Çimento A.Ş., Demirci Ustası Hasan..."
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-semibold focus:outline-none focus:border-blue-600"
                    autoFocus
                    required
                  />
                </div>

                <div className="sm:col-span-6">
                  <label className="block text-slate-700 font-semibold mb-1">Cari Türü *</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-semibold focus:outline-none focus:border-blue-600"
                  >
                    <option value="supplier">Tedarikçi / Malzeme Satıcısı</option>
                    <option value="subcontractor">Taşeron / Usta</option>
                    <option value="partner">Ortak / Yatırımcı</option>
                    <option value="person">Şahıs / Personel</option>
                    <option value="client">Müşteri / İşveren</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="sm:col-span-4">
                  <label className="block text-slate-700 font-semibold mb-1">Telefon Numarası</label>
                  <input
                    type="text"
                    placeholder="0532 ..."
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                  />
                </div>

                <div className="sm:col-span-4">
                  <label className="block text-slate-700 font-semibold mb-1">E-posta Adresi</label>
                  <input
                    type="email"
                    placeholder="muhasebe@firma.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                  />
                </div>

                <div className="sm:col-span-4">
                  <label className="block text-slate-700 font-semibold mb-1">IBAN Numarası</label>
                  <input
                    type="text"
                    placeholder="TR..."
                    value={iban}
                    onChange={(e) => setIban(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-mono focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="sm:col-span-6">
                  <label className="block text-slate-700 font-semibold mb-1">Vergi Dairesi & Vergi No</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Vergi Dairesi"
                      value={taxOffice}
                      onChange={(e) => setTaxOffice(e.target.value)}
                      className="w-1/2 bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                    />
                    <input
                      type="text"
                      placeholder="Vergi No / T.C."
                      value={taxNo}
                      onChange={(e) => setTaxNo(e.target.value)}
                      className="w-1/2 bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 font-mono focus:outline-none focus:border-blue-600"
                    />
                  </div>
                </div>

                <div className="sm:col-span-6">
                  <label className="block text-slate-700 font-semibold mb-1">Özel Notlar</label>
                  <input
                    type="text"
                    placeholder="Sözleşme şartları, ödeme günleri vb."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsAddingParty(false)}
                  className="px-4 py-2 rounded-lg bg-slate-200 text-slate-700 font-medium hover:bg-slate-300 transition"
                >
                  Vazgeç
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold transition shadow-sm disabled:opacity-50"
                >
                  {isSubmitting ? 'Kaydediliyor...' : 'Cariyi Kaydet'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* 2. GENEL FİNANSAL KPI KARTLARI */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-500 uppercase">Kayıtlı Cari Sayısı</span>
          <h3 className="text-xl font-bold font-mono text-slate-900 mt-1">{parties.length} Firma / Usta</h3>
          <p className="text-[10px] text-slate-400 mt-0.5">{partyMetrics.size} aktif işlem gören</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-500 uppercase">Toplam İş Hacmi (Fatura)</span>
          <h3 className="text-xl font-bold font-mono text-blue-700 mt-1">{formatMoney(totalBilledAll)}</h3>
          <p className="text-[10px] text-slate-400 mt-0.5">Tüm carilere tahakkuk eden</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-500 uppercase">Toplam Ödenen Tutar</span>
          <h3 className="text-xl font-bold font-mono text-emerald-700 mt-1">{formatMoney(totalPaidAll)}</h3>
          <p className="text-[10px] text-emerald-600 mt-0.5">Kapatılmış borçlar</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-500 uppercase">Kalan Borç / Vadeli Çek</span>
          <h3 className="text-xl font-bold font-mono text-rose-600 mt-1">{formatMoney(totalPendingAll)}</h3>
          <p className="text-[10px] text-rose-500 mt-0.5">Ödenmesi bekleyen bakiyeler</p>
        </div>
      </div>

      {/* 3. CARİ LİSTESİ VE DETAY EKSTRESİ (2 KOLONLU) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* SOL: CARİLER LİSTESİ */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-4">
          {/* Arama & Filtre */}
          <div className="space-y-2.5">
            <div className="relative">
              <Search className="h-4 w-4 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                placeholder="Cari adı, telefon veya vergi no ara..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-slate-50 border border-slate-300 rounded-lg pl-9 pr-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="flex gap-1 overflow-x-auto pb-1 text-[11px]">
              {['all', 'supplier', 'subcontractor', 'partner'].map((tKey) => (
                <button
                  key={tKey}
                  onClick={() => setFilterType(tKey)}
                  className={`px-2.5 py-1 rounded-md font-semibold whitespace-nowrap transition ${
                    filterType === tKey
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {tKey === 'all' && 'Tümü'}
                  {tKey === 'supplier' && 'Tedarikçiler'}
                  {tKey === 'subcontractor' && 'Taşeronlar'}
                  {tKey === 'partner' && 'Ortaklar'}
                </button>
              ))}
            </div>
          </div>

          {/* Liste */}
          <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
            {filteredParties.length === 0 ? (
              <div className="text-center py-12 text-xs text-slate-400">
                Aradığınız kriterde cari bulunamadı.
              </div>
            ) : (
              filteredParties.map((p) => {
                const isSelected = selectedParty?.id === p.id;
                const m = partyMetrics.get(p.name.toLowerCase()) || {
                  totalBilled: 0,
                  totalPaid: 0,
                  pendingDebt: 0,
                  overdueDebt: 0,
                  count: 0,
                  transactions: [],
                };
                const tInfo = typeLabels[p.type] || typeLabels.supplier;

                return (
                  <div
                    key={p.id}
                    onClick={() => setSelectedParty(p)}
                    className={`p-3.5 rounded-xl border cursor-pointer transition text-xs ${
                      isSelected
                        ? 'bg-blue-50/70 border-blue-400 shadow-sm'
                        : 'bg-slate-50/60 border-slate-200 hover:bg-slate-100/70'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                        <span>{p.name}</span>
                        <span className={`text-[10px] px-2 py-0.2 rounded-full font-medium border ${tInfo.color}`}>
                          {tInfo.label}
                        </span>
                      </div>

                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteParty(p.id, p.name);
                        }}
                        className="p-1 rounded text-slate-400 hover:text-rose-600 transition"
                        title="Cariyi Sil"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="mt-2 flex items-center justify-between text-[11px] pt-2 border-t border-slate-200/60">
                      <span className="text-slate-500">{m.count} adet işlem</span>
                      <div className="text-right">
                        <span className="text-slate-500 mr-2">Kalan Borç:</span>
                        <span className={`font-mono font-bold ${m.pendingDebt > 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                          {formatMoney(m.pendingDebt)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* SAĞ: SEÇİLİ CARİNİN HESAP EKSTRESİ (KARNESİ) */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-4">
          {!selectedParty ? (
            <div className="text-center py-24 text-slate-400 text-xs">
              <Building className="h-10 w-10 mx-auto mb-2 text-slate-300" />
              <p className="font-semibold text-slate-600 text-sm">Cari Karnesini Görüntüleyin</p>
              <p className="mt-1">Detaylı hesap ekstresi ve faturalarını incelemek için sol listeden bir cari seçiniz.</p>
            </div>
          ) : (
            <>
              {/* Cari Başlığı & Kimlik Bilgileri */}
              <div className="border-b border-slate-200 pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-base font-bold text-slate-900">{selectedParty.name}</h3>
                    <span className="text-xs text-slate-500 capitalize">{typeLabels[selectedParty.type]?.label || selectedParty.type}</span>
                  </div>

                  <span className={`text-xs font-bold px-3 py-1 rounded-lg font-mono ${
                    (selectedMetrics?.pendingDebt || 0) > 0
                      ? 'bg-rose-50 text-rose-700 border border-rose-200'
                      : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  }`}>
                    {(selectedMetrics?.pendingDebt || 0) > 0 ? `Borç: ${formatMoney(selectedMetrics!.pendingDebt)}` : 'Borç Kapatıldı ✓'}
                  </span>
                </div>

                {/* İletişim Bilgileri Rozetleri */}
                <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-slate-600">
                  {selectedParty.phone && (
                    <span className="flex items-center gap-1">
                      <Phone className="h-3.5 w-3.5 text-blue-600" />
                      {selectedParty.phone}
                    </span>
                  )}
                  {selectedParty.email && (
                    <span className="flex items-center gap-1">
                      <Mail className="h-3.5 w-3.5 text-emerald-600" />
                      {selectedParty.email}
                    </span>
                  )}
                  {selectedParty.taxNo && (
                    <span className="flex items-center gap-1 font-mono">
                      <FileText className="h-3.5 w-3.5 text-purple-600" />
                      {selectedParty.taxOffice ? `${selectedParty.taxOffice} VD - ` : ''}{selectedParty.taxNo}
                    </span>
                  )}
                  {selectedParty.iban && (
                    <span className="flex items-center gap-1 font-mono text-[11px] bg-slate-100 px-2 py-0.5 rounded">
                      <CreditCard className="h-3.5 w-3.5 text-slate-500" />
                      {selectedParty.iban}
                    </span>
                  )}
                </div>
              </div>

              {/* Cari KPI'ları */}
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <span className="text-slate-500 block text-[10px] uppercase font-semibold">Toplam Fatura / İş</span>
                  <span className="font-bold font-mono text-slate-900 text-sm mt-0.5 block">
                    {formatMoney(selectedMetrics?.totalBilled || 0)}
                  </span>
                </div>

                <div className="bg-emerald-50/70 p-3 rounded-lg border border-emerald-200">
                  <span className="text-emerald-800 block text-[10px] uppercase font-semibold">Ödenen Tutar</span>
                  <span className="font-bold font-mono text-emerald-700 text-sm mt-0.5 block">
                    {formatMoney(selectedMetrics?.totalPaid || 0)}
                  </span>
                </div>

                <div className="bg-rose-50/70 p-3 rounded-lg border border-rose-200">
                  <span className="text-rose-800 block text-[10px] uppercase font-semibold">Kalan Borç Bakiyesi</span>
                  <span className="font-bold font-mono text-rose-700 text-sm mt-0.5 block">
                    {formatMoney(selectedMetrics?.pendingDebt || 0)}
                  </span>
                </div>
              </div>

              {/* Hesap Ekstresi Tablosu */}
              <div className="space-y-2 pt-2">
                <span className="text-xs font-bold text-slate-800 block">
                  İşlem Ekstresi ({selectedMetrics?.transactions.length || 0} kayıt)
                </span>

                <div className="border border-slate-200 rounded-lg overflow-hidden">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-100 text-slate-700 font-semibold uppercase border-b border-slate-200">
                        <th className="py-2 px-3">Tarih</th>
                        <th className="py-2 px-3">Açıklama / Kalem</th>
                        <th className="py-2 px-3">Kategori</th>
                        <th className="py-2 px-3 text-center">Durum</th>
                        <th className="py-2 px-3 text-right">Tutar</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {(!selectedMetrics || selectedMetrics.transactions.length === 0) ? (
                        <tr>
                          <td colSpan={5} className="py-8 text-center text-slate-400">
                            Bu cariye ait henüz bir harcama veya fatura hareketi bulunmuyor.
                          </td>
                        </tr>
                      ) : (
                        selectedMetrics.transactions.map((t) => (
                          <tr key={t.id} className="hover:bg-slate-50">
                            <td className="py-2 px-3 font-mono text-slate-600">{t.date.split('T')[0]}</td>
                            <td className="py-2 px-3 font-medium text-slate-900">{t.title}</td>
                            <td className="py-2 px-3 text-slate-600">{categoryMap.get(t.categoryId)?.name || '-'}</td>
                            <td className="py-2 px-3 text-center">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                                t.isPaid
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                                  : 'bg-amber-50 text-amber-700 border-amber-300'
                              }`}>
                                {t.isPaid ? 'Ödendi' : 'Vadeli'}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-right font-bold font-mono text-slate-900">
                              {formatMoney(t.amount)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
