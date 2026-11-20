import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { BalanceBar } from '../src/components/BalanceBar.js';
vi.mock('../src/context/ThemeContext.js', () => ({ useTheme: () => ({ settings: { baseCurrency: 'TRY' } }) }));
const money = (n: number, currency: string) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
const base = { totalIncome: 0, totalPaidExpense: 200, actualCashInHand: 800, totalPendingExpense: 0, overdueDebt: 0, netPositionAfterDue: 800, totalTransactions: 2, personContributions: [] };
const render = (balance: React.ComponentProps<typeof BalanceBar>['balance']) => renderToString(<BalanceBar balance={balance} onOpenPersonContributions={() => {}} />).replace(/<!-- -->/g, '');
describe('BalanceBar financial report', () => {
  it('uses report currency and preserves server cash including opening balance', () => {
    const html = render({ ...base, baseCurrency: 'USD' });
    expect(html).toContain(money(800, 'USD')); expect(html).not.toContain(money(800, 'TRY'));
    expect(html).toContain('açılış dahil'); expect(html).not.toContain('Kasa Girişi - Ödenen Giderler');
    expect(render(base)).toContain(money(800, 'TRY')); expect(html).not.toContain(money(-200, 'USD'));
  });
  it('separates excluded currencies without conversion or duplicate base panel', () => {
    const html = render({ ...base, baseCurrency: 'TRY', actualCashInHand: 0, netPositionAfterDue: 0, mixedCurrency: true, excludedCurrencies: ['USD'], byCurrency: { TRY: { actualCashInHand: 0, totalPendingExpense: 0, netPositionAfterDue: 0 }, USD: { actualCashInHand: 200, totalPendingExpense: 10, netPositionAfterDue: 190, crossScopeWalletNetTotal: 5, inactiveWalletBalanceTotal: 800, inactiveAccountCount: 2 } } });
    expect(html).toContain('role='); expect(html).toContain('yalnızca TRY'); expect(html).toContain(money(0, 'TRY')); expect(html).toContain(money(200, 'USD')); expect(html).not.toContain(money(200, 'TRY'));
    expect(html).toContain('ana nakit toplamına dahil değildir'); expect(html).toContain(money(190, 'USD')); expect(html).toContain(money(10, 'USD')); expect(html).toContain(money(800, 'USD')); expect(html).toContain('Pasif hesap sayısı (USD)'); expect(html).toContain('+' + money(5, 'USD')); expect(html).not.toContain('TRY — ayrı bakiye');
    expect(render({ ...base, excludedCurrencies: ['USD'] })).toContain('yalnızca TRY');
  });
  it('shows signed current cross-scope movement and excludes inactive cash', () => {
    const html = render({ ...base, baseCurrency: 'TRY', cashScopeMode: 'current', crossScopeWalletNetTotal: -25, inactiveWalletBalanceTotal: 800, inactiveAccountCount: 3 });
    expect(html).toContain('GÜNCEL NAKİT DURUMU'); expect(html).toContain('Seçili cüzdan kapsamı dışındaki net hareket'); expect(html).toContain(money(-25, 'TRY'));
    expect(html).toContain('Pasif cüzdan bakiyesi (TRY): ' + money(800, 'TRY') + ' (ana nakit toplamına dahil değildir)'); expect(html).toContain('Pasif hesap sayısı (TRY): 3');
  });
  it.each([
    { cash: 500, pending: 100, net: 400, overdue: 30, usdCash: 200, usdPending: 20, usdNet: 180, usdOverdue: 10 },
    { cash: -100, pending: 80, net: -180, overdue: 0, usdCash: -20, usdPending: 30, usdNet: -50, usdOverdue: 0 },
  ])('labels period debt and net flows for $net', ({ cash, pending, net, overdue, usdCash, usdPending, usdNet, usdOverdue }) => {
    const html = render({ ...base, baseCurrency: 'TRY', cashScopeMode: 'filtered_period', totalIncome: cash > 0 ? 700 : 100, totalPaidExpense: cash > 0 ? 200 : 200, actualCashInHand: cash, totalPendingExpense: pending, overdueDebt: overdue, netPositionAfterDue: net, byCurrency: { USD: { actualCashInHand: usdCash, totalPendingExpense: usdPending, netPositionAfterDue: usdNet, overdueDebt: usdOverdue } } });
    expect(html).toContain('DÖNEM NAKİT AKIŞI'); expect(html).toContain('Seçili dönemdeki net nakit hareketleri');
    expect(html).toContain('SEÇİLİ DÖNEM KAYITLARINDA VADESİ GELMİŞ / GEÇMİŞ BORÇ'); expect(html).toContain(overdue ? 'Seçili dönem kayıtlarında vadesi gelmiş / geçmiş borç' : 'Seçili dönem kayıtlarında vadesi geçmiş borç yok');
    expect(html).toContain('SEÇİLİ DÖNEM KAYITLARINDA BEKLEYEN BORÇ'); expect(html).toContain('Seçili dönem kayıtlarındaki ödenmemiş giderler');
    expect(html).toContain('DÖNEM BORÇLARI SONRASI NET AKIŞ'); expect(html).toContain('Seçili dönem net nakit akışından seçili dönem kayıtlarının ödenmemiş giderleri düşülür'); expect(html).toContain(money(net, 'TRY'));
    expect(html).toContain('Seçili dönem kayıtlarında bekleyen borç: ' + money(usdPending, 'USD')); expect(html).toContain('Dönem borçları sonrası net akış: ' + money(usdNet, 'USD')); expect(html).toContain('Seçili dönem kayıtlarında vadesi gelmiş / geçmiş borç: ' + money(usdOverdue, 'USD'));
    expect(html).not.toContain('Tüm vadeler sonrası artı bakiye'); expect(html).not.toContain('Fon açığı / Ek kaynak gerekli'); expect(html).not.toContain('GÜNCEL NAKİT DURUMU'); expect(html).not.toContain('Güncel nakit durumu');
  });
  it('handles missing report and retains contribution summary and button', () => {
    const empty = render(null); expect(empty).toContain('henüz yok'); expect(empty).not.toContain(money(0, 'TRY')); expect(empty).not.toContain('GERÇEK NAKİT');
    const html = render({ ...base, personContributions: [{ personName: 'Deniz', directKasaAmount: 50, otoKasaAmount: 0, totalAmount: 50, transactionCount: 1 }] });
    expect(html).toContain('Deniz'); expect(html).toContain('Kişi Dökümünü Gör'); expect(html).toContain('<button');
  });
});
