import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction, Category } from '@cost-core/types';
import { FinancialCharts } from '../src/components/FinancialCharts.js';
const theme = vi.hoisted(() => ({ baseCurrency: 'TRY' as string | undefined }));
beforeEach(() => { theme.baseCurrency = 'TRY'; });
const captured = vi.hoisted(() => ({ bars: [] as any[], pies: [] as any[], series: [] as any[], tooltips: [] as any[] }));
vi.mock('../src/context/ThemeContext.js', () => ({ useTheme: () => ({ settings: { baseCurrency: theme.baseCurrency } }) }));
vi.mock('recharts', () => {
  const wrap = (kind: string) => (props: any) => { if (kind === 'bar') captured.bars.push(props.data); if (kind === 'pie') captured.pies.push(props.data); if (kind === 'series') captured.series.push(props); if (kind === 'tooltip') captured.tooltips.push(props); return props.children ?? null; };
  return { ResponsiveContainer: wrap('container'), BarChart: wrap('bar'), PieChart: wrap('chart'), Pie: wrap('pie'), Bar: wrap('series'), Tooltip: wrap('tooltip'), XAxis: wrap('axis'), YAxis: wrap('axis'), Legend: wrap('legend'), Cell: wrap('cell') };
});
const tx = (extra: Record<string, unknown> = {}): Transaction => ({ date: '2026-01-02', type: 'income', title: 'x', amount: 100, currency: 'TRY', categoryId: 'a', isPaid: true, status: 'approved', paymentSource: 'company_account', baseAmount: 999999, ...extra } as unknown as Transaction);
const categories = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] as Category[];
const render = (transactions: Transaction[], baseCurrency?: string, isLoading = false) => { captured.bars.length = 0; captured.pies.length = 0; captured.series.length = 0; captured.tooltips.length = 0; return renderToStaticMarkup(<FinancialCharts transactions={transactions} categories={categories} baseCurrency={baseCurrency} isLoading={isLoading} />).replace(/<!-- -->/g, ''); };
const panel = (html: string, currency: string) => { const at = html.indexOf('aria-label=' + JSON.stringify('Mali grafikler ' + currency)); expect(at).toBeGreaterThan(-1); return html.slice(at, html.indexOf('</section>', at)); };
const row = (html: string, text: string) => { const at = html.indexOf('>' + text + '</td>'); expect(at).toBeGreaterThan(-1); return html.slice(html.lastIndexOf('<tr', at), html.indexOf('</tr>', at) + 5); };
describe('financial charts', () => {
  it('shares recognized native-currency data between charts and exact tables', () => {
    const records = [tx(), tx({ amount: 40, status: 'pending', isPaid: false }), tx({ type: 'expense', amount: 30 }), tx({ type: 'expense', amount: 20, isPaid: false }), tx({ type: 'expense', amount: 10, categoryId: 'b', paymentSource: 'person_out_of_pocket' }), tx({ amount: 10, otoKasaTransactionId: 'link' }), tx({ amount: 11, paymentSource: 'person_out_of_pocket' }), tx({ status: 'draft' }), tx({ deletedAt: '2026-01-03' }), tx({ type: 'transfer' }), tx({ date: '2026-02-01', amount: 60 }), tx({ date: '2026-02-02', type: 'expense', amount: 40 }), tx({ currency: 'USD', amount: 50 }), tx({ currency: 'USD', type: 'expense', amount: 5 })];
    const html = render(records); const tr = panel(html, 'TRY'); const us = panel(html, 'USD'); const summary = (p: string) => Array.from(p.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g), m => [m[1], m[2]]); expect(summary(tr)).toEqual([['Tanınan gelir', '200,00 TRY'], ['Tanınan gider', '100,00 TRY'], ['Faaliyet neti', '100,00 TRY'], ['Net şirket nakit akışı', '90,00 TRY'], ['Tanınan işlem adedi', '7']]); expect(summary(us)).toEqual([['Tanınan gelir', '50,00 USD'], ['Tanınan gider', '5,00 USD'], ['Faaliyet neti', '45,00 USD'], ['Net şirket nakit akışı', '45,00 USD'], ['Tanınan işlem adedi', '2']]); expect(Array.from(row(tr, '2026-02').matchAll(/<td[^>]*>([^<]*)<\/td>/g), m => m[1])).toEqual(['2026-02', '60,00 TRY', '40,00 TRY', '20,00 TRY', '20,00 TRY', '2']);
    expect(row(tr, '2026-01')).toContain('140,00 TRY'); expect(row(tr, '2026-01')).toContain('60,00 TRY'); expect(row(tr, '2026-01')).toContain('80,00 TRY'); expect(row(tr, '2026-01')).toContain('70,00 TRY'); expect(row(tr, '2026-01')).toContain('>5</td>');
    expect(row(tr, '2026-02')).toContain('60,00 TRY'); expect(row(tr, '2026-02')).toContain('40,00 TRY'); expect(row(tr, '2026-02')).toContain('20,00 TRY'); expect(row(tr, '2026-02')).toContain('>2</td>');
    expect(row(us, '2026-01')).toContain('50,00 USD'); expect(row(us, '2026-01')).toContain('5,00 USD'); expect(row(us, '2026-01')).toContain('45,00 USD');
    expect(row(tr, 'A')).toContain('90,00 TRY'); expect(row(tr, 'A')).toContain('90.0%'); expect(row(tr, 'B')).toContain('10,00 TRY'); expect(row(tr, 'B')).toContain('10.0%'); expect(row(us, 'A')).toContain('100.0%');
    expect(captured.bars[0][0]).toMatchObject({ month: '2026-01', income: 140, expense: 60, net: 80, cash: 70, count: 5 }); expect(captured.bars[1][0]).toMatchObject({ month: '2026-01', income: 50, expense: 5, net: 45, cash: 45, count: 2 });
    expect(captured.pies[0]).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'A', value: 90 }), expect.objectContaining({ name: 'B', value: 10 })])); expect(captured.pies[1]).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'A', value: 5 })]));
    expect(captured.series.map(x => [x.name, x.dataKey])).toEqual(expect.arrayContaining([['Tanınan gelir', 'income'], ['Tanınan gider', 'expense']]));
  });
});


