import React from 'react';
import { useLocale } from '../context/LocaleContext.js';
import { ArrowDownRight, ArrowUpRight, Wallet, Receipt } from 'lucide-react';
import { useTheme } from '../context/ThemeContext.js';

interface DashboardStatsProps {
  summary: {
    totalExpense: number;
    totalIncome: number;
    netBalance: number;
    transactionCount: number;
    categoryBreakdown: Array<{ name: string; amount: number }>;
  } | null;
}

export const DashboardStats: React.FC<DashboardStatsProps> = ({ summary }) => {
  const { settings } = useTheme();
  const { t, intlLocale } = useLocale();
  const currency = settings.baseCurrency || 'TRY';

  const formatMoney = (val: number) => {
    return new Intl.NumberFormat(intlLocale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(val || 0);
  };

  const expense = summary?.totalExpense || 0;
  const income = summary?.totalIncome || 0;
  const balance = summary?.netBalance || 0;
  const count = summary?.transactionCount || 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
      {/* Toplam Gider */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-sm flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-slate-400 mb-1">{t('Toplam Maliyet & Gider', 'Total Costs & Expenses')}</p>
          <h3 className="text-xl font-bold text-rose-400">{formatMoney(expense)}</h3>
        </div>
        <div className="h-10 w-10 rounded-lg bg-rose-950/60 border border-rose-800/60 flex items-center justify-center text-rose-400">
          <ArrowDownRight className="h-5 w-5" />
        </div>
      </div>

      {/* Toplam Gelir / Hakediş */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-sm flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-slate-400 mb-1">{t('Toplam Gelir / Giriş', 'Total Income / Inflows')}</p>
          <h3 className="text-xl font-bold text-emerald-400">{formatMoney(income)}</h3>
        </div>
        <div className="h-10 w-10 rounded-lg bg-emerald-950/60 border border-emerald-800/60 flex items-center justify-center text-emerald-400">
          <ArrowUpRight className="h-5 w-5" />
        </div>
      </div>

      {/* Net Kasa / Bakiye */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-sm flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-slate-400 mb-1">{t('Net Kasa & Bakiye', 'Net Cash & Balance')}</p>
          <h3 className={`text-xl font-bold ${balance >= 0 ? 'text-blue-400' : 'text-amber-400'}`}>
            {formatMoney(balance)}
          </h3>
        </div>
        <div className="h-10 w-10 rounded-lg bg-blue-950/60 border border-blue-800/60 flex items-center justify-center text-blue-400">
          <Wallet className="h-5 w-5" />
        </div>
      </div>

      {/* Kayıt Sayısı */}
      <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 shadow-sm flex items-center justify-between">
        <div>
          <p className="text-xs font-medium text-slate-400 mb-1">{t('Kayıtlı Hareket Sayısı', 'Recorded Transactions')}</p>
          <h3 className="text-xl font-bold text-slate-200">{count} Kalem</h3>
        </div>
        <div className="h-10 w-10 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300">
          <Receipt className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
};
