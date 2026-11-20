import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@cost-core/types';
import { ReportsCenterView } from '../src/components/ReportsCenterView.js';

vi.mock('../src/context/ThemeContext.js', () => ({ useTheme: () => ({ settings: { baseCurrency: 'TRY' } }) }));
const tx = (id: string, patch: Partial<Transaction> = {}): Transaction => ({ id, title: id, date: '2026-11-14', type: 'income', amount: 100, baseAmount: 999999, currency: 'TRY', categoryId: 'cat', status: 'approved', isPaid: true, paymentSource: 'company_account', ...patch } as Transaction);
const render = (transactions: Transaction[], baseCurrency?: string, isLoading = false) => renderToStaticMarkup(<ReportsCenterView transactions={transactions} categories={[]} subView={'daily'} baseCurrency={baseCurrency} isLoading={isLoading} />).replace(/<!--.*?-->/g, '');
const section = (html: string, label: string) => { const m = html.match(new RegExp('<section aria-label="' + label + '"[^>]*>([\\s\\S]*?)</section>')); expect(m).not.toBeNull(); return m![1]; };
const panel = (html: string, code: string) => section(html, 'Günlük finansal özet ' + code);
const metric = (html: string, label: string, expected: string) => expect(html).toContain('<dt>' + label + '</dt><dd>' + expected + '</dd>');
const money = (n: number, currency: string) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
const rows = () => [tx('income'), tx('pending income', { amount: 40, status: 'pending', isPaid: false }), tx('paid expense', { type: 'expense', amount: 30 }), tx('unpaid expense', { type: 'expense', amount: 20, isPaid: false }), tx('person expense', { type: 'expense', amount: 10, paymentSource: 'person_out_of_pocket' }), tx('oto', { amount: 10, paymentSource: 'person_out_of_pocket' }), tx('draft row', { amount: 999, status: 'draft' }), tx('deleted row', { amount: 9999, deletedAt: '2026-11-14' }), tx('transfer row', { type: 'transfer', amount: 777 }), tx('usd income', { currency: 'USD', amount: 50 }), tx('usd expense', { currency: 'USD', type: 'expense', amount: 5 }), tx('outside', { date: '2026-11-13', amount: 1234 })];
describe('daily finance report', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 14, 12)); });
  afterEach(() => vi.useRealTimers());
  it('separates native finance and preserves all selected raw records', () => {
    const html = render(rows()); const base = panel(html, 'TRY'); const usd = panel(html, 'USD'); const raw = section(html, 'Günün ham kayıtları');
    for (const [label, value] of [['Tanınan gelir', 140], ['Tanınan gider', 60], ['Faaliyet neti', 80], ['Günün net şirket nakit akışı', 70], ['Bekleyen şirket borcu', 20], ['Şahıs tarafından ödenen gider', 10]] as const) metric(base, label, money(value, 'TRY'));
    metric(base, 'Tanınan işlem adedi', '5'); metric(usd, 'Tanınan gelir', money(50, 'USD')); metric(usd, 'Tanınan gider', money(5, 'USD')); metric(usd, 'Faaliyet neti', money(45, 'USD')); metric(usd, 'Günün net şirket nakit akışı', money(45, 'USD'));
    expect(html).toContain('kısmidir'); expect(base).not.toContain(money(999999, 'TRY')); expect(raw).toContain('11 ham kayıt');
    for (const t of rows().slice(0, -1)) expect(raw.split('>' + t.title + '<')).toHaveLength(2);
    expect(raw).not.toContain('outside'); for (const text of ['Taslak', 'Ödenmedi', 'Silinmiş — toplamlara dahil değil', 'Şahıs finansmanı — OTO yansıması', 'Virman']) expect(raw).toContain(text);
  });
  it('does not count unpaid personal expense as company debt or cash', () => {
    const base = panel(render([...rows(), tx('unpaid person', { type: 'expense', amount: 7, isPaid: false, paymentSource: 'person_out_of_pocket' })]), 'TRY');
    metric(base, 'Tanınan gider', money(67, 'TRY')); metric(base, 'Faaliyet neti', money(73, 'TRY')); metric(base, 'Tanınan işlem adedi', '6'); metric(base, 'Bekleyen şirket borcu', money(20, 'TRY')); metric(base, 'Şahıs tarafından ödenen gider', money(10, 'TRY')); metric(base, 'Günün net şirket nakit akışı', money(70, 'TRY'));
  });
  it('keeps a zero base and honors the base currency prop', () => {
    const only = render([tx('usd', { currency: 'USD', amount: 50 })]); metric(panel(only, 'TRY'), 'Tanınan gelir', money(0, 'TRY')); metric(panel(only, 'USD'), 'Tanınan gelir', money(50, 'USD')); expect(only).toContain('kısmidir');
    const override = render([tx('try'), tx('usd', { currency: 'USD', amount: 50 })], 'USD'); expect(override.indexOf('Günlük finansal özet USD')).toBeLessThan(override.indexOf('Günlük finansal özet TRY')); metric(panel(override, 'USD'), 'Tanınan gelir', money(50, 'USD')); metric(panel(override, 'TRY'), 'Tanınan gelir', money(100, 'TRY'));
  });
  it('distinguishes empty from loading', () => {
    const empty = render([]); metric(panel(empty, 'TRY'), 'Tanınan gelir', money(0, 'TRY')); expect(section(empty, 'Günün ham kayıtları')).toContain('kayıt bulunamadı');
    const loading = render(rows(), undefined, true); expect(loading).toContain('role="status"'); expect(loading).not.toContain('Günlük finansal özet'); expect(loading).not.toContain('Günün ham kayıtları'); expect(loading).not.toContain('kayıt bulunamadı');
  });
});
