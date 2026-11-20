import React from 'react';
import type { Transaction } from '@cost-core/types';

type Props = { transactions: Transaction[]; isLoading: boolean; canMutate?: boolean; onMarkPaid: (id: string) => void | Promise<void> };

export const CompanyDebtTable: React.FC<Props> = ({ transactions, isLoading, canMutate = false, onMarkPaid }) => {
  const rows = transactions.filter((t) => !t.deletedAt && ['approved', 'pending', 'paid'].includes(t.status) && t.type === 'expense' && !t.isPaid && t.paymentSource !== 'person_out_of_pocket');
  return (
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-bold text-slate-800 mb-2">
                  ⏳ Gösterilen Kayıtlardaki Şirket Borçları
                </h3>
                <p className="text-xs text-slate-500 mb-4">
                  Yüklenen kayıtlardaki ödenmemiş şirket giderleri
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-100 text-slate-700 font-semibold uppercase">
                        <th className="py-2.5 px-3">Harcama Tarihi</th>
                        <th className="py-2.5 px-3">Vade Tarihi</th>
                        <th className="py-2.5 px-3">Kalem / Açıklama</th>
                        <th className="py-2.5 px-3">Tedarikçi</th>
                        <th className="py-2.5 px-3 text-right">Tutar</th>
                        <th className="py-2.5 px-3 text-center">Durum</th>
                        <th className="py-2.5 px-3 text-center">İşlem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {isLoading ? (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-slate-500">
                            Borç ve vade kayıtları yükleniyor…
                          </td>
                        </tr>
                      ) : rows.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-slate-500">
                            Gösterilen kayıtlarda bekleyen şirket borcu yok
                          </td>
                        </tr>
                      ) : (
                        rows.map((t) => {
                          const isOverdue = t.dueDate && t.dueDate.slice(0, 10) <= new Date().toISOString().slice(0, 10);

                          return (
                            <tr key={t.id} className="hover:bg-slate-50">
                              <td className="py-2.5 px-3 font-mono text-slate-600">{t.date.split('T')[0]}</td>
                              <td className="py-2.5 px-3 font-mono font-bold text-slate-900">
                                {t.dueDate ? t.dueDate.split('T')[0] : 'Vade Belirtilmemiş'}
                              </td>
                              <td className="py-2.5 px-3 font-medium text-slate-900">{t.title}</td>
                              <td className="py-2.5 px-3 text-slate-600">{t.party || '-'}</td>
                              <td className="py-2.5 px-3 text-right font-bold font-mono text-rose-600 text-sm">
                                {new Intl.NumberFormat('tr-TR', { style: 'currency', currency: t.currency || 'TRY' }).format(t.amount)}
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                    isOverdue
                                      ? 'bg-rose-100 text-rose-800 border-rose-300 animate-pulse'
                                      : 'bg-amber-100 text-amber-800 border-amber-300'
                                  }`}
                                >
                                  {isOverdue ? '🚨 GECİKMİŞ BORÇ' : '⏳ Vadeli Bekliyor'}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                {canMutate && <button
                                  onClick={() => onMarkPaid(t.id)}
                                  className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[11px] shadow-sm transition"
                                >
                                  Ödendi Yap
                                </button>}
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
