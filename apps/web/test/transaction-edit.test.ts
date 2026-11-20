import { describe, it, expect } from "vitest";
import { buildTransactionEditPayload } from "../src/transaction-edit.js";
const baseForm = { date: new Date("2024-01-02").toISOString(), title: "Title", amount: 123.456, currency: "TRY", categoryId: "11111111-1111-4111-8111-111111111111", subcategoryId: null, party: null, description: null, paymentSource: "company_account" as const, payerPersonName: null, paymentMethod: "Banka", isPaid: true, dueDate: null, accountId: null };
const orig = (o:any={}) => ({ type:"expense", status:"approved", isPaid:true, paymentSource:"company_account", accountFromId:null, accountToId:null, otoKasaTransactionId:null, ...o });
describe("transaction-edit payload", () => {
  it("draft legacy true omits isPaid/no approval, preserves fields", () => {
    const r:any = buildTransactionEditPayload(orig({status:"draft", id:"x", createdById:"y", baseAmount:1, exchangeRate:9}), baseForm);
    expect(r.ok).toBe(true); expect(r.payload).not.toHaveProperty("isPaid"); expect(r.payload).not.toHaveProperty("status");
    expect(r.payload.amount).toBe(123.456); expect(r.payload.date).toBe(baseForm.date); expect(r.payload.categoryId).toBe(baseForm.categoryId);
  });
  it.each(["draft","pending_approval","rejected","cancelled"])("paid toggle rejected in %s", (s) => {
    const r:any = buildTransactionEditPayload(orig({status:s, isPaid:false}), {...baseForm, isPaid:true});
    expect(r.ok).toBe(false); expect(r.error).toMatch(/odendi/);
  });
  it("valid pending paid toggle includes only intent", () => {
    const r:any = buildTransactionEditPayload(orig({status:"pending", isPaid:false}), {...baseForm, isPaid:true});
    expect(r.ok).toBe(true); expect(r.payload.isPaid).toBe(true); expect(r.payload).not.toHaveProperty("status");
  });
  it("approved unpaid toggle also valid via pending alias check", () => {
    const r:any = buildTransactionEditPayload(orig({status:"approved", isPaid:false}), {...baseForm, isPaid:true}); expect(r.ok).toBe(true); expect(r.payload.isPaid).toBe(true);
  });
  it("personal clears both links", () => { const r:any=buildTransactionEditPayload(orig({accountFromId:"a1",accountToId:"a2"}),{...baseForm,paymentSource:"person_out_of_pocket",payerPersonName:"Ali"}); expect(r.payload.accountFromId).toBeNull(); expect(r.payload.accountToId).toBeNull(); expect(r.payload.payerPersonName).toBe("Ali"); });
  it("company expense chosen maps From, income maps To", () => { const e:any=buildTransactionEditPayload(orig(),{...baseForm,accountId:"w1",accountCurrency:"TRY"}); expect(e.payload.accountFromId).toBe("w1"); expect(e.payload.accountToId).toBeNull(); const i:any=buildTransactionEditPayload(orig({type:"income"}),{...baseForm,accountId:"w2",accountCurrency:"TRY"}); expect(i.payload.accountToId).toBe("w2"); expect(i.payload.accountFromId).toBeNull(); });
  it("no selection never resurrects old wallet", () => { const r:any=buildTransactionEditPayload(orig({accountFromId:"old-w"}),{...baseForm,accountId:""}); expect(r.payload.accountFromId).toBeNull(); });
  it("forbidden metadata absent", () => { const r:any=buildTransactionEditPayload(orig({id:"i",createdById:"c",baseAmount:5,otoKasaTransactionId:"o",projectId:"p",createdAt:"x"}),baseForm); for(const k of ["id","createdById","baseAmount","otoKasaTransactionId","projectId","createdAt"]) expect(r.payload).not.toHaveProperty(k); });
  it("readonly linked income and transfer rejected", () => { const a:any=buildTransactionEditPayload(orig({type:"income",otoKasaTransactionId:"o1"}),baseForm); expect(a.ok).toBe(false); expect(a.readonly).toBe(true); const b:any=buildTransactionEditPayload(orig({type:"transfer"}),baseForm); expect(b.ok).toBe(false); expect(b.readonly).toBe(true); });
  it("currency mismatch rejected", () => { const r:any=buildTransactionEditPayload(orig(),{...baseForm,accountId:"w",accountCurrency:"USD"}); expect(r.ok).toBe(false); });
  it("unchanged paid toggle in approved omits isPaid (title edit)", () => { const r:any=buildTransactionEditPayload(orig({status:"approved",isPaid:false}),{...baseForm,isPaid:false,dueDate:"2024-02-01"}); expect(r.ok).toBe(true); expect(r.payload).not.toHaveProperty("isPaid"); expect(r.payload.dueDate).toBe("2024-02-01"); });
});
