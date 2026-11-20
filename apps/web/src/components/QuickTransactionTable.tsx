import React, { useState } from 'react';
import { Plus, Search, Tag, CheckCircle2, Link as LinkIcon, UserCheck, Edit2, Trash2, Check, Filter } from 'lucide-react';
import type { Transaction, Category } from '@cost-core/types';
import { useTheme } from '../context/ThemeContext.js';

interface QuickTransactionTableProps {
  canMutate?: boolean;
  transactions: Transaction[];
  categories: Category[];
  onOpenNewModal: () => void;
  onEditTransaction: (tx: Transaction) => void;
  onDeleteTransaction: (id: string) => Promise<void>;
  onMarkPaid: (id: string) => Promise<void>;
  onSearch: (term: string) => void;
  isLoading: boolean;
  selectedProjectId?: string | null;
}

export const QuickTransactionTable: React.FC<QuickTransactionTableProps> = ({
  canMutate = false,
  transactions,
  categories,
  onOpenNewModal,
  onEditTransaction,
  onDeleteTransaction,
  onMarkPaid,
  onSearch,
  isLoading,
  selectedProjectId,
}) => {
  const { settings } = useTheme();

  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategoryId, setFilterCategoryId] = useState('');
  const [filterPaidStatus, setFilterPaidStatus] = useState<string>('all');

  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  // İstemci tarafı filtreleme (Kategori ve Ödeme Durumu)
  const filteredTransactions = transactions.filter((tx) => {
    if (filterCategoryId && tx.categoryId !== filterCategoryId && tx.subcategoryId !== filterCategoryId) {
      return false;
    }
    if (filterPaidStatus === 'paid' && !tx.isPaid) return false;
    if (filterPaidStatus === 'pending' && tx.isPaid) return false;
    return true;
  });

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      {/* Üst Eylem Barı: Arama, Filtreler ve + Yeni Harcama Ekle Butonu */}
      <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 bg-slate-50">
        <div className="flex flex-wrap items-center gap-3">
          {/* Yeni Harcama Ekle Butonu */}
          {canMutate && <button
            onClick={() => { if (canMutate) onOpenNewModal(); }}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-sm transition"
            style={{ backgroundColor: settings.primaryColor }}
          >
            <Plus className="h-4 w-4" />
            <span>+ Yeni Harcama Ekle</span>
          </button>}

          {/* Kategori Filtresi */}
          <div className="flex items-center gap-1.5">
            <Filter className="h-3.5 w-3.5 text-slate-400" />
            <select
              value={filterCategoryId}
              onChange={(e) => setFilterCategoryId(e.target.value)}
              className="bg-white border border-slate-300 text-xs rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-blue-600 font-medium"
            >
              <option value="">Tüm Kategoriler ({categories.length})</option>
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.parentId ? `› ${cat.name}` : cat.name}
                </option>
              ))}
            </select>
          </div>

          {/* Ödeme Durumu Filtresi */}
          <select
            value={filterPaidStatus}
            onChange={(e) => setFilterPaidStatus(e.target.value)}
            className="bg-white border border-slate-300 text-xs rounded-lg px-2.5 py-1.5 text-slate-700 focus:outline-none focus:border-blue-600 font-medium"
          >
            <option value="all">Tüm ödeme durumları</option>
            <option value="paid">Ödenenler</option>
            <option value="pending">Ödenmeyenler</option>
          </select>
        </div>

        {/* Kör İndeksli Arama Kutusu */}
        <div className="relative min-w-[280px]">
          <Search className="h-4 w-4 absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            placeholder="Başlık veya tedarikçi ara (Kör İndeks)..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              onSearch(e.target.value);
            }}
            className="w-full bg-white border border-slate-300 text-xs rounded-lg pl-9 pr-3 py-2 text-slate-900 placeholder-slate-400 focus:outline-none focus:border-blue-600 font-medium"
          />
        </div>
      </div>

      {/* VERİ TABLOSU (Klasik Excel Görünümü) */}
      <div className="overflow-x-auto max-w-full" tabIndex={0} role="region" aria-label="İşlem tablosu yatay kaydırma alanı">
        <table className="w-full min-w-[1100px] whitespace-nowrap text-left text-xs border-collapse">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-100 text-slate-700 font-semibold uppercase tracking-wider">
              <th className="py-2.5 px-3 w-14 text-center">İşlem</th>
              <th className="py-2.5 px-3 w-24">Tarih</th>
              <th className="py-2.5 px-3">Açıklama / Kalem & Okunuş</th>
              <th className="py-2.5 px-3 w-40">Kategori / Kırılım</th>
              <th className="py-2.5 px-3 w-32">Ödeme Kaynağı</th>
              <th className="py-2.5 px-3 w-32">Tedarikçi / Cari</th>
              <th className="py-2.5 px-3 w-32 text-right">Tutar</th>
              <th className="py-2.5 px-3 w-28 text-center">Tür</th>
              <th className="py-2.5 px-3 w-28 text-center">Durum</th>
              <th className="py-2.5 px-3 w-28 text-center">Ödeme</th>
              <th className="py-2.5 px-3 w-28 text-center">Vade</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 font-normal">
            {isLoading ? (
              <tr>
                <td colSpan={11} className="py-8 text-center text-slate-500">
                  Veriler şifresi çözülerek yükleniyor...
                </td>
              </tr>
            ) : filteredTransactions.length === 0 ? (
              <tr>
                <td colSpan={11} className="py-8 text-center text-slate-500">
                  Kayıtlı bir harcama bulunmuyor.
                </td>
              </tr>
            ) : (
              filteredTransactions.map((tx, idx) => {
                const cat = categoryMap.get(tx.categoryId);
                const subCat = tx.subcategoryId ? categoryMap.get(tx.subcategoryId) : null;
                const isOverdue = !tx.isPaid && tx.dueDate && tx.dueDate.split('T')[0] <= new Date().toISOString().split('T')[0];

                return (
                  <tr
                    key={tx.id}
                    className={`hover:bg-blue-50/60 transition-colors ${
                      idx % 2 === 1 ? 'bg-slate-50/40' : 'bg-white'
                    }`}
                  >
                    {/* Düzenle / Sil Aksiyon Butonları */}
                    <td className="py-2 px-3 text-center">
                      {canMutate && <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => { if (canMutate) onEditTransaction(tx); }}
                          className="p-1 rounded text-slate-500 hover:text-blue-700 hover:bg-slate-200 transition"
                          title="Kaydı Düzenle"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            if (!canMutate) return;
                            if (confirm(`"${tx.title}" kaydını silmek istediğinizden emin misiniz?`)) {
                              onDeleteTransaction(tx.id);
                            }
                          }}
                          className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                          title="Kaydı Sil"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>}
                    </td>

                    <td className="py-2 px-3 text-slate-600 font-mono">
                      {tx.date.split('T')[0]}
                    </td>

                    <td className="py-2 px-3 text-slate-900 font-medium">
                      <div className="flex items-center gap-1.5">
                        <span>{tx.title}</span>
                        {tx.otoKasaTransactionId && (
                          <span
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10px] font-semibold bg-blue-100 text-blue-800 border border-blue-200"
                            title="Oto-Kasa Çift Taraflı Mahsup Kaydı"
                          >
                            <LinkIcon className="h-2.5 w-2.5" /> Oto-Kasa
                          </span>
                        )}
                      </div>
                      {tx.amountInWords && (
                        <div className="text-[10px] text-slate-500 italic mt-0.5">
                          {tx.amountInWords}
                        </div>
                      )}
                    </td>

                    <td className="py-2 px-3">
                      {cat && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border"
                          style={{
                            borderColor: `${cat.color}40`,
                            backgroundColor: `${cat.color}15`,
                            color: cat.color,
                          }}
                        >
                          <Tag className="h-3 w-3" />
                          {cat.name}
                          {subCat && ` › ${subCat.name}`}
                        </span>
                      )}
                    </td>

                    <td className="py-2 px-3 text-slate-700">
                      {tx.paymentSource === 'person_out_of_pocket' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700 font-medium">
                          <UserCheck className="h-3.5 w-3.5 text-emerald-600" />
                          {tx.payerPersonName || 'Şahıs'}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-500">🏢 Şirket Kasası</span>
                      )}
                    </td>

                    <td className="py-2 px-3 text-slate-700 font-medium">
                      {tx.party || '-'}
                    </td>

                    <td className="py-2 px-3 text-right font-bold font-mono text-slate-900 text-[13px]">
                      {new Intl.NumberFormat('tr-TR', {
                        style: 'currency',
                        currency: tx.currency || 'TRY',
                      }).format(tx.amount)}
                    </td>

                    <td className="py-2 px-3 text-center">{tx.type || 'Belirtilmemiş'}</td>
                    <td className="py-2 px-3 text-center">
                      {tx.status || 'Belirtilmemiş'}{tx.deletedAt && <span> Silinmiş</span>}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <span>{tx.isPaid === true ? 'Ödendi' : tx.isPaid === false ? 'Ödenmedi' : 'Belirtilmemiş'}</span>
                        {!tx.isPaid && canMutate && <button
                          onClick={() => { if (canMutate) void onMarkPaid(tx.id); }}
                          className="text-[10px] text-blue-700 hover:text-blue-900 font-semibold underline flex items-center gap-0.5"
                          title="Şimdi Ödendi Olarak İşaretle"
                        >
                          <Check className="h-3 w-3" /> Ödendi Yap
                        </button>}
                      </div>
                    </td>
                    <td className="py-2 px-3 text-center">
                      {tx.dueDate ? (
                        <div className="flex flex-col items-center gap-1">
                          <span>{tx.dueDate.split('T')[0]}</span>
                          {tx.isPaid === true ? <span>Ödendi</span> : tx.isPaid === false ? <span>{isOverdue ? 'Vadesi geçmiş' : 'Vadeli'}</span> : null}
                        </div>
                      ) : 'Vade belirtilmedi'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
