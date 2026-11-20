import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { QuickTransactionTable } from "../src/components/QuickTransactionTable.js";
vi.mock("../src/context/ThemeContext.js", () => ({ useTheme: () => ({ settings: { primaryColor: "#123456" } }) }));
const tx = (title: string, extra: Record<string, unknown> = {}) => ({ id: title, title, date: "2026-11-14", amount: 100, currency: "TRY", type: "expense", status: "approved", isPaid: false, ...extra });
const render = (transactions: any[], props: Record<string, unknown> = {}) => renderToStaticMarkup(<QuickTransactionTable transactions={transactions} categories={[]} onOpenNewModal={() => {}} onEditTransaction={() => {}} onDeleteTransaction={async () => {}} onMarkPaid={async () => {}} onSearch={() => {}} isLoading={false} {...props} />);
const row = (html: string, title: string) => { const i = html.indexOf(">" + title + "<"); expect(i).toBeGreaterThan(-1); return html.slice(html.lastIndexOf("<tr", i), html.indexOf("</tr>", i) + 5); };
const text = (html: string) => html.split("<").map((part, i) => i === 0 ? part : part.slice(part.indexOf(">") + 1)).join("").replaceAll("&amp;", "&").trim();
const cells = (html: string, tag: string) => html.split("<" + tag + " ").slice(1).map(part => text(part.slice(part.indexOf(">") + 1, part.indexOf("</" + tag + ">"))));
const count = (html: string, value: string) => html.split(value).length - 1;
describe("Quick transaction raw disclosure", () => {
  it("renders eleven ordered headers, accessible scrolling and payment filter labels", () => {
    const html = render([tx("first")]);
    expect(cells(html, "th")).toEqual(["İşlem", "Tarih", "Açıklama / Kalem & Okunuş", "Kategori / Kırılım", "Ödeme Kaynağı", "Tedarikçi / Cari", "Tutar", "Tür", "Durum", "Ödeme", "Vade"]);
    const region = html.split("<div").find(part => part.includes("role=" + String.fromCharCode(34) + "region" + String.fromCharCode(34)));
    expect(region).toBeDefined(); expect(region).toContain("tabindex=" + String.fromCharCode(34) + "0" + String.fromCharCode(34)); expect(region).toContain("aria-label="); expect(region).toContain("overflow-x-auto");
    for (const [value, label] of [["all", "Tüm ödeme durumları"], ["paid", "Ödenenler"], ["pending", "Ödenmeyenler"]]) { const option = html.split("<option").find(part => part.includes("value=" + String.fromCharCode(34) + value + String.fromCharCode(34))); expect(option).toBeDefined(); expect(text(option!.slice(option!.indexOf(">") + 1).split("</option>")[0])).toBe(label); }
  });
  it("preserves raw rows, literal types and statuses, deletion and native currency", () => {
    const rows = [tx("draft-paid", { status: "draft", isPaid: true, baseAmount: 999999 }), tx("pending-unpaid", { status: "pending" }), tx("approved-unpaid"), tx("paidstatus-unpaid", { status: "paid" }), tx("income", { type: "income", currency: "USD", amount: 5 }), tx("linked", { type: "income", otoKasaTransactionId: "draft-paid" }), tx("transfer", { type: "transfer" }), tx("deleted", { deletedAt: "2026-01-01" })];
    const html = render(rows); let previous = -1;
    for (const item of rows) { const position = html.indexOf(">" + item.title + "<"); expect(position).toBeGreaterThan(previous); previous = position; const c = cells(row(html, item.title), "td"); expect(c).toHaveLength(11); expect(c[7]).toContain(item.type); expect(c[8]).toContain(item.status); }
    expect(cells(row(html, "deleted"), "td")[8]).toContain("Silinmiş");
    expect(row(html, "draft-paid")).toContain(new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(100));
    expect(row(html, "income")).toContain(new Intl.NumberFormat("tr-TR", { style: "currency", currency: "USD" }).format(5)); expect(html).not.toContain("999.999");
  });
  it("distinguishes missing fields, payment values and UTC due dates", () => {
    const today = new Date().toISOString().split("T")[0]; const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0]; const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    const rows = [tx("empty", { type: "", status: "", isPaid: null, dueDate: "" }), tx("missing", { type: undefined, status: undefined, isPaid: undefined, dueDate: undefined }), tx("nulls", { type: null, status: null, isPaid: null, dueDate: null }), tx("paid-no-date", { isPaid: true, dueDate: null }), tx("paid-date", { isPaid: true, dueDate: tomorrow + "T12:00:00Z" }), tx("past", { isPaid: false, dueDate: yesterday }), tx("today", { isPaid: false, dueDate: today }), tx("future", { isPaid: false, dueDate: tomorrow }), tx("unknown-date", { isPaid: undefined, dueDate: tomorrow })];
    const html = render(rows);
    for (const name of ["empty", "missing", "nulls"]) { const c = cells(row(html, name), "td"); expect(c[7]).toContain("Belirtilmemiş"); expect(c[8]).toContain("Belirtilmemiş"); expect(c[9]).toContain("Belirtilmemiş"); expect(c[10]).toContain("Vade belirtilmedi"); }
    expect(cells(row(html, "paid-no-date"), "td")[10]).toContain("Vade belirtilmedi");
    const paid = cells(row(html, "paid-date"), "td"); expect(paid[9]).toContain("Ödendi"); expect(paid[10]).toContain(tomorrow); expect(paid[10]).toContain("Ödendi");
    for (const name of ["past", "today"]) { const c = cells(row(html, name), "td"); expect(c[9]).toContain("Ödenmedi"); expect(c[10]).toContain("Vadesi geçmiş"); }
    expect(cells(row(html, "future"), "td")[10]).toContain("Vadeli"); const unknown = cells(row(html, "unknown-date"), "td"); expect(unknown[9]).toContain("Belirtilmemiş"); expect(unknown[10]).toContain(tomorrow); expect(unknown[10]).not.toContain("Vadeli"); expect(unknown[10]).not.toContain("Ödendi"); expect(unknown[10]).not.toContain("Vadesi geçmiş");
  });
  it("preserves mutation permissions and loading and empty spans", () => {
    const rows = [tx("one", { isPaid: false }), tx("two", { isPaid: true }), tx("three", { isPaid: undefined })]; const readonly = render(rows); const writable = render(rows, { canMutate: true });
    for (const title of ["Şimdi Ödendi Olarak İşaretle", "Kaydı Düzenle", "Kaydı Sil"]) expect(readonly).not.toContain("title=" + String.fromCharCode(34) + title + String.fromCharCode(34));
    expect(count(writable, "title=" + String.fromCharCode(34) + "Şimdi Ödendi Olarak İşaretle" + String.fromCharCode(34))).toBe(2); expect(count(writable, "Ödendi Yap")).toBe(2); expect(count(writable, "title=" + String.fromCharCode(34) + "Kaydı Düzenle" + String.fromCharCode(34))).toBe(3); expect(count(writable, "title=" + String.fromCharCode(34) + "Kaydı Sil" + String.fromCharCode(34))).toBe(3);
    const loading = render(rows, { isLoading: true }); expect(loading).not.toContain(">one<"); expect(loading).toContain("colSpan=" + String.fromCharCode(34) + "11" + String.fromCharCode(34)); const empty = render([]); expect(empty).toContain("colSpan=" + String.fromCharCode(34) + "11" + String.fromCharCode(34));
  });
});
