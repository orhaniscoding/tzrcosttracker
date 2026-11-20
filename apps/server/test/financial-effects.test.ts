import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
const SECRET = { jwtSecret: "test-jwt-secret-very-long-and-secure-1234", masterKey: "test-master-key-32-bytes-long-1234", blindIndexPepper: "test-pepper-for-blind-index-1234" };
const PASSWORD = "Synthetic-Pass-1234";
async function buildFresh() { const app = await buildApp({ config: SECRET, dbPath: ":memory:" }); await app.ready(); return app; }
function auth(t: string) { return { authorization: "Bearer " + t }; }
function execSql(app: any, s: string) { const d: any = app.db; if (d && typeof d.run === "function") { d.run(sql.raw(s)); return; } if (d && d.$client && d.$client.exec) { d.$client.exec(s); return; } throw new Error("no sql exec"); }
async function balance(app: any, token: string, id: string) { const r = await app.inject({ method: "GET", url: "/api/accounts/" + id, headers: auth(token) }); expect(r.statusCode).toBe(200); return JSON.parse(r.body).balance; }
async function auditCount(app: any) { return (await app.auditRepo.verifyChainIntegrity(app.config.masterKey)).count; }
describe("financial effects", () => {
  let app: FastifyInstance; let token: string; let catId: string;
  beforeEach(async () => {
    app = await buildFresh();
    const u: any = await (app as any).userRepo.createUser({ username: "fin_admin", email: "fin@example.test", fullName: "Fin Admin", password: PASSWORD, role: "admin" }, (app as any).config.masterKey);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { usernameOrEmail: "fin_admin", password: PASSWORD } });
    expect(login.statusCode).toBe(200); token = JSON.parse(login.body).token;
    const cat: any = await (app as any).categoryRepo.createCategory({ name: "FinCat" } as any); catId = cat.id;
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); });
  async function mkAccount(name: string, bal: number, currency: string = "TRY") { const r = await app.inject({ method: "POST", url: "/api/accounts", headers: auth(token), payload: { name, type: "cash", currency, initialBalance: bal } }); expect(r.statusCode).toBe(201); return JSON.parse(r.body); }
  async function mkTx(payload: any, expectStatus: number = 201) { const r = await app.inject({ method: "POST", url: "/api/transactions", headers: auth(token), payload }); expect(r.statusCode).toBe(expectStatus); return r; }
  async function postTx(payload: any) { const r = await mkTx(payload); return JSON.parse(r.body).transaction; }

  it("reconciles 1000 to 900 to 800 to 1000 to 800 after restore", async () => {
    const acc = await mkAccount("Wallet A", 1000);
    const tx = await postTx({ type: "expense", date: "2026-10-01T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "Recon", accountFromId: acc.id, isPaid: true });
    expect(await balance(app, token, acc.id)).toBe(900);
    const auditBefore = await auditCount(app);
    let r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { amount: 200 } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).amount).toBe(200); expect(await balance(app, token, acc.id)).toBe(800);
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { amount: 200 } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(800);
    r = await app.inject({ method: "DELETE", url: "/api/transactions/" + tx.id, headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(1000);
    r = await app.inject({ method: "DELETE", url: "/api/transactions/" + tx.id, headers: auth(token) });
    expect(r.statusCode).toBe(404); expect(await balance(app, token, acc.id)).toBe(1000);
    r = await app.inject({ method: "POST", url: "/api/transactions/" + tx.id + "/restore", headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(800);
    const auditsAfterRestore = await auditCount(app);
    r = await app.inject({ method: "POST", url: "/api/transactions/" + tx.id + "/restore", headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(800); expect(await auditCount(app)).toBe(auditsAfterRestore);
    r = await app.inject({ method: "POST", url: "/api/transactions/" + tx.id + "/mark-paid", headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(800); expect(await auditCount(app)).toBe(auditsAfterRestore);
  });

  it("repeat mark-paid deducts once; unpaid-paid-unpaid toggles once", async () => {
    const acc = await mkAccount("Wallet B", 1000);
    const tx = await postTx({ type: "expense", date: "2026-10-02T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "Unpaid", accountFromId: acc.id, isPaid: false });
    expect(await balance(app, token, acc.id)).toBe(1000);
    let r = await app.inject({ method: "POST", url: "/api/transactions/" + tx.id + "/mark-paid", headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(900);
    r = await app.inject({ method: "POST", url: "/api/transactions/" + tx.id + "/mark-paid", headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(900);
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { isPaid: false } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).isPaid).toBe(false); expect(await balance(app, token, acc.id)).toBe(1000);
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { isPaid: true } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(900);
  });

  it("wallet switch restores old and debits new; rate-only recomputes base", async () => {
    const a1 = await mkAccount("Old Wallet", 1000); const a2 = await mkAccount("New Wallet", 500);
    const tx = await postTx({ type: "expense", date: "2026-10-03T10:00:00.000Z", amount: 100, currency: "TRY", exchangeRate: 2, categoryId: catId, title: "Switch", accountFromId: a1.id, isPaid: true });
    expect(tx.baseAmount).toBe(200); expect(await balance(app, token, a1.id)).toBe(900);
    let r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { accountFromId: a2.id } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, a1.id)).toBe(1000); expect(await balance(app, token, a2.id)).toBe(400);
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { exchangeRate: 3 } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).baseAmount).toBe(300); expect(await balance(app, token, a2.id)).toBe(400);
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { exchangeRate: 3 } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).baseAmount).toBe(300);
  });

  it("income credits once and PUT amount adjusts delta", async () => {
    const acc = await mkAccount("Income Wallet", 1000);
    const tx = await postTx({ type: "income", date: "2026-10-04T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "Income", accountToId: acc.id, isPaid: true });
    expect(await balance(app, token, acc.id)).toBe(1100);
    let r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { amount: 250 } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(1250);
    r = await app.inject({ method: "DELETE", url: "/api/transactions/" + tx.id, headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(1000);
  });

  it("personal and OTO never move wallets; mode changes create and remove pair", async () => {
    const acc = await mkAccount("Personal Wallet", 1000);
    const r0 = await mkTx({ type: "expense", date: "2026-10-05T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "Personal", accountFromId: acc.id, isPaid: true, paymentSource: "person_out_of_pocket", payerPersonName: "Ali" });
    const body0 = JSON.parse(r0.body); const tx = body0.transaction; const oto = body0.otoKasaTransaction;
    expect(oto).toBeDefined(); expect(await balance(app, token, acc.id)).toBe(1000);
    let r = await app.inject({ method: "PUT", url: "/api/transactions/" + oto.id, headers: auth(token), payload: { amount: 999 } });
    expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).error).toContain("gider");
    r = await app.inject({ method: "POST", url: "/api/transactions/" + oto.id + "/mark-paid", headers: auth(token) });
    expect(r.statusCode).toBe(409);
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { amount: 150, title: "Personal Rev" } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(1000);
    const otoAfter = await app.inject({ method: "GET", url: "/api/transactions/" + oto.id, headers: auth(token) });
    expect(otoAfter.statusCode).toBe(200); expect(JSON.parse(otoAfter.body).amount).toBe(150); expect(JSON.parse(otoAfter.body).accountToId).toBeNull();
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { paymentSource: "company_account", accountFromId: acc.id } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(850);
    const otoGone = await app.inject({ method: "GET", url: "/api/transactions/" + oto.id, headers: auth(token) });
    expect(otoGone.statusCode).toBe(404);
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { paymentSource: "person_out_of_pocket", payerPersonName: "Ali" } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(1000);
    const list = await app.inject({ method: "GET", url: "/api/transactions", headers: auth(token) });
    const rows = JSON.parse(list.body); const newOto = rows.find((x: any) => x.otoKasaTransactionId === tx.id && x.type === "income");
    expect(newOto).toBeDefined(); expect(newOto.amount).toBe(150);
    r = await app.inject({ method: "DELETE", url: "/api/transactions/" + newOto.id, headers: auth(token) });
    expect(r.statusCode).toBe(200);
    const mainAfter = await app.inject({ method: "GET", url: "/api/transactions/" + tx.id, headers: auth(token) });
    expect(mainAfter.statusCode).toBe(404); expect(await balance(app, token, acc.id)).toBe(1000);
  });

  it("draft and pending_approval have no effect; deleted mark-paid 404", async () => {
    const acc = await mkAccount("Draft Wallet", 1000);
    const d1 = await postTx({ type: "expense", date: "2026-10-06T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "Draft", accountFromId: acc.id, isPaid: true, status: "draft" });
    const d2 = await postTx({ type: "expense", date: "2026-10-06T11:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "PendingApproval", accountFromId: acc.id, isPaid: true, status: "pending_approval" });
    expect(await balance(app, token, acc.id)).toBe(1000);
    let r = await app.inject({ method: "PUT", url: "/api/transactions/" + d1.id, headers: auth(token), payload: { status: "approved" } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(900);
    r = await app.inject({ method: "DELETE", url: "/api/transactions/" + d2.id, headers: auth(token) }); expect(r.statusCode).toBe(200);
    r = await app.inject({ method: "POST", url: "/api/transactions/" + d2.id + "/mark-paid", headers: auth(token) });
    expect(r.statusCode).toBe(404); expect(await balance(app, token, acc.id)).toBe(900);
  });

  it("bad payloads rejected unchanged", async () => {
    const acc = await mkAccount("Guard Wallet", 1000);
    const bogus = "99999999-9999-9999-9999-999999999999";
    let r = await mkTx({ type: "expense", date: "2026-10-07T10:00:00.000Z", amount: 100, currency: "USD", categoryId: catId, title: "Mismatch", accountFromId: acc.id, isPaid: true }, 400);
    r = await mkTx({ type: "expense", date: "2026-10-07T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: bogus, title: "BadCat", accountFromId: acc.id, isPaid: true }, 400);
    r = await mkTx({ type: "expense", date: "2026-10-07T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "BadAcc", accountFromId: bogus, isPaid: true }, 400);
    r = await mkTx({ type: "expense", date: "2026-10-07T10:00:00.000Z", amount: -5, currency: "TRY", categoryId: catId, title: "Neg", accountFromId: acc.id }, 400);
    r = await mkTx({ type: "expense", date: "2026-10-07T10:00:00.000Z", amount: "100", currency: "TRY", categoryId: catId, title: "StrAmt", accountFromId: acc.id }, 400);
    const audits0 = await auditCount(app);
    expect(await balance(app, token, acc.id)).toBe(1000);
    const tx = await postTx({ type: "expense", date: "2026-10-07T12:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "Keep", accountFromId: acc.id, isPaid: true });
    expect(await balance(app, token, acc.id)).toBe(900); const audits1 = await auditCount(app);
    const badBodies: any[] = [{ id: tx.id }, { createdById: tx.createdById }, { otoKasaTransactionId: null }, { amount: -1 }, { amount: "x" }, { unknownField: 1 }, { accountFromId: bogus }, { categoryId: bogus }, { paymentSource: "person_out_of_pocket" }];
    for (const b of badBodies) { const rr = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: b }); expect(rr.statusCode).toBe(400); }
    expect(await balance(app, token, acc.id)).toBe(900); expect(await auditCount(app)).toBe(audits1);
    const chk = await app.inject({ method: "GET", url: "/api/transactions/" + tx.id, headers: auth(token) });
    expect(JSON.parse(chk.body).amount).toBe(100);
    void audits0;
  });

  it("permanent delete variants reverse exactly once", async () => {
    const acc = await mkAccount("Perm Wallet", 1000);
    const tx1 = await postTx({ type: "expense", date: "2026-10-08T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "PermLive", accountFromId: acc.id, isPaid: true });
    expect(await balance(app, token, acc.id)).toBe(900);
    let r = await app.inject({ method: "DELETE", url: "/api/transactions/" + tx1.id + "/permanent", headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(1000);
    const tx2 = await postTx({ type: "expense", date: "2026-10-08T11:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "PermTrash", accountFromId: acc.id, isPaid: true });
    expect(await balance(app, token, acc.id)).toBe(900);
    r = await app.inject({ method: "DELETE", url: "/api/transactions/" + tx2.id, headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(1000);
    r = await app.inject({ method: "DELETE", url: "/api/transactions/" + tx2.id + "?permanent=true", headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(1000);
    const g = await app.inject({ method: "GET", url: "/api/transactions/" + tx2.id, headers: auth(token) }); expect(g.statusCode).toBe(404);
    const tx3 = await postTx({ type: "expense", date: "2026-10-08T12:00:00.000Z", amount: 50, currency: "TRY", categoryId: catId, title: "PermQueryLive", accountFromId: acc.id, isPaid: true });
    expect(await balance(app, token, acc.id)).toBe(950);
    r = await app.inject({ method: "DELETE", url: "/api/transactions/" + tx3.id + "?permanent=true", headers: auth(token) });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, acc.id)).toBe(1000);
  });

  it("concurrent paid expenses lose no updates", async () => {
    const acc = await mkAccount("Conc Wallet", 1000);
    const payload = function(n: number) { return { type: "expense", date: "2026-10-09T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "Conc" + n, accountFromId: acc.id, isPaid: true }; };
    const results = await Promise.all([app.inject({ method: "POST", url: "/api/transactions", headers: auth(token), payload: payload(1) }), app.inject({ method: "POST", url: "/api/transactions", headers: auth(token), payload: payload(2) })]);
    expect(results[0].statusCode).toBe(201); expect(results[1].statusCode).toBe(201);
    expect(await balance(app, token, acc.id)).toBe(800);
  });

  it("wallet and audit trigger rollback", async () => {
    const acc = await mkAccount("Rollback Wallet", 1000);
    const countTx = async function() { const r = await app.inject({ method: "GET", url: "/api/transactions", headers: auth(token) }); return JSON.parse(r.body).length; };
    const beforeTx = await countTx(); const beforeAudit = await auditCount(app);
    execSql(app, "CREATE TRIGGER fail_wallet BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT, char(102,97,105,108)); END");
    let r = await mkTx({ type: "expense", date: "2026-10-10T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "FailWallet", accountFromId: acc.id, isPaid: true }, 500);
    expect(await countTx()).toBe(beforeTx); expect(await auditCount(app)).toBe(beforeAudit);
    execSql(app, "DROP TRIGGER fail_wallet");
    expect(await balance(app, token, acc.id)).toBe(1000);
    execSql(app, "CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, char(102,97,105,108)); END");
    r = await mkTx({ type: "expense", date: "2026-10-10T11:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "FailAudit", accountFromId: acc.id, isPaid: true }, 500);
    execSql(app, "DROP TRIGGER fail_audit");
    expect(await countTx()).toBe(beforeTx); expect(await balance(app, token, acc.id)).toBe(1000); expect(await auditCount(app)).toBe(beforeAudit);
    const tx = await postTx({ type: "expense", date: "2026-10-10T12:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "UpdateFail", accountFromId: acc.id, isPaid: true });
    expect(await balance(app, token, acc.id)).toBe(900);
    execSql(app, "CREATE TRIGGER fail_wallet2 BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT, char(102,97,105,108)); END");
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { amount: 200 } });
    expect(r.statusCode).toBe(500); execSql(app, "DROP TRIGGER fail_wallet2");
    const chk = await app.inject({ method: "GET", url: "/api/transactions/" + tx.id, headers: auth(token) });
    expect(JSON.parse(chk.body).amount).toBe(100); expect(await balance(app, token, acc.id)).toBe(900);
  });
  it("transfer validates and audit rollback", async () => {
    const a1 = await mkAccount("From Wallet", 1000); const a2 = await mkAccount("To Wallet", 0); const usd = await mkAccount("Usd Wallet", 0, "USD");
    let r = await app.inject({ method: "POST", url: "/api/accounts/transfer", headers: auth(token), payload: { fromAccountId: a1.id, toAccountId: a1.id, amount: 10 } }); expect(r.statusCode).toBe(400);
    r = await app.inject({ method: "POST", url: "/api/accounts/transfer", headers: auth(token), payload: { fromAccountId: a1.id, toAccountId: usd.id, amount: 10 } }); expect(r.statusCode).toBe(400);
    r = await app.inject({ method: "POST", url: "/api/accounts/transfer", headers: auth(token), payload: { fromAccountId: a1.id, toAccountId: usd.id, amount: 10, exchangeRate: 30 } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, a1.id)).toBe(990); expect(await balance(app, token, usd.id)).toBe(300);
    const audits0 = await auditCount(app);
    execSql(app, "CREATE TRIGGER fail_tgt BEFORE UPDATE OF balance_encrypted ON accounts BEGIN SELECT RAISE(ABORT, char(102,97,105,108)); END");
    r = await app.inject({ method: "POST", url: "/api/accounts/transfer", headers: auth(token), payload: { fromAccountId: a1.id, toAccountId: a2.id, amount: 100, exchangeRate: 1 } });
    expect(r.statusCode).toBe(500); execSql(app, "DROP TRIGGER fail_tgt");
    expect(await balance(app, token, a1.id)).toBe(990); expect(await balance(app, token, a2.id)).toBe(0);
    execSql(app, "CREATE TRIGGER fail_audit2 BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, char(102,97,105,108)); END");
    r = await app.inject({ method: "POST", url: "/api/accounts/transfer", headers: auth(token), payload: { fromAccountId: a1.id, toAccountId: a2.id, amount: 100, exchangeRate: 1 } });
    expect(r.statusCode).toBe(500); execSql(app, "DROP TRIGGER fail_audit2");
    expect(await balance(app, token, a1.id)).toBe(990); expect(await balance(app, token, a2.id)).toBe(0); expect(await auditCount(app)).toBe(audits0);
    r = await app.inject({ method: "POST", url: "/api/accounts/transfer", headers: auth(token), payload: { fromAccountId: a1.id, toAccountId: a2.id, amount: 100 } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, a1.id)).toBe(890); expect(await balance(app, token, a2.id)).toBe(100);
  });
  it("account guards: referenced delete and currency and initialBalance", async () => {
    const acc = await mkAccount("Guarded", 1000);
    const tx = await postTx({ type: "expense", date: "2026-10-11T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "RefTx", accountFromId: acc.id, isPaid: true });
    expect(await balance(app, token, acc.id)).toBe(900);
    let r = await app.inject({ method: "DELETE", url: "/api/accounts/" + acc.id, headers: auth(token) }); expect(r.statusCode).toBe(409);
    r = await app.inject({ method: "PUT", url: "/api/accounts/" + acc.id, headers: auth(token), payload: { currency: "USD" } }); expect(r.statusCode).toBe(409);
    r = await app.inject({ method: "PUT", url: "/api/accounts/" + acc.id, headers: auth(token), payload: { initialBalance: 5000 } }); expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).error).toContain("virman");
    r = await app.inject({ method: "PUT", url: "/api/accounts/" + acc.id, headers: auth(token), payload: { name: "Guarded Renamed" } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).name).toBe("Guarded Renamed"); expect(JSON.parse(r.body).balance).toBe(900);
    const free = await mkAccount("Free Wallet", 100);
    r = await app.inject({ method: "PUT", url: "/api/accounts/" + free.id, headers: auth(token), payload: { currency: "USD" } }); expect(r.statusCode).toBe(200);
    r = await app.inject({ method: "DELETE", url: "/api/accounts/" + free.id, headers: auth(token) }); expect(r.statusCode).toBe(200);
    const audits0 = await auditCount(app);
    execSql(app, "CREATE TRIGGER fail_audit3 BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, char(102,97,105,108)); END");
    r = await app.inject({ method: "POST", url: "/api/accounts", headers: auth(token), payload: { name: "NoAudit", type: "cash", currency: "TRY", initialBalance: 5 } });
    expect(r.statusCode).toBe(500); execSql(app, "DROP TRIGGER fail_audit3");
    const list = await app.inject({ method: "GET", url: "/api/accounts", headers: auth(token) });
    expect(JSON.parse(list.body).some((a: any) => a.name === "NoAudit")).toBe(false); expect(await auditCount(app)).toBe(audits0);
  });
  it('amount and rate together recompute base with and without status and OTO sync', async () => {
    const acc = await mkAccount('Base Wallet', 1000);
    const tx = await postTx({ type: 'expense', date: '2026-10-12T10:00:00.000Z', amount: 100, exchangeRate: 1, currency: 'TRY', categoryId: catId, title: 'BaseTx', accountFromId: acc.id, isPaid: true });
    expect(tx.baseAmount).toBe(100); expect(await balance(app, token, acc.id)).toBe(900);
    let r = await app.inject({ method: 'PUT', url: '/api/transactions/' + tx.id, headers: auth(token), payload: { amount: 200, exchangeRate: 2 } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).amount).toBe(200); expect(JSON.parse(r.body).exchangeRate).toBe(2); expect(JSON.parse(r.body).baseAmount).toBe(400); expect(await balance(app, token, acc.id)).toBe(800);
    r = await app.inject({ method: 'PUT', url: '/api/transactions/' + tx.id, headers: auth(token), payload: { amount: 200, exchangeRate: 3, status: 'approved' } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).baseAmount).toBe(600);
    r = await app.inject({ method: 'PUT', url: '/api/transactions/' + tx.id, headers: auth(token), payload: { exchangeRate: 4 } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).baseAmount).toBe(800);
    const p0 = await mkTx({ type: 'expense', date: '2026-10-12T11:00:00.000Z', amount: 100, exchangeRate: 1, currency: 'TRY', categoryId: catId, title: 'OtoBase', accountFromId: acc.id, isPaid: true, paymentSource: 'person_out_of_pocket', payerPersonName: 'Ali' });
    const pb = JSON.parse(p0.body); const mainTx = pb.transaction; const oto = pb.otoKasaTransaction; expect(oto.baseAmount).toBe(100);
    r = await app.inject({ method: 'PUT', url: '/api/transactions/' + mainTx.id, headers: auth(token), payload: { amount: 200, exchangeRate: 2 } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).baseAmount).toBe(400);
    const otoGet = await app.inject({ method: 'GET', url: '/api/transactions/' + oto.id, headers: auth(token) });
    expect(otoGet.statusCode).toBe(200); expect(JSON.parse(otoGet.body).amount).toBe(200); expect(JSON.parse(otoGet.body).exchangeRate).toBe(2); expect(JSON.parse(otoGet.body).baseAmount).toBe(400);
  });
  it('same-currency rate rejected and transfer locks account fields and delete', async () => {
    const a1 = await mkAccount('Lock From', 1000); const a2 = await mkAccount('Lock To', 1000);
    let r = await app.inject({ method: 'POST', url: '/api/accounts/transfer', headers: auth(token), payload: { fromAccountId: a1.id, toAccountId: a2.id, amount: 100, exchangeRate: 2 } });
    expect(r.statusCode).toBe(400); expect(await balance(app, token, a1.id)).toBe(1000); expect(await balance(app, token, a2.id)).toBe(1000);
    r = await app.inject({ method: 'POST', url: '/api/accounts/transfer', headers: auth(token), payload: { fromAccountId: a1.id, toAccountId: a2.id, amount: 100 } });
    expect(r.statusCode).toBe(200); expect(await balance(app, token, a1.id)).toBe(900); expect(await balance(app, token, a2.id)).toBe(1100);
    r = await app.inject({ method: 'PUT', url: '/api/accounts/' + a1.id, headers: auth(token), payload: { currency: 'USD' } }); expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).error).toContain('virman');
    r = await app.inject({ method: 'PUT', url: '/api/accounts/' + a2.id, headers: auth(token), payload: { currency: 'USD' } }); expect(r.statusCode).toBe(409);
    r = await app.inject({ method: 'PUT', url: '/api/accounts/' + a1.id, headers: auth(token), payload: { initialBalance: 5000 } }); expect(r.statusCode).toBe(409); expect(JSON.parse(r.body).error).toContain('virman');
    r = await app.inject({ method: 'PUT', url: '/api/accounts/' + a1.id, headers: auth(token), payload: { currency: 'TRY' } }); expect(r.statusCode).toBe(200);
    r = await app.inject({ method: 'PUT', url: '/api/accounts/' + a1.id, headers: auth(token), payload: { initialBalance: 900 } }); expect(r.statusCode).toBe(200); expect(await balance(app, token, a1.id)).toBe(900);
    r = await app.inject({ method: 'PUT', url: '/api/accounts/' + a1.id, headers: auth(token), payload: { name: 'Lock From Renamed' } }); expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).balance).toBe(900);
    r = await app.inject({ method: 'DELETE', url: '/api/accounts/' + a1.id, headers: auth(token) }); expect(r.statusCode).toBe(409);
    r = await app.inject({ method: 'DELETE', url: '/api/accounts/' + a2.id, headers: auth(token) }); expect(r.statusCode).toBe(409);
    expect(await balance(app, token, a1.id)).toBe(900); expect(await balance(app, token, a2.id)).toBe(1100);
  });
});

