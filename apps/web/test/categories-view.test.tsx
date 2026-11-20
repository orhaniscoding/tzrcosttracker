import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CategoriesView } from '../src/components/CategoriesView.js';
const theme = vi.hoisted(() => ({ baseCurrency: 'TRY' as string | undefined, primaryColor: '#7c3aed' }));
vi.mock('../src/context/ThemeContext.js', () => ({ useTheme: () => ({ settings: { baseCurrency: theme.baseCurrency, primaryColor: theme.primaryColor } }) }));
beforeEach(() => { theme.baseCurrency = 'TRY'; theme.primaryColor = '#7c3aed'; });
const cat = (id: string, parentId?: string, extra: Record<string, unknown> = {}) => ({ id, name: id, parentId, color: '#123456', ...extra } as any);
const tx = (id: string, categoryId: string, amount: number, extra: Record<string, unknown> = {}) => ({ id, title: id, date: '2026-11-14', type: 'expense', status: 'approved', isPaid: true, deletedAt: null, paymentSource: 'company_account', currency: 'TRY', amount, baseAmount: 999999, categoryId, ...extra } as any);
const render = (categories: any[], transactions: any[] = [], props: Record<string, unknown> = {}) => renderToStaticMarkup(<CategoriesView categories={categories} transactions={transactions} onAddCategory={async () => {}} onDeleteCategory={async () => {}} {...props} />).replace(/<!-- -->/g, '');
const card = (html: string, name: string) => { const i = html.indexOf('aria-label=\u0022Kategori: ' + name + '\u0022'); expect(i).toBeGreaterThan(-1); return html.slice(html.lastIndexOf('<article', i), html.indexOf('</article>', i) + 10); };
describe('category expense cards', () => {
  it('shows native descendant expenses once per flat card', () => { const cats = [cat('R'), cat('C', 'R'), cat('G', 'C')]; const rows = [tx('r', 'R', 10), tx('c', 'C', 20, { status: 'pending', isPaid: false, paymentSource: 'person_out_of_pocket' }), tx('g', 'G', 30, { status: 'paid', paymentSource: 'person_out_of_pocket' }), tx('both', 'C', 40, { subcategoryId: 'G', isPaid: false }), tx('usd', 'G', 5, { currency: 'USD' }), tx('draft', 'G', 300, { status: 'draft' }), tx('deleted', 'G', 400, { deletedAt: '2026-01-01' }), tx('income', 'G', 500, { type: 'income' })]; const h = render(cats, rows, { subView: 'tree' }); for (const [n, amount] of [['R', '100,00 TRY'], ['C', '90,00 TRY'], ['G', '70,00 TRY']]) { expect(card(h, n)).toContain(amount); expect(card(h, n)).toContain('5,00 USD'); expect(h.split('aria-label=\u0022Kategori: ' + n + '\u0022').length).toBe(2); } expect(h).not.toContain('999.999'); expect(h).toContain('Yüklenen kayıtların kategori ve alt kategori bazında tanınan giderleri.'); expect(h).toContain('Kategori özetleri örtüşebilir; kartlar toplanarak genel gider elde edilmez.'); });
  it('reports broken hierarchy and unknown references without hiding cards', () => { const cats = [cat('normal'), cat('orphan', 'missing'), cat('self', 'self'), cat('cycleA', 'cycleB'), cat('cycleB', 'cycleA')]; const h = render(cats, [tx('excluded', 'unknown', 5, { status: 'draft' })]); for (const n of ['orphan', 'self', 'cycleA', 'cycleB']) expect(card(h, n)).toContain('Hiyerarşi doğrulanamadı; gider kapsamı eksik olabilir.'); expect(card(h, 'normal')).not.toContain('Hiyerarşi doğrulanamadı'); expect(h).toContain('Bazı hareketlerin kategori bağlantısı bu görünümde doğrulanamıyor.'); expect(h).not.toContain('unknown'); });
  it('preserves missing, zero, negative and invalid budget distinctions', () => { const h = render([cat('missing'), cat('null', undefined, { budget: null }), cat('zero', undefined, { budget: 0 }), cat('negative', undefined, { budget: -5 }), cat('invalid', undefined, { budget: Infinity })]); for (const n of ['missing', 'null']) expect(card(h, n)).toContain('Bütçe bilgisi bu görünümde sunulmuyor'); expect(card(h, 'zero')).toContain('Bütçe kaydı: 0 — döviz/dönem/kapsam doğrulaması bekliyor'); expect(card(h, 'negative')).toContain('Bütçe kaydı: -5 — döviz/dönem/kapsam doğrulaması bekliyor'); expect(card(h, 'invalid')).toContain('Bütçe kaydı doğrulanamıyor'); expect(h).not.toContain('progressbar'); expect(h).not.toContain('%70'); });
  it('uses prop then theme then TRY and excludes phantom currencies', () => { const cats = [cat('R')]; const rows = [tx('usd', 'R', 5, { currency: 'USD' }), tx('draft', 'R', 9, { currency: 'EUR', status: 'draft' })]; theme.baseCurrency = 'GBP'; const h = card(render(cats, rows, { baseCurrency: 'TRY' }), 'R'); expect(h).toContain('0,00 TRY'); expect(h).toContain('5,00 USD'); expect(h.indexOf('0,00 TRY')).toBeLessThan(h.indexOf('5,00 USD')); expect(h).not.toContain('EUR'); expect(card(render(cats, rows), 'R')).toContain('0,00 GBP'); theme.baseCurrency = undefined; expect(card(render(cats, rows), 'R')).toContain('0,00 TRY'); });
  it('hides stale controls while loading and enforces readonly tree', () => { const cats = [cat('R'), cat('C', 'R')]; const loading = render(cats, [tx('r', 'R', 10)], { isLoading: true, canManage: true }); expect(loading).toContain('role=\u0022status\u0022'); expect(loading).toContain('Kategori giderleri yükleniyor...'); expect(loading).not.toContain('<button'); expect(loading).not.toContain('10,00'); const readonly = render(cats, [], { subView: 'new' }); expect(card(readonly, 'R')).toContain('0,00 TRY'); expect(readonly).not.toContain('<form'); const admin = render(cats, [], { canManage: true, subView: 'tree' }); expect(admin).toContain('Ana Kategoriyi Sil'); expect(admin).toContain('Alt Başlığı Sil'); expect(render([], [], { canManage: true, subView: 'new' })).toContain('Bütçe kaydı (opsiyonel; döviz/dönem/kapsam doğrulanmadı)'); });
});