describe('financial chart edge cases', () => {
  it('keeps the base panel distinct and retains empty native totals', () => {
    const html = render([tx({ currency: 'USD', amount: 2 })], 'TRY');
    expect(panel(html, 'TRY')).toContain('0,00 TRY');
    expect(panel(html, 'USD')).toContain('2,00 USD');
    const usdBase = render([tx({ currency: 'USD' }), tx()], 'USD');
    expect(usdBase.split('aria-label='+JSON.stringify('Mali grafikler USD')).length).toBe(2);
    expect(panel(usdBase, 'TRY')).toContain('100,00 TRY'); expect(panel(usdBase, 'USD')).toContain('USD (baz para birimi)</h2>'); expect(panel(usdBase, 'TRY')).not.toContain('(baz para birimi)</h2>'); theme.baseCurrency = 'USD'; const themeBase = render([tx()]); expect(panel(themeBase, 'USD')).toContain('USD (baz para birimi)</h2>'); expect(panel(themeBase, 'USD')).toContain('0,00 USD'); expect(panel(themeBase, 'TRY')).not.toContain('(baz para birimi)</h2>'); theme.baseCurrency = undefined; const fallback = render([tx({ currency: 'USD' })]); expect(panel(fallback, 'TRY')).toContain('TRY (baz para birimi)</h2>'); expect(panel(fallback, 'TRY')).toContain('0,00 TRY'); expect(panel(fallback, 'USD')).not.toContain('(baz para birimi)</h2>');
  });
  it('preserves years, zero-activity months, unknown categories and cents', () => {
    const html = render([tx({ date: '2025-01-02', amount: 1.23 }), tx({ date: '2026-01-02', type: 'expense', amount: 0.25, categoryId: 'missing' }), tx({ date: '2026-03-02', status: 'draft' }), tx({ date: '2026-04-02', type: 'transfer' })]);
    const tr = panel(html, 'TRY');
    expect(row(tr, '2025-01')).toContain('1,23 TRY');
    expect(row(tr, '2026-01')).toContain('0,25 TRY');
    expect(row(tr, '2026-03')).toContain('>0</td>');
    expect(row(tr, '2026-04')).toContain('>0</td>');
    expect(row(tr, 'Diğer')).toContain('0,25 TRY');
    expect(captured.bars[0].map((x: any) => x.month)).toEqual(['2025-01', '2026-01', '2026-03', '2026-04']);
    expect(captured.pies[0]).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Diğer', value: 0.25 })]));
  });
  it('distinguishes loading from an empty result', () => {
    const loading = render([tx()], undefined, true);
    expect(loading).toContain('role='+JSON.stringify('status'));
    expect(captured.bars).toHaveLength(0);
    expect(loading).not.toContain('Mali grafikler TRY');
    const empty = render([]);
    expect(panel(empty, 'TRY')).toContain('0,00 TRY');
    expect(panel(empty, 'TRY')).toContain('veri');
  });
  it('excludes unpaid personal expense from cash while recognizing its expense', () => {
    const html = render([tx(), tx({ type: 'expense', amount: 7, isPaid: false, paymentSource: 'person_out_of_pocket' })]);
    const jan = row(panel(html, 'TRY'), '2026-01');
    expect(jan).toContain('7,00 TRY'); expect(jan).toContain('93,00 TRY'); expect(jan).toContain('100,00 TRY');
    expect(captured.bars[0][0]).toMatchObject({ income: 100, expense: 7, net: 93, cash: 100, count: 2 });
  });
});


