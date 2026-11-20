import React from 'react';
import { useLocale } from '../context/LocaleContext.js';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Legend, PieChart, Pie, Cell } from 'recharts';
import type { Transaction, Category } from '@cost-core/types';
import { useTheme } from '../context/ThemeContext.js';
import { computeReportFinance } from '../report-finance.js';

interface FinancialChartsProps {
  transactions: Transaction[];
  categories: Category[];
  baseCurrency?: string;
  isLoading?: boolean;
}

const formatAxisTick = (value: number, locale = 'tr-TR') => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  return new Intl.NumberFormat(locale, magnitude >= 1e15 || (magnitude > 0 && magnitude < 0.01) ? { notation: 'scientific', maximumSignificantDigits: 3 } : { notation: 'compact', maximumSignificantDigits: 3 }).format(value);
};

export const FinancialCharts: React.FC<FinancialChartsProps> = ({ transactions, categories, baseCurrency, isLoading = false }) => {
  const { settings } = useTheme();
  const { t, intlLocale } = useLocale();
  const localize = t;
  const base = baseCurrency || settings.baseCurrency || 'TRY';
  if (isLoading) return <div role='status'>{t('Mali grafikler yükleniyor...', 'Loading financial charts...')}</div>;
  const overall = computeReportFinance(transactions, base);
  const currencies = [base, ...Object.keys(overall.byCurrency).filter(code => code !== base)];
  const money = (value: number, code: string) => `${value.toLocaleString(intlLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
  return <div className='min-w-0 max-w-full space-y-6'>
    <p>{t('Yüklenen kayıtlardan hesaplanır. Nakit akışı açılış ve güncel cüzdan bakiyelerini içermez.', 'Calculated from loaded records. Cash flow excludes opening and current wallet balances.')}</p>
    <p>{t('Baz para birimi özeti yabancı para birimlerini içermez; dönüşüm yapılmaz.', 'The base currency summary excludes foreign currencies; no conversion is performed.')}</p>
    {currencies.map(code => {
      const records = transactions.filter(t => t.currency === code);
      const totals = computeReportFinance(records, code);
      const months = Array.from(new Set(records.map(t => t.date.slice(0, 7)).filter(month => /^\d{4}-\d{2}$/.test(month)))).sort();
      const monthlyData = months.map(month => {
        const result = computeReportFinance(records.filter(t => t.date.slice(0, 7) === month), code);
        return { month, income: result.totalIncome, expense: result.totalExpense, net: result.netBalance, cash: result.cashFlowNet, count: result.transactionCount };
      });
      const ids = Array.from(new Set(records.filter(t => t.type === 'expense').map(t => t.categoryId)));
      const categoryData = ids.flatMap(id => {
        const category = categories.find(c => c.id === id);
        const result = computeReportFinance(records.filter(t => t.type === 'expense' && t.categoryId === id), code);
        if (result.transactionCount === 0) return [];
        const value = result.totalExpense;
        return { id, name: category?.name || 'Diğer', value, share: totals.totalExpense === 0 ? 0 : value / totals.totalExpense * 100, color: category?.color || '#64748b' };
      });
      const format = (value: number) => money(Number(value), code);
      return <section key={code} aria-label={`Mali grafikler ${code}`} className='min-w-0 max-w-full space-y-4 border rounded-xl p-4'>
        <h2 className='font-bold text-lg'>{code}{code === base ? ` (${t('baz para birimi', 'base currency')})` : ''}</h2>
        <dl className='flex flex-wrap gap-4'>
          <div><dt>{t('Tanınan gelir', 'Recognized income')}</dt><dd>{format(totals.totalIncome)}</dd></div>
          <div><dt>{t('Tanınan gider', 'Recognized expense')}</dt><dd>{format(totals.totalExpense)}</dd></div>
          <div><dt>{t('Faaliyet neti', 'Operating net')}</dt><dd>{format(totals.netBalance)}</dd></div>
          <div><dt>{t('Net şirket nakit akışı', 'Net company cash flow')}</dt><dd>{format(totals.cashFlowNet)}</dd></div>
          <div><dt>{t('Tanınan işlem adedi', 'Recognized transactions')}</dt><dd>{totals.transactionCount}</dd></div>
        </dl>
        <h3 className='font-semibold'>{t('Aylık mali hareketler', 'Monthly financial activity')}</h3>
        {monthlyData.length === 0 ? <p>{t('Grafik için veri bulunmuyor.', 'No data available for the chart.')}</p> : <div className='h-64 w-full min-w-0'><ResponsiveContainer width='100%' height='100%'><BarChart data={monthlyData}><XAxis dataKey='month' /><YAxis width={90} tick={{ fontSize: 10 }} tickMargin={4} tickFormatter={value => formatAxisTick(value, intlLocale)} /><Tooltip formatter={value => typeof value === 'number' && Number.isFinite(value) ? format(value) : '—'} /><Legend /><Bar dataKey='income' name={t('Tanınan gelir', 'Recognized income')} fill='#16a34a' /><Bar dataKey='expense' name={t('Tanınan gider', 'Recognized expense')} fill='#dc2626' /></BarChart></ResponsiveContainer></div>}
        <div role='region' aria-label={`${code} aylık mali hareketler tablosu`} tabIndex={0} className='overflow-x-auto max-w-full min-w-0'><table className='min-w-[760px] w-full text-left'><caption>{code}{localize(" aylık mali hareketler", " monthly financial activity")}</caption><thead><tr>{[t('Ay', 'Month'), t('Tanınan gelir', 'Recognized income'), t('Tanınan gider', 'Recognized expenses'), t('Faaliyet neti', 'Operating net'), t('Net şirket nakit akışı', 'Net company cash flow'), t('Tanınan işlem adedi', 'Recognized transactions')].map(label => <th scope='col' key={label} className='p-2'>{label}</th>)}</tr></thead><tbody>{monthlyData.map(item => <tr key={item.month} className='border-t'><td className='p-2'>{item.month}</td><td className='p-2'>{format(item.income)}</td><td className='p-2'>{format(item.expense)}</td><td className='p-2'>{format(item.net)}</td><td className='p-2'>{format(item.cash)}</td><td className='p-2'>{item.count}</td></tr>)}</tbody></table></div>
        <h3 className='font-semibold'>{t('Gider dağılımı payı', 'Expense distribution share')}</h3>
        {categoryData.length === 0 ? <p>{t('Gider dağılımı için veri bulunmuyor.', 'No data available for expense distribution.')}</p> : <><div className='h-64 w-full min-w-0'><ResponsiveContainer width='100%' height='100%'><PieChart><Pie data={categoryData} dataKey='value' nameKey='name' cx='50%' cy='50%' outerRadius={80}>{categoryData.map((item, index) => <Cell key={index} fill={item.color} />)}</Pie><Tooltip formatter={value => typeof value === 'number' && Number.isFinite(value) ? format(value) : '—'} /></PieChart></ResponsiveContainer></div><ul aria-label={`${code} ${t('gider dağılımı açıklaması', 'expense distribution description')}`} className='space-y-1'>{categoryData.map((item, index) => <li key={index} className='flex min-w-0 items-start gap-2'><span aria-hidden='true' style={{ backgroundColor: item.color }} className='mt-1 inline-block h-3 w-3 shrink-0' /><span className='min-w-0 break-all'>{item.name}</span></li>)}</ul></>}
        <div role='region' aria-label={`${code} gider dağılımı tablosu`} tabIndex={0} className='overflow-x-auto max-w-full min-w-0'><table className='min-w-[480px] w-full text-left'><caption>{localize("Gider dağılımı payı", "Share of expenses")}</caption><thead><tr><th scope='col' className='p-2'>{localize("Kategori", "Category")}</th><th scope='col' className='p-2'>{localize("Tanınan gider", "Recognized expenses")}</th><th scope='col' className='p-2'>{t('Pay', 'Share')}</th></tr></thead><tbody>{categoryData.map((item, index) => <tr key={index} className='border-t'><td className='p-2 break-words'>{item.name}</td><td className='p-2'>{format(item.value)}</td><td className='p-2'>{item.share.toFixed(1)}%</td></tr>)}</tbody></table></div>
      </section>;
    })}
  </div>;
};
