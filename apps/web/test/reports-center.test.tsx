import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@cost-core/types';
import { ReportsCenterView } from '../src/components/ReportsCenterView.js';

vi.mock('../src/context/ThemeContext.js', () => ({ useTheme: () => ({ settings: { baseCurrency: 'TRY' } }) }));

const tx = (id: string, patch: Partial<Transaction> = {}): Transaction => ({ id, title: id, date: '2026-11-10', type: 'income', amount: 100, baseAmount: 99999, currency: 'TRY', categoryId: 'cat', status: 'approved', isPaid: true, paymentSource: 'company_account', ...patch } as Transaction);
const render = (transactions: Transaction[], baseCurrency?: string, isLoading = false) => renderToStaticMarkup(<ReportsCenterView transactions={transactions} categories={[]} subView={'date_range'} baseCurrency={baseCurrency} isLoading={isLoading} />).replace(/<!--.*?-->/g, '');
const panel = (html: string, code: string) => { const match = html.match(new RegExp('<section aria-label="Finansal özet ' + code + '"[^>]*>([\\s\\S]*?)</section>')); expect(match).not.toBeNull(); return match![1]; };
const metric = (html: string, label: string, expected: string) => expect(html).toContain('<dt>' + label + '</dt><dd>' + expected + '</dd>');
const money = (n: number, currency: string) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);

describe('date range report', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-14T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  it('renders recognized finance by native currency and preserves raw rows', () => {
    const rows = [tx('income'), tx('pending income', { amount: 40, status: 'pending', isPaid: false }), tx('paid expense', { type: 'expense', amount: 30 }), tx('unpaid expense', { type: 'expense', amount: 20, isPaid: false }), tx('person expense', { type: 'expense', amount: 10, paymentSource: 'person_out_of_pocket' }), tx('oto', { amount: 10, paymentSource: 'person_out_of_pocket' }), tx('draft row', { amount: 999, status: 'draft' }), tx('deleted row', { amount: 9999, deletedAt: '2026-11-12' }), tx('transfer row', { type: 'transfer', amount: 700 }), tx('usd income', { currency: 'USD', amount: 50 }), tx('usd expense', { currency: 'USD', type: 'expense', amount: 5 }), tx('outside', { date: '2026-10-01', amount: 1234 })];
    const html = render(rows); const base = panel(html, 'TRY'); const usd = panel(html, 'USD');
    metric(base, 'Tanınan gelir', money(140, 'TRY')); metric(base, 'Tanınan gider', money(60, 'TRY')); metric(base, 'Bekleyen şirket borcu', money(20, 'TRY')); metric(base, 'Faaliyet neti', money(80, 'TRY')); metric(base, 'Dönem net nakit akışı', money(70, 'TRY')); metric(base, 'Tanınan işlem adedi', '5');
    metric(usd, 'Tanınan gelir', money(50, 'USD')); metric(usd, 'Tanınan gider', money(5, 'USD')); metric(usd, 'Faaliyet neti', money(45, 'USD'));
    expect(html).toContain('kısmidir'); expect(html).toContain('Filtrelenen ham kayıtlar (11 kayıt)'); expect(html).toContain('draft row'); expect(html).toContain('deleted row'); expect(html).toMatch(/<tr[^>]*>(?:(?!<\/tr>)[^])*deleted row(?:(?!<\/tr>)[^])*Silinmiş — toplamlara dahil değil(?:(?!<\/tr>)[^])*<\/tr>/); expect(html).toContain('Taslak'); expect(html).toContain('Ödenmedi'); expect(html).toContain('Şahıs finansmanı — OTO yansıması'); expect(html).toContain('Virman'); expect(html).toContain(money(50, 'USD')); expect(html).not.toContain('outside');
  });
  it('keeps a zero base panel for USD-only data and honors a base currency prop', () => {
    const rows = [tx('usd', { currency: 'USD', amount: 50 })]; const html = render(rows);
    metric(panel(html, 'TRY'), 'Tanınan gelir', money(0, 'TRY')); metric(panel(html, 'USD'), 'Tanınan gelir', money(50, 'USD')); expect(html).toContain('kısmidir');
    const override = render(rows, 'USD'); metric(panel(override, 'USD'), 'Tanınan gelir', money(50, 'USD')); expect(override).not.toContain('kısmidir');
  });
  it('distinguishes empty results from loading', () => {
    const empty = render([]); metric(panel(empty, 'TRY'), 'Tanınan gelir', money(0, 'TRY')); expect(empty).toContain('kayıt bulunamadı');
    const loading = render([], undefined, true); expect(loading).toContain('role="status"'); expect(loading).toContain('Rapor yükleniyor'); expect(loading).not.toContain('Tanınan gelir'); expect(loading).not.toContain('kayıt bulunamadı');
  });
  it.each([
    ['Europe/Istanbul', '2026-11-14T12:00:00Z', '2026-11-01', '2026-11-14'],
    ['America/Los_Angeles', '2026-11-14T00:30:00Z', '2026-11-01', '2026-11-13'],
    ['UTC', '2026-11-01T00:30:00Z', '2026-11-01', '2026-11-01'],
  ])('renders local calendar dates in %s', (timezone, instant, start, end) => {
    vi.stubEnv('TZ', timezone);
    vi.setSystemTime(new Date(instant));
    const inputs = render([]).match(/<input[^>]*type=.[d]ate.[^>]*>/g) || [];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain('value=' + String.fromCharCode(34) + start + String.fromCharCode(34));
    expect(inputs[1]).toContain('value=' + String.fromCharCode(34) + end + String.fromCharCode(34));
  });
});
