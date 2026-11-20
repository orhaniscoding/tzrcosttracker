import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, vi } from 'vitest';
import { PersonContributionsView } from '../src/components/PersonContributionsView.js';
vi.mock('../src/context/ThemeContext.js', () => ({ useTheme: () => ({ settings: { baseCurrency: 'TRY' } }) }));
const person = (personName: string, directKasaAmount: number, otoKasaAmount: number, transactionCount: number) => ({ personName, directKasaAmount, otoKasaAmount, totalAmount: directKasaAmount + otoKasaAmount, transactionCount });
const tx = (id: string, extra: Record<string, unknown> = {}) => ({ id, date: '2026-11-14', type: 'income', status: 'approved', isPaid: true, title: id, amount: 100, currency: 'TRY', payerPersonName: 'Ayşe', ...extra } as any);
const render = (report: any, transactions: any[] = [], isLoading = false) => renderToStaticMarkup(<PersonContributionsView report={report} transactions={transactions} isLoading={isLoading} />).replace(/<!-- -->/g, '');
const panel = (html: string, currency: string) => { const start = html.indexOf('Şahıs katkıları ' + currency); expect(start).toBeGreaterThan(-1); return html.slice(start, html.indexOf('</section>', start)); };
const metric = (region: string, label: string, value: string) => {
  expect(region).toContain("<dt>" + label + "</dt><dd class=" + JSON.stringify("font-bold") + ">" + value + "</dd>");
};
const card = (region: string, name: string, values: string[]) => {
  const heading = ">" + name + "</h4>";
  const at = region.indexOf(heading); expect(at).toBeGreaterThan(-1);
  const button = region.slice(region.lastIndexOf("<button", at), region.indexOf("</button>", at) + 9);
  for (const value of values) expect(button).toContain("<div>" + value + "</div>");
};
const report = { baseCurrency: 'TRY', personContributions: [person('Ayşe', 100, 30, 2), person('Mehmet', 130, 0, 1)], byCurrency: { TRY: { personContributions: [] }, USD: { personContributions: [person('Ayşe', 20, 5, 2)] } }, cashScopeMode: 'filtered_period' };
const exactRow = (html: string, id: string) => {
  const marker = "data-testid=" + JSON.stringify("contribution-" + id);
  const start = html.indexOf(marker); expect(start).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<tr", start), html.indexOf("</tr>", start) + 5);
};
describe("person contributions", () => {
  it("preserves each contribution lexical calendar date in its own first cell", () => {
    const html = render(report, [tx("dated-a", { title: "Aynı başlık", amount: 25, currency: "USD", date: "2026-11-13T23:30:00-08:00" }), tx("dated-b", { title: "Aynı başlık", amount: 25, currency: "USD", date: "2026-11-14" })]);
    expect(html).toContain("<thead><tr><th>Tarih</th><th>Kişi</th>");
    const a = exactRow(html, "dated-a"); const b = exactRow(html, "dated-b");
    expect(a).not.toEqual(b);
    expect(a).toContain("<td>2026-11-13</td><td>Ayşe</td>");
    expect(b).toContain("<td>2026-11-14</td><td>Ayşe</td>");
    for (const row of [a, b]) { expect(row).toContain("<div>Aynı başlık</div>"); expect(row).toContain("<td>25,00 USD</td>"); }
  });
  it('uses independent authoritative currency panels', () => {
    const html = render(report, [tx('misleading', { amount: 1, baseAmount: 90000 })]);
    const a = panel(html, 'TRY'); const b = panel(html, 'USD');
    for (const [label, value] of [["Toplam katkı", "260,00 TRY"], ["Doğrudan katkı", "230,00 TRY"], ["OTO katkısı", "30,00 TRY"]]) metric(a, label, value);
    for (const [label, value] of [["Toplam katkı", "25,00 USD"], ["Doğrudan katkı", "20,00 USD"], ["OTO katkısı", "5,00 USD"]]) metric(b, label, value);
    card(a, "Ayşe", ["Toplam katkı: 130,00 TRY", "Doğrudan katkı: 100,00 TRY", "OTO katkısı: 30,00 TRY", "Katkı kaydı: 2", "50.0%"]);
    card(a, "Mehmet", ["Toplam katkı: 130,00 TRY", "Doğrudan katkı: 130,00 TRY", "OTO katkısı: 0,00 TRY", "Katkı kaydı: 1", "50.0%"]);
    card(b, "Ayşe", ["Toplam katkı: 25,00 USD", "Doğrudan katkı: 20,00 USD", "OTO katkısı: 5,00 USD", "Katkı kaydı: 2", "100.0%"]);
    expect(html.split("aria-label=" + JSON.stringify("Şahıs katkıları TRY"))).toHaveLength(2);
    expect(html).toContain('Seçili dönem katkıları'); expect(html).toContain('Kartlar sunucu raporu kapsamındadır; kişi seçimi ve arama yalnız yüklenen katkı detaylarını süzer.');
  });
  it('filters loaded records without treating expenses as contributions', () => {
    const rows = [tx('direct'), tx('oto', { amount: 30, otoKasaTransactionId: 'expense' }), tx('expense', { type: 'expense' }), tx('usd-direct', { amount: 20, currency: 'USD' }), tx('usd-oto', { amount: 5, currency: 'USD', paymentSource: 'person_out_of_pocket' }), tx('pending-oto', { status: 'pending', paymentSource: 'person_out_of_pocket' }), tx('other', { payerPersonName: null, party: null }), tx('pending-direct', { status: 'pending' }), tx('unpaid', { isPaid: false }), tx('unpaid-oto', { isPaid: false, paymentSource: 'person_out_of_pocket' }), tx('draft', { status: 'draft' }), tx('deleted', { deletedAt: '2026-01-01' }), tx('company-expense', { type: 'expense' }), tx('transfer', { type: 'transfer' })];
    const html = render(report, rows); expect(html).toContain('Yüklenen katkı kayıtları');
    for (const [id, name, amount, status] of [["direct", "Ayşe", "100,00 TRY", "approved"], ["oto", "Ayşe", "30,00 TRY", "approved"], ["usd-direct", "Ayşe", "20,00 USD", "approved"], ["usd-oto", "Ayşe", "5,00 USD", "approved"], ["pending-oto", "Ayşe", "100,00 TRY", "pending"], ["other", "Diğer", "100,00 TRY", "approved"]]) {
      const row = exactRow(html, id);
      expect(row).toContain("<td>" + name + "</td>"); expect(row).toContain("<div>" + id + "</div>");
      expect(row).toContain("<td>" + status + "</td><td>Ödenmiş</td>"); expect(row).toContain("<td>" + amount + "</td>");
    }
    for (const id of ["expense", "pending-direct", "unpaid", "unpaid-oto", "draft", "deleted", "company-expense", "transfer"]) expect(html).not.toContain("data-testid=" + JSON.stringify("contribution-" + id));
    expect(html.match(/data-testid=/g)).toHaveLength(6);
    expect(exactRow(html, "oto")).toContain("Şahıs finansmanı — OTO yansıması");
  });
  it('requires exact expense linkage and discloses deleted context', () => {
    const html = render(report, [tx('missing', { otoKasaTransactionId: 'absent' }), tx('wrong', { type: 'expense', title: 'Yanlış eşleşen gider', amount: 100, payerPersonName: 'Ayşe' }), tx('linked', { otoKasaTransactionId: 'deleted-expense' }), tx('deleted-expense', { type: 'expense', deletedAt: '2026-01-01', status: 'draft', isPaid: false })]);
    const missing = exactRow(html, "missing"); const linked = exactRow(html, "linked");
    expect(missing).toContain("İlişkili gider yüklenen kayıtlarda bulunmuyor"); expect(missing).not.toContain("Yanlış eşleşen gider");
    expect(linked).toContain("İlişkili gider: deleted-expense — Durum: draft — Ödeme: Ödenmemiş — Silinmiş");
    expect(linked).toContain("<td>100,00 TRY</td>"); expect(linked).toContain("<td>approved</td><td>Ödenmiş</td>");
    expect(html).not.toContain("data-testid=" + JSON.stringify("contribution-deleted-expense"));
  });
  it("keeps the report base and empty base panel", () => {
    const usd = render({ baseCurrency: "USD", personContributions: [person("Dolar Kişisi", 1, 0, 1)], byCurrency: { USD: { personContributions: [] }, TRY: { personContributions: [person("Lira Kişisi", 2, 0, 1)] } } });
    metric(panel(usd, "USD"), "Toplam katkı", "1,00 USD"); metric(panel(usd, "TRY"), "Toplam katkı", "2,00 TRY");
    card(panel(usd, "USD"), "Dolar Kişisi", ["Toplam katkı: 1,00 USD"]); card(panel(usd, "TRY"), "Lira Kişisi", ["Toplam katkı: 2,00 TRY"]);
    expect(usd.split("aria-label=" + JSON.stringify("Şahıs katkıları USD"))).toHaveLength(2);
    const zero = render({ baseCurrency: "TRY", personContributions: [], byCurrency: { USD: { personContributions: [person("Dolar Kişisi", 1, 0, 1)] } } });
    for (const label of ["Toplam katkı", "Doğrudan katkı", "OTO katkısı"]) metric(panel(zero, "TRY"), label, "0,00 TRY");
    card(panel(zero, "USD"), "Dolar Kişisi", ["Toplam katkı: 1,00 USD"]);
  });
  it("distinguishes loading, unavailable, empty and zero denominator", () => {
    const loading = render(null, [], true); const unavailable = render(null); const empty = render({ personContributions: [] });
    expect(loading).toBe("<div role=" + JSON.stringify("status") + ">Şahıs katkı raporu yükleniyor.</div>");
    expect(unavailable).toBe("<div role=" + JSON.stringify("status") + ">Şahıs katkı raporu kullanılamıyor.</div>");
    metric(panel(empty, "TRY"), "Toplam katkı", "0,00 TRY");
    expect(empty).toContain("<td colSpan=" + JSON.stringify("6") + ">Yüklenen kayıtlar arasında bu ölçütlere uygun katkı bulunmuyor.</td>");
    const zero = panel(render({ personContributions: [person("Sıfır", 0, 0, 0)] }), "TRY");
    card(zero, "Sıfır", ["0.0%"]); expect(zero).not.toMatch(/NaN|Infinity/);
  });
});