describe('category form fidelity', () => {
  it('preserves the full form inputs and theme', () => {
    const h = render([], [], { canManage: true, subView: 'new' });
    const inputs = h.match(/<input[^>]*>/g) || [];
    const name = inputs.find(x => x.includes('Kaba Yapı')) || '';
    const code = inputs.find(x => x.includes('KY-01')) || '';
    const hex = inputs.find(x => /aria-label=\x22Renk kodu\x22/.test(x)) || '';
    expect(name).toMatch(/type=\x22text\x22/); expect(name).toMatch(/autoFocus/i);
    expect(code).toMatch(/type=\x22text\x22/);
    expect(hex).toMatch(/type=\x22text\x22/); expect(hex).toMatch(/value=\x22#2563EB\x22/);
    expect(inputs.some(x => /type=\x22color\x22/.test(x) && /value=\x22#2563EB\x22/.test(x))).toBe(true);
    expect(inputs.some(x => /type=\x22number\x22/.test(x) && /step=\x221\x22/.test(x))).toBe(true);
    const button = (h.match(/<button[^>]*>[^<]*Kategoriyi Sisteme Ekle<\/button>/) || [])[0] || '';
    expect(button).toMatch(/background-color:\s*#7c3aed/i);
  });
  it('keeps the default form compact', () => {
    const h = render([], [], { canManage: true }); const form = (h.match(/<form[^>]*>[\s\S]*?<\/form>/) || [])[0] || '';
    const inputs = form.match(/<input[^>]*>/g) || [];
    expect(inputs).toHaveLength(1); expect(inputs[0]).toMatch(/type=\x22text\x22/);
    expect(inputs[0]).toContain('Kategori Adı'); expect(form).toMatch(/>Ekle<\/button>/);
    expect(form).not.toContain('Bütçe'); expect(form).not.toContain('<textarea'); expect(form).not.toContain('<select');
  });
});