describe('zero shares and native tooltips', () => {
  it('shows a finite zero share and formats chart tooltips in native currency', () => {
    const html = render([tx({ type: 'expense', amount: 0 }), tx({ currency: 'USD', amount: 1.25 })]);
    expect(row(panel(html, 'TRY'), 'A')).toContain('>0.0%</td>');
    expect(row(panel(html, 'TRY'), 'A')).not.toContain('NaN');
    expect(captured.pies[0]).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'A', value: 0, share: 0 })]));
    expect(captured.tooltips[0].formatter(1.25)).toBe('1,25 TRY');
    expect(captured.tooltips[captured.tooltips.length - 1].formatter(1.25)).toBe('1,25 USD');
    expect(captured.tooltips[0].formatter(undefined)).toBe('—');
    expect(captured.tooltips[0].formatter(NaN)).toBe('—');
    expect(captured.tooltips[0].formatter(Infinity)).toBe('—');
    expect(captured.tooltips[0].formatter('not a number')).toBe('—');
  });
});


describe('period category shares', () => {
  const categoryRows = (html: string) => { const region = html.slice(html.indexOf('aria-label=' + JSON.stringify('TRY gider dağılımı tablosu'))); const body = region.slice(region.indexOf('<tbody>') + 7, region.indexOf('</tbody>')); return Array.from(body.matchAll(/<tr[^>]*>(.*?)<\/tr>/g), m => Array.from(m[1].matchAll(/<td[^>]*>([^<]*)<\/td>/g), cell => cell[1])); };
  it('omits exclusively unrecognized expense categories but retains raw zero months', () => { const html = render([tx({ type: 'expense', amount: 7, status: 'draft', categoryId: 'b', date: '2026-03-02' }), tx({ type: 'expense', amount: 11, deletedAt: '2026-04-03', categoryId: 'missing', date: '2026-04-02' })]); const tr = panel(html, 'TRY'); expect(captured.pies).toEqual([]); expect(categoryRows(tr)).toEqual([]); expect(tr).toContain('Gider dağılımı için veri bulunmuyor.'); expect(captured.bars[0]).toEqual([{ month: '2026-03', income: 0, expense: 0, net: 0, cash: 0, count: 0 }, { month: '2026-04', income: 0, expense: 0, net: 0, cash: 0, count: 0 }]); });
  it('does not let income recognize an expense category', () => { const html = render([tx(), tx({ type: 'expense', amount: 7, status: 'draft' }), tx({ type: 'expense', amount: 11, deletedAt: '2026-01-03' })]); const tr = panel(html, 'TRY'); expect(captured.pies).toEqual([]); expect(categoryRows(tr)).toEqual([]); expect(tr).toContain('Gider dağılımı için veri bulunmuyor.'); });
  it('includes only recognized expenses in the pie and category table', () => { const html = render([tx(), tx({ type: 'expense', amount: 5 }), tx({ type: 'expense', amount: 7, status: 'draft', categoryId: 'b' }), tx({ type: 'expense', amount: 11, deletedAt: '2026-01-03', categoryId: 'missing' })]); expect(captured.pies).toEqual([[{ id: 'a', name: 'A', value: 5, share: 100, color: '#64748b' }]]); expect(categoryRows(panel(html, 'TRY'))).toEqual([['A', '5,00 TRY', '100.0%']]); });
  it('retains a recognized unknown category', () => { const html = render([tx({ type: 'expense', amount: 2, categoryId: 'missing' })]); expect(captured.pies).toEqual([[{ id: 'missing', name: 'Diğer', value: 2, share: 100, color: '#64748b' }]]); expect(categoryRows(panel(html, 'TRY'))).toEqual([['Diğer', '2,00 TRY', '100.0%']]); });
  it('uses recognized January expenses for both the pie and the table', () => {
    const html = render([tx(), tx({ amount: 40, status: 'pending', isPaid: false }), tx({ type: 'expense', amount: 30 }), tx({ type: 'expense', amount: 20, isPaid: false }), tx({ type: 'expense', amount: 10, categoryId: 'b', paymentSource: 'person_out_of_pocket' })]);
    const tr = panel(html, 'TRY');
    expect(row(tr, 'A')).toContain('50,00 TRY'); expect(row(tr, 'A')).toContain('83.3%');
    expect(row(tr, 'B')).toContain('10,00 TRY'); expect(row(tr, 'B')).toContain('16.7%');
    expect(captured.pies[0]).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'A', value: 50 }), expect.objectContaining({ name: 'B', value: 10 })]));
  });
  it('retains negative activity and cash values', () => {
    const html = render([tx({ amount: 2 }), tx({ type: 'expense', amount: 5 })]);
    expect(row(panel(html, 'TRY'), '2026-01')).toContain('-3,00 TRY');
    expect(captured.bars[0][0]).toMatchObject({ income: 2, expense: 5, net: -3, cash: -3, count: 2 });
  });
});
