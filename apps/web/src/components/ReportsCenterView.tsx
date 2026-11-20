import React, { useState } from 'react';
import {
  Calendar,
  Download,
  Printer,
  Search,
  Filter,
  ArrowUpRight,
  ArrowDownRight,
  Wallet,
  TrendingUp,
  TrendingDown,
  Clock,
  Layers,
  FileSpreadsheet,
} from 'lucide-react';
import type { Transaction, Category } from '@cost-core/types';
import { useTheme } from '../context/ThemeContext.js';

import { computeReportFinance } from '../report-finance.js';
import { buildReportCSV } from '../report-csv.js';

const localDate = (date: Date) => [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');

interface ReportsCenterViewProps {
  transactions: Transaction[];
  categories: Category[];
  baseCurrency?: string;
  isLoading?: boolean;
  subView?: 'date_range' | 'daily' | 'monthly_yearly';
}

export const ReportsCenterView: React.FC<ReportsCenterViewProps> = ({
  transactions,
  categories,
  subView,
  baseCurrency,
  isLoading = false,
}) => {
  const { settings } = useTheme();
  const currency = baseCurrency || settings.baseCurrency || 'TRY';

  const [activeTab, setActiveTab] = useState<'date_range' | 'daily' | 'monthly_yearly'>('date_range');
  const currentTab = subView || activeTab;

  // 1. TARİH ARALIĞI FİLTRELERİ
  const now = new Date();
  const firstDayOfMonth = localDate(new Date(now.getFullYear(), now.getMonth(), 1));
  const todayStr = localDate(now);

  const [startDate, setStartDate] = useState(firstDayOfMonth);
  const [endDate, setEndDate] = useState(todayStr);
  const [filterCategoryId, setFilterCategoryId] = useState('');
  const [filterParty, setFilterParty] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // 2. GÜNLÜK RAPOR TARİHİ
  const [selectedDay, setSelectedDay] = useState(todayStr);

  // 3. YILLIK RAPOR YILI
  const [selectedYear, setSelectedYear] = useState<number>(now.getFullYear());
  const [yearDraft, setYearDraft] = useState(String(now.getFullYear()).padStart(4, '0'));

  const formatMoney = (val: number, code = currency) => {
    return new Intl.NumberFormat('tr-TR', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(val || 0);
  };

  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  // Hızlı Tarih Aralıkları
  const setQuickRange = (range: 'this_month' | 'last_month' | 'last_30_days' | 'this_year' | 'all') => {
    const d = new Date();
    if (range === 'this_month') {
      setStartDate(localDate(new Date(d.getFullYear(), d.getMonth(), 1)));
      setEndDate(localDate(d));
    } else if (range === 'last_month') {
      const first = localDate(new Date(d.getFullYear(), d.getMonth() - 1, 1));
      const last = localDate(new Date(d.getFullYear(), d.getMonth(), 0));
      setStartDate(first);
      setEndDate(last);
    } else if (range === 'last_30_days') {
      const past = new Date(d);
      past.setDate(past.getDate() - 29);
      setStartDate(localDate(past));
      setEndDate(localDate(d));
    } else if (range === 'this_year') {
      setStartDate(localDate(new Date(d.getFullYear(), 0, 1)));
      setEndDate(localDate(d));
    } else if (range === 'all') {
      setStartDate('2020-01-01');
      setEndDate('2035-12-31');
    }
  };

  // 1. Filtrelenmiş Tarih Aralığı Verileri
  const rangeFilteredTransactions = transactions.filter((t) => {
    const tDate = t.date.split('T')[0];
    if (startDate && tDate < startDate) return false;
    if (endDate && tDate > endDate) return false;
    if (filterCategoryId && t.categoryId !== filterCategoryId && t.subcategoryId !== filterCategoryId) return false;
    if (filterParty && !(t.party || '').toLowerCase().includes(filterParty.toLowerCase())) return false;
    if (filterStatus === 'paid' && !t.isPaid) return false;
    if (filterStatus === 'pending' && t.isPaid) return false;
    return true;
  });

  const rangeFinance = computeReportFinance(rangeFilteredTransactions, currency);

  // 2. Günlük Rapor Verileri
  const dayTransactions = transactions.filter((t) => t.date.split('T')[0] === selectedDay);
  const dayFinance = computeReportFinance(dayTransactions, currency);

  // 3. Aylık / Yıllık Konsolide Rapor Verileri
  const months = [
    'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
    'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
  ];

  const yearKey = String(selectedYear).padStart(4, '0');
  const yearTransactions = transactions.filter((t) => t.date.startsWith(yearKey + '-'));
  const yearFinance = computeReportFinance(yearTransactions, currency);
  const yearCurrencies = [currency, ...yearFinance.excludedCurrencies];
  const monthlyMatrix = months.map((monthName, index) => {
    const monthKey = `${yearKey}-${String(index + 1).padStart(2, '0')}`;
    const monthTransactions = yearTransactions.filter((t) => t.date.startsWith(monthKey + '-'));
    return { monthName, monthKey, finance: computeReportFinance(monthTransactions, currency), transactions: monthTransactions };
  });

  // Raporu CSV Olarak İndirme
  const exportRangeCSV = () => {
    if (isLoading || rangeFilteredTransactions.length === 0) return;

    let objectUrl: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      const csv = buildReportCSV(rangeFilteredTransactions, categories);
      objectUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      link = document.createElement('a');
      link.href = objectUrl;
      link.download = 'TZR_Cost_Tracker_Rapor_' + startDate + '_' + endDate + '.csv';
      document.body.appendChild(link);
      link.click();
    } catch {
      alert('Rapor indirilemedi. L\u00fctfen tekrar deneyin.');
    } finally {
      try {
        link?.remove();
      } finally {
        if (objectUrl !== undefined) {
          const urlToRevoke = objectUrl;
          setTimeout(() => URL.revokeObjectURL(urlToRevoke), 1000);
        }
      }
    }
  };

  if (isLoading) return <div role={'status'}>Rapor yükleniyor...</div>;

  return (
    <div className="space-y-6">
      {/* BAŞLIK & SEKMELER */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-blue-600" />
              <span>
                {currentTab === 'date_range' && 'Özel Tarih Aralıklı Maliyet Raporu'}
                {currentTab === 'daily' && 'Günlük mali hareket özeti'}
                {currentTab === 'monthly_yearly' && 'Aylık ve yıllık mali hareket özeti'}
              </span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {currentTab === 'date_range' && 'Seçtiğiniz tarih aralığı, kategori ve tedarikçiye göre filtrelenmiş gelir/gider dökümü'}
              {currentTab === 'daily' && 'Yüklenen kayıtlardan, seçilen güne göre hesaplanır. Nakit akışı açılış ve güncel cüzdan bakiyelerini içermez.'}
              {currentTab === 'monthly_yearly' && 'Yüklenen kayıtlardan, seçilen yıla göre hesaplanır. Nakit akışı açılış ve güncel cüzdan bakiyelerini içermez.'}
            </p>
          </div>

          {/* Sadece subView verilmediyse sekme butonlarını göster */}
          {!subView && (
            <div className="flex rounded-lg bg-slate-100 p-1 border border-slate-200">
              <button
                onClick={() => setActiveTab('date_range')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                  currentTab === 'date_range'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                📅 Özel Tarih Aralığı
              </button>
              <button
                onClick={() => setActiveTab('daily')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                  currentTab === 'daily'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                📆 Günlük Kasa
              </button>
              <button
                onClick={() => setActiveTab('monthly_yearly')}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition ${
                  currentTab === 'monthly_yearly'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                🗓️ Aylık ve yıllık özet
              </button>
            </div>
          )}
        </div>

        {/* 1. SEKME: ÖZEL TARİH ARALIĞI RAPORU */}
        {currentTab === 'date_range' && (
          <div className="pt-4 space-y-5">
            {/* Filtre Kontrol Paneli */}
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
                <span className="font-bold text-slate-800 flex items-center gap-1.5">
                  <Filter className="h-4 w-4 text-slate-500" />
                  Rapor Kriterlerini Belirleyin:
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setQuickRange('this_month')}
                    className="px-2.5 py-1 rounded bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium text-[11px]"
                  >
                    Bu Ay
                  </button>
                  <button
                    onClick={() => setQuickRange('last_month')}
                    className="px-2.5 py-1 rounded bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium text-[11px]"
                  >
                    Geçen Ay
                  </button>
                  <button
                    onClick={() => setQuickRange('last_30_days')}
                    className="px-2.5 py-1 rounded bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium text-[11px]"
                  >
                    Son 30 Gün
                  </button>
                  <button
                    onClick={() => setQuickRange('this_year')}
                    className="px-2.5 py-1 rounded bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium text-[11px]"
                  >
                    Bu Yıl
                  </button>
                  <button
                    onClick={() => setQuickRange('all')}
                    className="px-2.5 py-1 rounded bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium text-[11px]"
                  >
                    Tüm Zamanlar
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div className="sm:col-span-3">
                  <label className="block text-slate-600 font-medium mb-1">Başlangıç Tarihi</label>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-blue-600"
                  />
                </div>

                <div className="sm:col-span-3">
                  <label className="block text-slate-600 font-medium mb-1">Bitiş Tarihi</label>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-blue-600"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-slate-600 font-medium mb-1">Kategori Filtresi</label>
                  <select
                    value={filterCategoryId}
                    onChange={(e) => setFilterCategoryId(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-slate-800 focus:outline-none focus:border-blue-600"
                  >
                    <option value="">Tümü ({categories.length})</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.parentId ? `› ${c.name}` : c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-slate-600 font-medium mb-1">Ödeme Durumu</label>
                  <select
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2 py-1.5 text-slate-800 focus:outline-none focus:border-blue-600"
                  >
                    <option value="all">Tüm Durumlar</option>
                    <option value="paid">✅ Sadece Peşin Ödenenler</option>
                    <option value="pending">⏳ Sadece Vadeli / Bekleyenler</option>
                  </select>
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-slate-600 font-medium mb-1">Cari / Tedarikçi</label>
                  <input
                    type="text"
                    placeholder="Firma ara..."
                    value={filterParty}
                    onChange={(e) => setFilterParty(e.target.value)}
                    className="w-full bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-slate-800 focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>
            </div>

            {/* Dönem Özet KPI Kartları */}
            <section aria-label={'Dönem finansal özeti'} className={'space-y-3'}>
              <p>Yüklenen kayıtlardan, seçili filtrelere göre hesaplanır. Nakit akışı açılış ve güncel cüzdan bakiyelerini içermez.</p>
              {rangeFinance.excludedCurrencies.length > 0 && <p role={'alert'}>Ana para birimi özeti kısmidir; diğer para birimleri ayrı gösterilir: {rangeFinance.excludedCurrencies.join(', ')}</p>}
              {[currency, ...rangeFinance.excludedCurrencies].map((code) => {
                const totals = code === currency ? rangeFinance : rangeFinance.byCurrency[code];
                return (
                  <section key={code} aria-label={`Finansal özet ${code}`} className={'rounded-xl border border-slate-200 p-4'}>
                    <h3 className={'font-bold'}>{code}{code === currency ? ' (Ana para birimi)' : ''}</h3>
                    <dl className={'grid grid-cols-1 sm:grid-cols-3 gap-3'}>
                      <div><dt>Tanınan gelir</dt><dd>{formatMoney(totals.totalIncome, code)}</dd></div>
                      <div><dt>Tanınan gider</dt><dd>{formatMoney(totals.totalExpense, code)}</dd></div>
                      <div><dt>Bekleyen şirket borcu</dt><dd>{formatMoney(totals.totalPendingExpense, code)}</dd></div>
                      <div><dt>Faaliyet neti</dt><dd>{formatMoney(totals.netBalance, code)}</dd></div>
                      <div><dt>Dönem net nakit akışı</dt><dd>{formatMoney(totals.cashFlowNet, code)}</dd></div>
                      <div><dt>Tanınan işlem adedi</dt><dd>{totals.transactionCount}</dd></div>
                    </dl>
                  </section>
                );
              })}
            </section>
            {/* Dışa Aktarma Butonları & Döküm Başlığı */}
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs font-bold text-slate-800">
                Filtrelenen ham kayıtlar ({rangeFilteredTransactions.length} kayıt)
              </span>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-medium shadow-sm transition"
                >
                  <Printer className="h-3.5 w-3.5 text-slate-500" />
                  <span>Yazdır / PDF</span>
                </button>
                <button
                  onClick={exportRangeCSV}
                  disabled={isLoading || rangeFilteredTransactions.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-sm transition"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>Excel / CSV İndir</span>
                </button>
              </div>
            </div>

            {/* Filtrelenmiş Liste Tablosu */}
            <div className="border border-slate-200 rounded-xl overflow-x-auto max-w-full" role="region" aria-label="Filtrelenen ham kayıtlar tablosu" tabIndex={0}>
              <table className="w-full min-w-[800px] text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100 text-slate-700 font-semibold uppercase border-b border-slate-200">
                    <th className="py-2.5 px-3 w-24">Tarih</th>
                    <th className="py-2.5 px-3 w-28">İşlem Türü</th>
                    <th className="py-2.5 px-3">Kalem / Açıklama</th>
                    <th className="py-2.5 px-3 w-36">Kategori</th>
                    <th className="py-2.5 px-3 w-32">Cari / Tedarikçi</th>
                    <th className="py-2.5 px-3 w-28 text-center">Durum</th>
                    <th className="py-2.5 px-3 w-32 text-right">Tutar</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {rangeFilteredTransactions.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500">
                        Seçilen kriterlere uygun herhangi bir kayıt bulunamadı.
                      </td>
                    </tr>
                  ) : (
                    rangeFilteredTransactions.map((t) => {
                      const cat = categoryMap.get(t.categoryId);
                      return (
                        <tr key={t.id} className="hover:bg-slate-50">
                          <td className="py-2 px-3 font-mono text-slate-600">{t.date.split('T')[0]}</td>
                          <td className="py-2 px-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                t.type === 'income'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-rose-100 text-rose-800'
                              }`}
                            >
                              {t.type === 'income' ? (t.otoKasaTransactionId || t.paymentSource === 'person_out_of_pocket' ? 'Şahıs finansmanı — OTO yansıması' : 'Gelir') : t.type === 'transfer' ? 'Virman' : 'Gider'}
                            </span>
                          </td>
                          <td className="py-2 px-3 font-medium text-slate-900">{t.title}</td>
                          <td className="py-2 px-3 text-slate-600">{cat?.name || '-'}</td>
                          <td className="py-2 px-3 text-slate-600">{t.party || '-'}</td>
                          <td className="py-2 px-3 text-center">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                                t.isPaid
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                                  : 'bg-amber-50 text-amber-700 border-amber-300'
                              }`}
                            >
                              {({ approved: 'Onaylandı', pending: 'Bekliyor', paid: 'Ödendi', draft: 'Taslak', rejected: 'Reddedildi' } as Record<string, string>)[t.status] || t.status} / {t.isPaid ? 'Ödendi' : 'Ödenmedi'}
                            </span>
                            {t.deletedAt && <span className="block text-xs font-semibold text-rose-700">Silinmiş — toplamlara dahil değil</span>}
                          </td>
                          <td
                            className={`py-2 px-3 text-right font-bold font-mono ${
                              t.type === 'income' ? 'text-emerald-700' : 'text-slate-900'
                            }`}
                          >
                            {formatMoney(t.amount, t.currency)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 2. SEKME: GÜNLÜK KASA & HARCAMA ÖZETİ */}
        {currentTab === 'daily' && (
          <div className="pt-4 space-y-5">
            {/* Gün Seçici Kontrolü */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-blue-600" />
                <span className="text-xs font-bold text-slate-800">Raporlanacak Günü Seçin:</span>
                <input
                  type="date"
                  value={selectedDay}
                  onChange={(e) => setSelectedDay(e.target.value)}
                  className="bg-white border border-slate-300 rounded-lg px-3 py-1.5 text-xs text-slate-900 font-semibold focus:outline-none focus:border-blue-600"
                />
              </div>

              <div className="flex items-center gap-1.5 text-xs">
                <button
                  onClick={() => {
                    const [year, month, day] = selectedDay.split('-').map(Number); const prev = new Date(year, month - 1, day);
                    prev.setDate(prev.getDate() - 1);
                    setSelectedDay(localDate(prev));
                  }}
                  className="px-3 py-1 rounded bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium"
                >
                  ◀ Önceki Gün
                </button>
                <button
                  onClick={() => setSelectedDay(todayStr)}
                  className="px-3 py-1 rounded bg-blue-50 border border-blue-300 text-blue-700 font-semibold"
                >
                  Bugün
                </button>
                <button
                  onClick={() => {
                    const [year, month, day] = selectedDay.split('-').map(Number); const next = new Date(year, month - 1, day);
                    next.setDate(next.getDate() + 1);
                    setSelectedDay(localDate(next));
                  }}
                  className="px-3 py-1 rounded bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 font-medium"
                >
                  Sonraki Gün ▶
                </button>
              </div>
            </div>

            {dayFinance.excludedCurrencies.length > 0 && <p role={'alert'}>Ana para birimi özeti kısmidir; diğer para birimleri ayrı gösterilir: {dayFinance.excludedCurrencies.join(', ')}. Dönüşüm yapılmaz.</p>}
            {[currency, ...dayFinance.excludedCurrencies].map((code) => {
              const totals = code === currency ? dayFinance : dayFinance.byCurrency[code];
              return (
                <section aria-label={'Günlük finansal özet ' + code} key={code} className={'min-w-0 rounded-xl border border-slate-200 bg-white p-4'}>
                  <h3 className={'font-bold mb-3'}>{code}</h3>
                  <dl className={'grid grid-cols-1 sm:grid-cols-2 gap-3 break-words'} style={{ overflowWrap: 'anywhere' }}>
                    <div><dt>Tanınan gelir</dt><dd>{formatMoney(totals.totalIncome, code)}</dd></div>
                    <div><dt>Tanınan gider</dt><dd>{formatMoney(totals.totalExpense, code)}</dd></div>
                    <div><dt>Faaliyet neti</dt><dd>{formatMoney(totals.netBalance, code)}</dd></div>
                    <div><dt>Günün net şirket nakit akışı</dt><dd>{formatMoney(totals.cashFlowNet, code)}</dd></div>
                    <div><dt>Bekleyen şirket borcu</dt><dd>{formatMoney(totals.totalPendingExpense, code)}</dd></div>
                    <div><dt>Şahıs tarafından ödenen gider</dt><dd>{formatMoney(totals.personFundedExpenseTotal, code)}</dd></div>
                    <div><dt>Tanınan işlem adedi</dt><dd>{totals.transactionCount}</dd></div>
                  </dl>
                </section>
              );
            })}
            <section aria-label={'Günün ham kayıtları'} className={'min-w-0 rounded-xl border border-slate-200 bg-white p-4'}>
              <h3 className={'font-bold mb-3'}>Günün ham kayıtları ({dayTransactions.length} ham kayıt)</h3>
              {dayTransactions.length === 0 ? <p>Bu gün için kayıt bulunamadı.</p> : (
                <ul className={'divide-y divide-slate-100'}>
                  {dayTransactions.map((t) => {
                    const status = t.status === 'approved' ? 'Onaylandı' : t.status === 'pending' ? 'Bekliyor' : t.status === 'paid' ? 'Ödendi' : t.status === 'draft' ? 'Taslak' : t.status === 'rejected' ? 'Reddedildi' : 'Bilinmeyen durum: ' + String(t.status);
                    const type = t.type === 'income' ? 'Gelir' : t.type === 'expense' ? 'Gider' : t.type === 'transfer' ? 'Virman' : String(t.type);
                    const oto = t.type === 'income' && (t.otoKasaTransactionId || t.paymentSource === 'person_out_of_pocket');
                    return (
                      <li key={t.id} className={'min-w-0 py-3 break-words'} style={{ overflowWrap: 'anywhere' }}>
                        <div className={'font-semibold'}>{t.title}</div>
                        {t.party && <div>{t.party}</div>}
                        <div>{type} · {status} · {t.isPaid ? 'Ödendi' : 'Ödenmedi'}</div>
                        {oto && <div>Şahıs finansmanı — OTO yansıması</div>}
                        {t.deletedAt && <div>Silinmiş — toplamlara dahil değil</div>}
                        <div className={'font-mono font-bold'}>{formatMoney(t.amount, t.currency)} ({t.currency})</div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}

        {/* 3. SEKME: 12 AYLIK YILLIK KONSOLİDE RAPOR */}
        {currentTab === 'monthly_yearly' && (
          <div className="pt-4 space-y-5 min-w-0">
            <div className="flex flex-wrap items-center gap-3 bg-slate-50 border border-slate-200 rounded-xl p-4">
              <label htmlFor="report-year" className="text-xs font-bold text-slate-800">Rapor yılı</label>
              <input id="report-year" type="text" inputMode="numeric" maxLength={4} value={yearDraft} onChange={(event) => {
                const draft = event.target.value;
                setYearDraft(draft);
                if (/^[0-9]{4}$/.test(draft) && Number(draft) >= 1 && Number(draft) <= 9999) setSelectedYear(Number(draft));
              }} className="w-28 max-w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </div>
            {yearFinance.mixedCurrency && <p className="text-sm text-amber-800">Baz para birimi özeti kısmidir; diğer para birimleri ayrı gösterilir, dönüşüm yapılmaz.</p>}
            {yearCurrencies.map((code) => {
              const annual = yearFinance.byCurrency[code] ?? computeReportFinance(yearTransactions, code);
              return (
                <section key={code} className="min-w-0 max-w-full space-y-2">
                  <h3 className="font-bold text-slate-900">{code} — {yearKey} {code === currency ? '(baz para birimi)' : ''}</h3>
                  <div aria-label={`Aylık mali özet ${code} ${yearKey}`} role="region" tabIndex={0} className="overflow-x-auto max-w-full min-w-0 border border-slate-200 rounded-xl">
                    <table className="w-full min-w-[1000px] text-left text-xs border-collapse">
                      <caption>{code} — {yearKey} aylık ve yıllık mali hareketler</caption>
                      <thead><tr className="bg-slate-100 text-slate-700">{['Ay', 'Tanınan gelir', 'Tanınan gider', 'Bekleyen şirket borcu', 'Faaliyet neti', 'Net şirket nakit akışı', 'Tanınan işlem adedi', 'Yıllık gider payı'].map((label) => <th key={label} scope="col" className="p-3">{label}</th>)}</tr></thead>
                      <tbody>{monthlyMatrix.map((month) => {
                        const totals = month.finance.byCurrency[code] ?? computeReportFinance(month.transactions, code);
                        const share = annual.totalExpense > 0 ? totals.totalExpense / annual.totalExpense * 100 : 0;
                        return <tr key={month.monthKey} className="border-t border-slate-200">
                          <th scope="row" className="p-3">{month.monthName}</th>
                          {[totals.totalIncome, totals.totalExpense, totals.totalPendingExpense, totals.netBalance, totals.cashFlowNet].map((value, index) => <td key={index} className="p-3 text-right font-mono">{formatMoney(value, code)}</td>)}
                          <td className="p-3 text-right">{totals.transactionCount}</td><td className="p-3 text-right">%{share.toFixed(1)}</td>
                        </tr>;
                      })}</tbody>
                      <tfoot><tr className="bg-slate-100 font-bold"><td className="p-3">Yıllık toplam</td>
                        {[annual.totalIncome, annual.totalExpense, annual.totalPendingExpense, annual.netBalance, annual.cashFlowNet].map((value, index) => <td key={index} className="p-3 text-right font-mono">{formatMoney(value, code)}</td>)}
                        <td className="p-3 text-right">{annual.transactionCount}</td><td className="p-3 text-right">%{annual.totalExpense > 0 ? '100.0' : '0.0'}</td>
                      </tr></tfoot>
                    </table>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
