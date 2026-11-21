import { formatCurrency } from '../format-currency.js';
import React from 'react';
import { useLocale } from '../context/LocaleContext.js';
import type { Transaction } from '@cost-core/types';

type Props = { transactions: Transaction[]; isLoading: boolean; canMutate?: boolean; onMarkPaid: (id: string) => void | Promise<void> };

export const CompanyDebtTable: React.FC<Props> = ({ transactions, isLoading, canMutate = false, onMarkPaid }) => {
  const { t: translate, intlLocale } = useLocale();
  const formatDate = (value: string) => {
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    return Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day) ? new Intl.DateTimeFormat(intlLocale).format(new Date(year, month - 1, day)) : value;
  };
  const rows = transactions.filter((t) => !t.deletedAt && ['approved', 'pending', 'paid'].includes(t.status) && t.type === 'expense' && !t.isPaid && t.paymentSource !== 'person_out_of_pocket');
  return (
              <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
                <h3 className="text-sm font-bold text-slate-800 mb-2">
                  ⏳ {translate('Gösterilen Kayıtlardaki Şirket Borçları', 'Company Debts in Displayed Records')}
                </h3>
                <p className="text-xs text-slate-500 mb-4">
                  {translate('Yüklenen kayıtlardaki ödenmemiş şirket giderleri', 'Unpaid company expenses in loaded records')}
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-100 text-slate-700 font-semibold uppercase">
                        <th className="py-2.5 px-3">{translate('Harcama Tarihi', 'Expense Date')}</th>
                        <th className="py-2.5 px-3">{translate('Vade Tarihi', 'Due Date')}</th>
                        <th className="py-2.5 px-3">{translate('Kalem / Açıklama', 'Item / Description')}</th>
                        <th className="py-2.5 px-3">{translate('Tedarikçi', 'Supplier')}</th>
                        <th className="py-2.5 px-3 text-right">{translate('Tutar', 'Amount')}</th>
                        <th className="py-2.5 px-3 text-center">{translate('Durum', 'Status')}</th>
                        <th className="py-2.5 px-3 text-center">{translate('İşlem', 'Action')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {isLoading ? (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-slate-500">
                            {translate('Borç ve vade kayıtları yükleniyor…', 'Loading debts and due dates…')}
                          </td>
                        </tr>
                      ) : rows.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="py-8 text-center text-slate-500">
                            {translate('Gösterilen kayıtlarda bekleyen şirket borcu yok', 'There are no pending company debts in the displayed records')}
                          </td>
                        </tr>
                      ) : (
                        rows.map((t) => {
                          const isOverdue = t.dueDate && t.dueDate.slice(0, 10) <= new Date().toISOString().slice(0, 10);

                          return (
                            <tr key={t.id} className="hover:bg-slate-50">
                              <td className="py-2.5 px-3 font-mono text-slate-600">{formatDate(t.date)}</td>
                              <td className="py-2.5 px-3 font-mono font-bold text-slate-900">
                                {t.dueDate ? formatDate(t.dueDate) : translate('Vade Belirtilmemiş', 'No Due Date')}
                              </td>
                              <td className="py-2.5 px-3 font-medium text-slate-900">{t.title}</td>
                              <td className="py-2.5 px-3 text-slate-600">{t.party || '-'}</td>
                              <td className="py-2.5 px-3 text-right font-bold font-mono text-rose-600 text-sm">
                                {formatCurrency(intlLocale, t.currency || 'TRY', t.amount)}
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                    isOverdue
                                      ? 'bg-rose-100 text-rose-800 border-rose-300 animate-pulse'
                                      : 'bg-amber-100 text-amber-800 border-amber-300'
                                  }`}
                                >
                                  {isOverdue ? translate('🚨 GECİKMİŞ BORÇ', '🚨 OVERDUE DEBT') : translate('⏳ Vadeli Bekliyor', '⏳ Awaiting Due Date')}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                {canMutate && <button
                                  onClick={() => onMarkPaid(t.id)}
                                  className="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[11px] shadow-sm transition"
                                >
                                  {translate('Ödendi Yap', 'Mark Paid')}
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
