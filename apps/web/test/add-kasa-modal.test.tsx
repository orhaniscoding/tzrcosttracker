import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { AddKasaModal } from "../src/components/AddKasaModal.js";
vi.mock("../src/context/ThemeContext.js", () => ({ useTheme: () => ({ settings: { primaryColor: "#7c3aed", baseCurrency: "EUR" } }) }));
const cats = [{ id: "11111111-1111-4111-8111-111111111111", name: "Root" }, { id: "22222222-2222-4222-8222-222222222222", name: "Other" }, { id: "33333333-3333-4333-8333-333333333333", name: "Child", parentId: "11111111-1111-4111-8111-111111111111" }] as any[];
const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(<AddKasaModal {...({ isOpen: true, onClose: () => {}, onAdd: async () => {}, categories: cats, baseCurrency: "USD", ...props } as any)} />).replaceAll("<!-- -->", "");
const q = String.fromCharCode(34);
const submit = (h: string) => h.split("<button").slice(1).map(x => x.split(">")[0]).find(x => x.includes("type=" + q + "submit" + q)) || "";
const labelFor = (h: string, text: string) => { const label = h.split("<label").slice(1).find(x => x.split("</label>")[0].includes(text)) || ""; const id = label.split("for=" + q)[1]?.split(q)[0]; expect(id).toBeTruthy(); expect(h).toContain("id=" + q + id + q); };
describe("AddKasaModal safety", () => {
  it("renders nothing when closed", () => { expect(render({ isOpen: false })).toBe(""); });
  it("offers a blank labelled category choice and all valid catalog entries", () => {
    const h = render(); const select = (h.split("<select")[1] || "").split("</select>")[0];
    const blank = select.split("<option").slice(1).find(x => x.split(">")[0].includes("value=" + q + q)) || "";
    expect(blank.split(">")[0]).toContain("selected");
    for (const c of cats) { expect(select).toContain(c.id); expect(select).toContain(c.name); }
    labelFor(h, "Kategori"); expect(h).not.toContain("123e4567-e89b-12d3-a456-426614174000");
  });
  it("explains empty or invalid catalogs and disables submission", () => {
    for (const categories of [[], [{ id: "bad", name: "Bad" }, { id: cats[0].id, name: "   " }]]) {
      const h = render({ categories }); expect(h.toLowerCase()).toContain("kategori");
      expect(submit(h)).toContain("disabled"); expect(h).not.toContain("value=" + q + "bad" + q);
    }
  });
  it("shows server currency without a currency selector and blocks invalid server codes", () => {
    const h = render(); expect(h).toContain("USD"); expect(h).not.toContain("EUR"); expect(h.split("<select")).toHaveLength(2);
    for (const baseCurrency of [undefined, "", "usd", "US", "US1"]) {
      const blocked = render({ baseCurrency }); expect(blocked.toLowerCase()).toContain("para birimi");
      expect(submit(blocked)).toContain("disabled"); expect(blocked).not.toContain("EUR");
    }
  });
  it("retains associated date person amount inputs and existing close controls", () => {
    const h = render(); labelFor(h, "Tarih"); labelFor(h, "Kişi"); labelFor(h, "Tutar");
    expect(h).toContain("type=" + q + "date" + q); expect(h).toContain("type=" + q + "number" + q);
    expect(h).toContain("step=" + q + "0.01" + q); expect(h).toContain("Vazgeç"); expect(h).toContain("Kasaya İşle");
  });
});
