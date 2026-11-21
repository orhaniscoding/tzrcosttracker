import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KasaTable } from '../src/components/KasaTable.js';
import { computeReportFinance } from '../src/report-finance.js';
const theme = vi.hoisted(() => ({ baseCurrency: 'TRY' as string | undefined }));
vi.mock('../src/context/ThemeContext.js', () => ({ useTheme: () => ({ settings: { baseCurrency: theme.baseCurrency } }) }));
beforeEach(() => { theme.baseCurrency = 'TRY'; });
const tx = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, date: '2026-11-14', type: 'income', status: 'approved', isPaid: true, deletedAt: null, paymentSource: 'company_account', otoKasaTransactionId: null, currency: 'TRY', amount: 100, baseAmount: 999999, payerPersonName: 'Ayşe', ...extra } as any);
const rows = [tx('real', { baseAmount: 999999 }), tx('pending', { status: 'pending', amount: 40 }), tx('unpaid', { isPaid: false, amount: 50 }), tx('linked', { otoKasaTransactionId: 'expense', amount: 10 }), tx('linkless', { paymentSource: 'person_out_of_pocket', amount: 20 }), tx('draft', { status: 'draft', amount: 999 }), tx('deleted', { deletedAt: '2026-01-01', amount: 888 }), tx('usd-paid', { currency: 'USD', amount: 50 }), tx('usd-unpaid', { currency: 'USD', amount: 5, isPaid: false }), tx('expense', { type: 'expense', amount: 30 }), tx('transfer', { type: 'transfer', amount: 777 }), tx('euro-expense', { type: 'expense', currency: 'EUR', amount: 17 })];
const render = (transactions: any[], props: Record<string, unknown> = {}) => renderToStaticMarkup(<KasaTable transactions={transactions} onAddKasaEntry={() => {}} {...props} />).replace(/<!-- -->/g, '');
const row = (html: string, name: string) => { const i = html.indexOf('>' + name + '<'); expect(i).toBeGreaterThan(-1); return html.slice(html.lastIndexOf('<tr', i), html.indexOf('</tr>', i) + 5); };
const panel = (html: string, code: string) => { const label = 'Ger\u00e7ekle\u015fmi\u015f \u015firket nakit giri\u015fi ' + code; const i = html.indexOf(label); expect(i).toBeGreaterThan(-1); const start = html.lastIndexOf('<section', i); const end = html.indexOf('</section>', i); expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(i); return html.slice(start, end + 10); };
describe('Kasa income records', () => {
  it('uses realized income-only cash flow and preserves all raw rows', () => {
    expect(computeReportFinance(rows, 'TRY').cashFlowNet).toBe(70);
    expect(computeReportFinance(rows.filter(x => x.type === 'income'), 'TRY').cashFlowNet).toBe(100);
    const html = render(rows, { baseCurrency: 'TRY' });
    expect(html).toContain('Gelir kayıtları ve gerçekleşmiş nakit girişleri');
    expect(html).toContain('Yüklenen kayıtlardaki gerçekleşmiş şirket nakit girişi');
    expect(panel(html, 'TRY')).toContain('>100,00 TRY</span>'); expect(panel(html, 'TRY')).not.toContain('>70,00 TRY</span>'); expect(panel(html, 'USD')).toContain('>50,00 USD</span>'); expect(panel(html, 'TRY')).toContain('TRY (baz para birimi)'); expect(panel(html, 'USD')).not.toContain('(baz para birimi)'); expect(html).toContain('9 ham gelir kaydı');
    expect(html).not.toContain('999.999,00'); expect(html).not.toContain('17,00 EUR');
    for (const x of rows.filter(x => x.type === 'income')) expect(row(html, x.title)).toContain(x.title);
    for (const x of rows.filter(x => x.type !== 'income')) expect(html).not.toContain('>' + x.title + '<');
    expect(row(html, 'pending')).toContain('pending'); expect(row(html, 'unpaid')).toContain('Ödenmemiş');
    expect(row(html, 'draft')).toContain('draft'); expect(row(html, 'deleted')).toContain('Silinmiş');
    expect(row(html, 'linkless')).toContain('Şahıs finansmanı — OTO yansıması');
    expect(row(html, 'linked')).toContain('Şahıs finansmanı — OTO yansıması');
    expect(row(html, 'pending')).not.toContain('Doğrudan Kasa Girişi'); expect(row(html, 'draft')).not.toContain('Doğrudan Kasa Girişi');
  });
  it('keeps the base zero and hides stale content during loading', () => {
    const usd = render([tx('dolar', { currency: 'USD', amount: 50 })], { baseCurrency: 'TRY' });
    expect(panel(usd, 'TRY')).toContain('>0,00 TRY</span>'); expect(panel(usd, 'USD')).toContain('>50,00 USD</span>'); expect(panel(usd, 'TRY')).toContain('TRY (baz para birimi)'); expect(panel(usd, 'USD')).not.toContain('(baz para birimi)');
    const loading = render(rows, { isLoading: true, canMutate: true });
    expect(loading).toContain('role="status"'); expect(loading).not.toContain('real'); expect(loading).not.toContain('100,00'); expect(loading).not.toContain('<button');
    const empty = render([]); const pending = render([tx('waiting', { status: 'pending' })]);
    expect(empty).toContain('0,00 TRY'); expect(pending).toContain('0,00 TRY'); expect(pending).toContain('waiting'); expect(empty).not.toEqual(pending);
  });
  it('designates independent currency panels and retains separate similar records', () => {
    const html = render(rows, { baseCurrency: 'USD' });
    expect(panel(html, 'USD')).toContain('>50,00 USD</span>'); expect(panel(html, 'TRY')).toContain('>100,00 TRY</span>'); expect(panel(html, 'USD')).toContain('USD (baz para birimi)'); expect(panel(html, 'TRY')).not.toContain('(baz para birimi)');
    theme.baseCurrency = 'USD'; const themed = render(rows); expect(panel(themed, 'USD')).toContain('>50,00 USD</span>'); expect(panel(themed, 'TRY')).toContain('>100,00 TRY</span>'); expect(panel(themed, 'USD')).toContain('USD (baz para birimi)'); expect(panel(themed, 'TRY')).not.toContain('(baz para birimi)');
    theme.baseCurrency = undefined; const fallback = render(rows); expect(panel(fallback, 'TRY')).toContain('TRY (baz para birimi)'); expect(panel(fallback, 'USD')).not.toContain('(baz para birimi)');
    expect(html).toContain('Gerçekleşmiş şirket nakit girişi USD');
    expect(html).toContain('Gerçekleşmiş şirket nakit girişi TRY');
    expect(html).not.toContain('Gerçekleşmiş şirket nakit girişi EUR');
    expect((html.match(/<tbody[^>]*>[\s\S]*?<\/tbody>/) || [''])[0].match(/<tr/g)).toHaveLength(9);
    expect(row(html, 'real')).toContain('approved'); expect(row(html, 'real')).toContain('Ödenmiş');
    expect(row(html, 'pending')).toContain('Ödenmiş'); expect(row(html, 'unpaid')).not.toContain('Silinmiş');
    expect(row(html, 'deleted')).toContain('Silinmiş'); expect(row(html, 'draft')).not.toContain('Silinmiş');
    const pair = [tx('a', { title: 'Aynı', date: '2026-11-13' }), tx('b', { title: 'Aynı', date: '2026-11-14' })];
    const duplicate = render(pair); expect((duplicate.match(/>Aynı</g) || [])).toHaveLength(2);
    expect(duplicate).toContain('2026-11-13'); expect(duplicate).toContain('2026-11-14');
    expect(render([tx('only-usd', { currency: 'USD' })])).toContain('0,00 TRY');
  });
  it('guards the add callback and hides stale labels while loading', () => {
    const onAddKasaEntry = vi.fn();
    const findButton = (node: any): any => { if (!node || typeof node !== 'object') return undefined; if (node.type === 'button') return node; for (const child of React.Children.toArray(node.props?.children)) { const found = findButton(child); if (found) return found; } return undefined; };
    function captureButton(canMutate: boolean, isLoading = false) {
      let button: ReturnType<typeof findButton>;
      function Capture() {
        const tree = KasaTable({ transactions: rows, onAddKasaEntry, canMutate, isLoading });
        button = findButton(tree);
        return tree;
      }
      renderToStaticMarkup(<Capture />);
      return button;
    }
    expect(captureButton(false)).toBeUndefined();
    expect(captureButton(true, true)).toBeUndefined();
    const button = captureButton(true);
    expect(button).toBeDefined(); button.props.onClick(); expect(onAddKasaEntry).toHaveBeenCalledTimes(1);
    const loading = render(rows, { isLoading: true, canMutate: true });
    expect(loading).not.toContain('ham gelir kaydı'); expect(loading).not.toContain('pending'); expect(loading).not.toContain('Şahıs finansmanı');
  });

  it('preserves dates, payer fallbacks and TRY-only words regardless of base', () => {
    const entries = [tx('first', { date: '2026-11-13T23:30:00-08:00', amountInWords: 'LİRA YAZI' }), tx('second', { date: '2026-11-14', payerPersonName: null, party: 'Ortak' }), tx('third', { payerPersonName: null, party: null, currency: 'USD', amountInWords: 'DOLAR YAZI' })];
    const html = render(entries, { baseCurrency: 'USD' });
    expect(row(html, 'first')).toContain('2026-11-13'); expect(row(html, 'first')).toContain('Ayşe'); expect(row(html, 'first')).toContain('LİRA YAZI');
    expect(row(html, 'second')).toContain('2026-11-14'); expect(row(html, 'second')).toContain('Ortak'); expect(row(html, 'third')).toContain('Diğer');
    expect(html).not.toContain('DOLAR YAZI'); expect(render(entries, { baseCurrency: 'TRY' })).not.toContain('DOLAR YAZI');
    expect(render(entries)).not.toContain('<button');
  });
  it('excludes each isolated USD income while retaining its raw row', () => {
    const cases = [
      ['pending-only', { status: 'pending', isPaid: true }, 'Gelir kaydı'],
      ['draft-only', { status: 'draft' }, 'Gelir kaydı'],
      ['deleted-only', { deletedAt: '2026-01-01' }, 'Gelir kaydı'],
      ['linked-only', { otoKasaTransactionId: 'expense' }, 'Şahıs finansmanı — OTO yansıması'],
      ['person-only', { paymentSource: 'person_out_of_pocket' }, 'Şahıs finansmanı — OTO yansıması'],
    ] as const;
    for (const [name, extra, label] of cases) {
      const html = render([tx(name, { currency: 'USD', amount: 37, ...extra })]);
      expect(panel(html, 'TRY')).toContain('>0,00 TRY</span>');
      expect(panel(html, 'USD')).toContain('>0,00 USD</span>');
      expect(row(html, name)).toContain('37,00 USD');
      expect(row(html, name)).toContain(label);
    }
  });
  it('includes paid and defensive unspecified fields but excludes explicit unpaid', () => {
    const html = render([
      tx('paid-status', { status: 'paid', amount: 11 }),
      tx('no-source', { paymentSource: undefined, amount: 13 }),
      tx('unspecified', { paymentSource: undefined, isPaid: undefined, amount: 17 }),
      tx('explicit-false', { isPaid: false, amount: 19 }),
    ]);
    expect(panel(html, 'TRY')).toContain('>41,00 TRY</span>');
    for (const [name, amount] of [['paid-status', '11,00 TRY'], ['no-source', '13,00 TRY'], ['unspecified', '17,00 TRY'], ['explicit-false', '19,00 TRY']]) {
      expect(row(html, name)).toContain(amount);
      expect(row(html, name)).toContain('Gelir kaydı');
    }
    expect(row(html, 'paid-status')).toContain('Durum: paid');
    expect(row(html, 'paid-status')).toContain('Ödenmiş');
    expect(row(html, 'unspecified')).toContain('Belirtilmemiş');
    expect(row(html, 'explicit-false')).toContain('Ödenmemiş');
  });
  it('distinguishes loading, true empty, and pending-only states', () => {
    const loading = render([], { isLoading: true, canMutate: true });
    expect(loading).toContain('role="status"');
    expect(loading).not.toContain('0,00');
    expect(loading).not.toContain('Bu toplam yalnız yüklenen gelir kayıtlarını kapsar');
    expect(loading).not.toContain('<table');
    expect(loading).not.toContain('<button');
    const empty = render([]);
    expect(empty).toContain('Henüz gelir kaydı bulunmuyor.');
    const pending = render([tx('pending-alone', { status: 'pending', isPaid: true })]);
    expect(panel(pending, 'TRY')).toContain('>0,00 TRY</span>');
    expect(row(pending, 'pending-alone')).toContain('Gelir kaydı');
    expect(row(pending, 'pending-alone')).toContain('100,00 TRY');
    expect(pending).not.toContain('Henüz gelir kaydı bulunmuyor.');
  });
});
