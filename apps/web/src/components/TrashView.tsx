import { useLocale } from '../context/LocaleContext.js';
import React, { useState, useLayoutEffect, useSyncExternalStore } from 'react';
import { Trash2, RotateCcw, AlertTriangle, ShieldCheck, RefreshCw, CheckCircle2 } from 'lucide-react';
import type { Transaction, Category } from '@cost-core/types';
import { useTheme } from '../context/ThemeContext.js';
import { TrashController } from '../trash-management.js';
import { canMutateTrash } from '../view-access.js';

interface TrashViewProps {
  role?: string;
  selectedProjectId?: string | null;
  categories: Category[];
  onRestored: () => Promise<void>;
}

export const TrashView: React.FC<TrashViewProps> = ({ categories, onRestored, role, selectedProjectId = null }) => {
  const { t: copy, intlLocale, language } = useLocale();
  const { settings } = useTheme();
  const currency = settings.baseCurrency || 'TRY';

  const [controller] = useState(() => new TrashController());
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const trashList = state.items as Transaction[], isLoading = state.loading, actionNotice = state.notice;
  const canMutate = canMutateTrash(role);
  useLayoutEffect(controller.connect, [controller]);
  useLayoutEffect(() => { controller.configure({ role, selectedProjectId, onRestored }); void controller.reload(); return () => controller.configure({}); }, [controller, role, selectedProjectId, onRestored]);

  const formatMoney = (val: number) => {
    return new Intl.NumberFormat(intlLocale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(val || 0);
  };

  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  const fetchTrash = () => { void controller.reload(); };
  const handleRestore = (id: string, _title: string) => { if (canMutate) void controller.restore(id); };

  const handlePermanentDelete = async (id: string, title: string) => {
    if (!canMutate) return;
    if (!confirm(copy(`"${title}" kaydı veritabanından KALICI OLARAK silinecektir. Bu işlem geri alınamaz!\nOnaylıyor musunuz?`, `Permanently delete “${title}”? This action cannot be undone.`))) {
      return;
    }

    await controller.permanentDelete(id);
  };

  const totalTrashAmount = trashList.reduce((s, t) => s + t.amount, 0);

  return (
    <div className="space-y-6">
      {/* BAŞLIK & BİLGİ KARTI */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center font-bold">
              <Trash2 className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <span>{copy("Çöp Kutusu & Silinen Kayıtları Geri Alma (Soft-Delete)", "Trash and deleted records")}</span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {copy("Yanlışlıkla silinen harcama ve kasa kayıtları burada tutulur. İstediğiniz an tek tıkla geri kurtarabilirsiniz.", "Restore expenses and cash transactions that were moved to the trash.")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right text-xs">
              <span className="text-slate-500 block">{copy("Çöp Kutusundaki Toplam:", "Total in trash:")}</span>
              <span className="font-bold text-rose-600 font-mono text-sm">{state.ready ? formatMoney(totalTrashAmount) : '—'}</span>
            </div>

            <button
              onClick={fetchTrash}
              className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition"
              title="Yenile"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {state.error && <p role="alert">{state.error} <button onClick={fetchTrash}>{copy("Yeniden dene", "Retry")}</button></p>}
        {actionNotice && (
          <div className="mt-4 p-3 bg-emerald-50 border border-emerald-300 rounded-lg text-emerald-900 text-xs font-semibold flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <span>{actionNotice}</span>
          </div>
        )}
      </div>

      {/* SİLİNEN KAYITLAR TABLOSU */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <span className="text-xs font-bold text-slate-800">
            {copy("Kurtarılabilir Silinmiş Kayıtlar (", "Restorable records (")}{trashList.length} {copy("adet)", ")")}
          </span>
          <span className="text-[11px] text-slate-500">
            {copy("Kayıtlar kalıcı olarak silinmediği sürece güvenle burada saklanır", "Records remain here until restored or permanently deleted.")}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-100 text-slate-700 font-semibold uppercase border-b border-slate-200">
                <th className="py-2.5 px-4 w-32">{copy("Silinme Tarihi", "Deleted on")}</th>
                <th className="py-2.5 px-4 w-28">{copy("Harcama Tarihi", "Transaction date")}</th>
                <th className="py-2.5 px-4">{copy("Başlık / Açıklama", "Title / Description")}</th>
                <th className="py-2.5 px-4 w-36">{copy("Kategori", "Category")}</th>
                <th className="py-2.5 px-4 w-32">{copy("Cari / Tedarikçi", "Counterparty / Supplier")}</th>
                <th className="py-2.5 px-4 w-32 text-right">{copy("Tutar", "Amount")}</th>
                <th className="py-2.5 px-4 text-center w-36">{copy("İşlemler", "Actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {trashList.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <Trash2 className="h-8 w-8 mx-auto mb-2 text-slate-300" />
                    <span>{state.ready ? copy("Çöp kutusu boş. Silinmiş bir kayıt bulunmuyor.", "The trash is empty.") : isLoading ? copy("Çöp kutusu yükleniyor…", "Loading deleted records…") : copy("Çöp kutusu henüz yüklenemedi.", "Could not load deleted records.")}</span>
                  </td>
                </tr>
              ) : (
                trashList.map((t) => {
                  const cat = categoryMap.get(t.categoryId);

                  return (
                    <tr key={t.id} className="hover:bg-slate-50 transition">
                      <td className="py-2.5 px-4 font-mono text-[11px] text-rose-700">
                        {t.deletedAt ? t.deletedAt.split('T')[0] : 'Bilinmiyor'}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-slate-600">
                        {t.date.split('T')[0]}
                      </td>
                      <td className="py-2.5 px-4 font-bold text-slate-900">
                        <div>{t.title}</div>
                        {language === 'tr' && t.amountInWords && (
                          <div className="text-[10px] text-slate-500 italic font-normal mt-0.5">
                            {t.amountInWords}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-slate-600">
                        {cat?.name || '-'}
                      </td>
                      <td className="py-2.5 px-4 text-slate-600">
                        {t.party || '-'}
                      </td>
                      <td className="py-2.5 px-4 text-right font-bold font-mono text-slate-900 text-sm">
                        {formatMoney(t.amount)}
                      </td>
                      <td className="py-2.5 px-4 text-center">
                        {canMutate && <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => handleRestore(t.id, t.title)}
                            disabled={state.pending.includes(t.id)}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-300 font-bold text-[11px] transition"
                            title={copy("Geri Yükle", "Restore")}
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>{copy("Kurtar", "Restore")}</span>
                          </button>

                          <button
                            onClick={() => handlePermanentDelete(t.id, t.title)}
                            disabled={state.pending.includes(t.id)}
                            className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                            title={copy("Kalıcı Olarak Sil", "Delete permanently")}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
