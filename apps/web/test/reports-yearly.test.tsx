import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@cost-core/types';
import { ReportsCenterView } from '../src/components/ReportsCenterView.js';
vi.mock('../src/context/ThemeContext.js', () => ({ useTheme: () => ({ settings: { baseCurrency: 'TRY' } }) }));
const tx = (id: string, patch: Partial<Transaction> = {}): Transaction => ({ id, title: id, date: '2026-01-01', type: 'income', amount: 100, baseAmount: 999999, currency: 'TRY', categoryId: 'cat', status: 'approved', isPaid: true, paymentSource: 'company_account', ...patch } as Transaction);
const render = (transactions: Transaction[], baseCurrency?: string, isLoading = false) => renderToStaticMarkup(<ReportsCenterView transactions={transactions} categories={[]} subView={'monthly_yearly'} baseCurrency={baseCurrency} isLoading={isLoading} />).replace(/<!--.*?-->/g, '');
const money = (n: number, currency: string) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
const panel = (html: string, code: string, year = '2026') => { const m = html.match(new RegExp('<div[^>]*aria-label="Aylık mali özet ' + code + ' ' + year + '"[^>]*>([\\s\\S]*?)</div>')); expect(m).not.toBeNull(); return m![1]; };
const cells = (row: string) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => m[1].replace(/<[^>]*>/g, '').trim());
const month = (html: string, name: string) => { const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => cells(m[1])); const row = rows.find(r => r[0] === name); expect(row).toBeDefined(); return row!; };
const footer = (html: string) => { const m = html.match(/<tfoot[^>]*>([\s\S]*?)<\/tfoot>/); expect(m).not.toBeNull(); return cells(m![1]); };
const check = (row: string[], code: string, values: number[], share: string) => { expect(row.slice(1, 6)).toEqual(values.slice(0, 5).map(n => money(n, code))); expect(row[6]).toBe(String(values[5])); expect(row[7]).toBe('%' + share); };
const rows = () => [tx('income'), tx('pending income', { amount: 40, status: 'pending', isPaid: false }), tx('expense', { type: 'expense', amount: 30 }), tx('unpaid', { type: 'expense', amount: 20, isPaid: false }), tx('person', { type: 'expense', amount: 10, paymentSource: 'person_out_of_pocket' }), tx('oto', { amount: 10, paymentSource: 'person_out_of_pocket' }), tx('draft', { amount: 999, status: 'draft' }), tx('deleted', { amount: 9999, deletedAt: '2026-01-02' }), tx('transfer', { type: 'transfer', amount: 777 }), tx('feb income', { date: '2026-02-01', amount: 60 }), tx('feb expense', { date: '2026-02-01', type: 'expense', amount: 40 }), tx('usd income', { currency: 'USD', amount: 50 }), tx('usd expense', { currency: 'USD', type: 'expense', amount: 5 }), tx('usd feb income', { date: '2026-02-01', currency: 'USD', amount: 20 }), tx('usd feb debt', { date: '2026-02-01', currency: 'USD', type: 'expense', amount: 15, isPaid: false }), tx('outside', { date: '2025-01-01', currency: 'EUR', amount: 1234 })];
describe('yearly finance report', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 14, 12)); });
  afterEach(() => vi.useRealTimers());
  it('reconciles monthly native currencies with annual totals', () => {
    const html = render(rows()); const base = panel(html, 'TRY'); const usd = panel(html, 'USD');
    expect(html).not.toContain('Aylık mali özet EUR 2026'); expect(html).toContain('kısmidir');
    for (const p of [base, usd]) { expect(p).toContain('<caption>'); expect((p.match(/scope="row"/g) || []).length).toBe(12); }
    check(month(base, 'Ocak'), 'TRY', [140, 60, 20, 80, 70, 5], '60.0');
    check(month(base, 'Şubat'), 'TRY', [60, 40, 0, 20, 20, 2], '40.0');
    check(footer(base), 'TRY', [200, 100, 20, 100, 90, 7], '100.0');
    check(month(usd, 'Ocak'), 'USD', [50, 5, 0, 45, 45, 2], '25.0');
    check(month(usd, 'Şubat'), 'USD', [20, 15, 15, 5, 20, 2], '75.0');
    check(month(usd, 'Mart'), 'USD', [0, 0, 0, 0, 0, 0], '0.0');
    check(footer(usd), 'USD', [70, 20, 15, 50, 65, 4], '100.0');
  });
  it('keeps an empty base panel and honors a currency override', () => {
    const only = render([tx('usd', { currency: 'USD', amount: 50 })]);
    check(footer(panel(only, 'TRY')), 'TRY', [0, 0, 0, 0, 0, 0], '0.0'); expect(only).toContain('kısmidir');
    const override = render(rows(), 'USD'); expect(override.indexOf('Aylık mali özet USD 2026')).toBeLessThan(override.indexOf('Aylık mali özet TRY 2026'));
    check(footer(panel(override, 'USD')), 'USD', [70, 20, 15, 50, 65, 4], '100.0');
  });
  it('shows zero shares for income only and twelve empty months', () => {
    const income = panel(render([tx('income')]), 'TRY'); check(footer(income), 'TRY', [100, 0, 0, 100, 100, 1], '0.0');
    const incomeRows = [...income.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].filter(m => m[1].includes('scope=' + String.fromCharCode(34) + 'row' + String.fromCharCode(34))).map(m => cells(m[1])); expect(incomeRows).toHaveLength(12); for (const row of incomeRows) expect(row[7]).toBe('%0.0');
    const empty = panel(render([]), 'TRY'); expect((empty.match(/scope="row"/g) || []).length).toBe(12); check(month(empty, 'Ocak'), 'TRY', [0, 0, 0, 0, 0, 0], '0.0'); check(footer(empty), 'TRY', [0, 0, 0, 0, 0, 0], '0.0');
  });
  it('keeps every empty month share at zero', () => {
    const p = panel(render([]), 'TRY'); const monthly = [...p.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].filter(m => m[1].includes('scope=' + String.fromCharCode(34) + 'row' + String.fromCharCode(34))).map(m => cells(m[1]));
    expect(monthly).toHaveLength(12); for (const row of monthly) expect(row[7]).toBe('%0.0'); check(footer(p), 'TRY', [0, 0, 0, 0, 0, 0], '0.0');
  });
  it.each([['0001', '0001-01-01', 'Ocak', 11], ['0999', '0999-02-01', 'Şubat', 19]] as const)('reports canonical low year %s', (year, date, name, amount) => {
    vi.setSystemTime(new Date(year + '-11-14T12:00:00Z'));
    const html = render([tx('inside', { date, amount }), tx('outside', { date: '2026-01-01', amount: 999 })]); const p = panel(html, 'TRY', year);
    expect(html).toContain('value=' + String.fromCharCode(34) + year + String.fromCharCode(34));
    check(month(p, name), 'TRY', [amount, 0, 0, amount, amount, 1], '0.0'); check(footer(p), 'TRY', [amount, 0, 0, amount, amount, 1], '0.0');
    expect(p).toContain(year);
  });
  it('does not fall back to base currency for a foreign empty month', () => {
    const html = render([tx('try march', { date: '2026-03-01', amount: 23 }), tx('usd january', { currency: 'USD', amount: 50 })]); const base = panel(html, 'TRY'); const usd = panel(html, 'USD');
    check(month(base, 'Mart'), 'TRY', [23, 0, 0, 23, 23, 1], '0.0'); check(month(usd, 'Mart'), 'USD', [0, 0, 0, 0, 0, 0], '0.0'); check(footer(usd), 'USD', [50, 0, 0, 50, 50, 1], '0.0');
  });
  it('formats fractional native amounts and hides the matrix while loading', () => {
    const html = render([tx('a', { amount: 0.1 }), tx('b', { amount: 0.2 }), tx('c', { type: 'expense', amount: 0.05 })]);
    check(footer(panel(html, 'TRY')), 'TRY', [0.3, 0.05, 0, 0.25, 0.25, 3], '100.0');
    const loading = render(rows(), undefined, true); expect(loading).toContain('role="status"'); expect(loading).not.toContain('Aylık mali özet');
  });
});
