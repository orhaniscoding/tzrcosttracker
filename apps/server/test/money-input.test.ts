import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
const SECRET = { jwtSecret: "test-jwt-secret-very-long-and-secure-1234", masterKey: "test-master-key-32-bytes-long-1234", blindIndexPepper: "test-pepper-for-blind-index-1234" };
const PASSWORD = "Synthetic-Pass-1234";
function auth(t: string) { return { authorization: "Bearer " + t }; }
async function balance(app: any, token: string, id: string) { const r = await app.inject({ method: "GET", url: "/api/accounts/" + id, headers: auth(token) }); expect(r.statusCode).toBe(200); return JSON.parse(r.body).balance; }
async function audits(app: any) { return (await app.auditRepo.verifyChainIntegrity(app.config.masterKey)).count; }
async function txCount(app: any, token: string) { const r = await app.inject({ method: "GET", url: "/api/transactions", headers: auth(token) }); expect(r.statusCode).toBe(200); return JSON.parse(r.body).length; }
describe("canonical money input", () => {
  let app: FastifyInstance; let token: string; let catId: string;
  beforeEach(async () => {
    app = await buildApp({ config: SECRET, dbPath: ":memory:" }); await app.ready();
    await (app as any).userRepo.createUser({ username: "money_admin", email: "money@example.test", fullName: "Money Admin", password: PASSWORD, role: "admin" }, (app as any).config.masterKey);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { usernameOrEmail: "money_admin", password: PASSWORD } });
    expect(login.statusCode).toBe(200); token = JSON.parse(login.body).token;
    const cat: any = await (app as any).categoryRepo.createCategory({ name: "MoneyCat" } as any); catId = cat.id;
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); });
  async function mkAccount(name: string, bal: number) { const r = await app.inject({ method: "POST", url: "/api/accounts", headers: auth(token), payload: { name, type: "cash", currency: "TRY", initialBalance: bal } }); expect(r.statusCode).toBe(201); return JSON.parse(r.body); }
  async function postTx(payload: any) { const r = await app.inject({ method: "POST", url: "/api/transactions", headers: auth(token), payload }); expect(r.statusCode).toBe(201); return JSON.parse(r.body).transaction; }
  it("POST canonicalizes 0.1+0.2 to exactly 0.3 in stored tx and wallet", async () => {
    const acc = await mkAccount("NoisePost", 100);
    const tx = await postTx({ type: "income", date: "2026-11-01T10:00:00.000Z", amount: 0.1 + 0.2, currency: "TRY", categoryId: catId, title: "Noise", accountToId: acc.id, isPaid: true });
    expect(tx.amount).toBe(0.3);
    const read = await app.inject({ method: "GET", url: "/api/transactions/" + tx.id, headers: auth(token) });
    expect(JSON.parse(read.body).amount).toBe(0.3);
    expect(await balance(app, token, acc.id)).toBe(100.3);
  });
  it("PUT canonicalizes 0.1+0.2 to exactly 0.3 in stored tx and wallet", async () => {
    const acc = await mkAccount("NoisePut", 1000);
    const tx = await postTx({ type: "expense", date: "2026-11-02T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "Before", accountFromId: acc.id, isPaid: true });
    expect(await balance(app, token, acc.id)).toBe(900);
    const r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { amount: 0.1 + 0.2 } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).amount).toBe(0.3);
    const read = await app.inject({ method: "GET", url: "/api/transactions/" + tx.id, headers: auth(token) });
    expect(JSON.parse(read.body).amount).toBe(0.3);
    expect(await balance(app, token, acc.id)).toBe(999.7);
  });
  it("transaction excess precision and unsafe amount 400 with no row/balance/audit change", async () => {
    const acc = await mkAccount("StrictTx", 500);
    const tx = await postTx({ type: "expense", date: "2026-11-03T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "Keep", accountFromId: acc.id, isPaid: true });
    const beforeCount = await txCount(app, token); const beforeBal = await balance(app, token, acc.id); const beforeAudit = await audits(app);
    let r = await app.inject({ method: "POST", url: "/api/transactions", headers: auth(token), payload: { type: "expense", date: "2026-11-03T11:00:00.000Z", amount: 100.005, currency: "TRY", categoryId: catId, title: "Bad", accountFromId: acc.id, isPaid: true } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: "POST", url: "/api/transactions", headers: auth(token), payload: { type: "expense", date: "2026-11-03T11:00:00.000Z", amount: 1e18, currency: "TRY", categoryId: catId, title: "Unsafe", accountFromId: acc.id, isPaid: true } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { amount: 100.005 } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { amount: 1e18 } });
    expect(r.statusCode).toBe(400);
    expect(await txCount(app, token)).toBe(beforeCount); expect(await balance(app, token, acc.id)).toBe(beforeBal); expect(await audits(app)).toBe(beforeAudit);
    const read = await app.inject({ method: "GET", url: "/api/transactions/" + tx.id, headers: auth(token) });
    expect(JSON.parse(read.body).amount).toBe(100);
    r = await app.inject({ method: "PUT", url: "/api/transactions/" + tx.id, headers: auth(token), payload: { title: "Keep Renamed" } });
    expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).amount).toBe(100);
  });
  it("account opening/credit and transfer excess precision 400 with unchanged balances/audit", async () => {
    let r = await app.inject({ method: "POST", url: "/api/accounts", headers: auth(token), payload: { name: "BadOpen", type: "cash", currency: "TRY", initialBalance: 100.005 } }); expect(r.statusCode).toBe(400);
    r = await app.inject({ method: "POST", url: "/api/accounts", headers: auth(token), payload: { name: "BadCredit", type: "credit_card", currency: "TRY", initialBalance: 0, creditLimit: 100.005 } }); expect(r.statusCode).toBe(400);
    const a1 = await mkAccount("TransferFrom", 500); const a2 = await mkAccount("TransferTo", 100);
    const beforeAudit = await audits(app);
    r = await app.inject({ method: "POST", url: "/api/accounts/transfer", headers: auth(token), payload: { fromAccountId: a1.id, toAccountId: a2.id, amount: 100.005 } }); expect(r.statusCode).toBe(400);
    expect(await balance(app, token, a1.id)).toBe(500); expect(await balance(app, token, a2.id)).toBe(100); expect(await audits(app)).toBe(beforeAudit);
  });
  it("unused account opening edit succeeds; used wallet same balance harmless, changed opening/currency 409", async () => {
    const free = await mkAccount("FreeWallet", 100);
    let r = await app.inject({ method: "PUT", url: "/api/accounts/" + free.id, headers: auth(token), payload: { initialBalance: 200 } }); expect(r.statusCode).toBe(200); expect(await balance(app, token, free.id)).toBe(200);
    r = await app.inject({ method: "PUT", url: "/api/accounts/" + free.id, headers: auth(token), payload: { name: "FreeWallet Renamed" } }); expect(r.statusCode).toBe(200); expect(await balance(app, token, free.id)).toBe(200);
    r = await app.inject({ method: "PUT", url: "/api/accounts/" + free.id, headers: auth(token), payload: { description: "no balance field" } }); expect(r.statusCode).toBe(200); expect(await balance(app, token, free.id)).toBe(200);
    const used = await mkAccount("UsedWallet", 300);
    await postTx({ type: "expense", date: "2026-11-04T10:00:00.000Z", amount: 100, currency: "TRY", categoryId: catId, title: "Spend", accountFromId: used.id, isPaid: true });
    expect(await balance(app, token, used.id)).toBe(200);
    r = await app.inject({ method: "PUT", url: "/api/accounts/" + used.id, headers: auth(token), payload: { initialBalance: 200 } }); expect(r.statusCode).toBe(200); expect(await balance(app, token, used.id)).toBe(200);
    r = await app.inject({ method: "PUT", url: "/api/accounts/" + used.id, headers: auth(token), payload: { initialBalance: 201 } }); expect(r.statusCode).toBe(409);
    r = await app.inject({ method: "PUT", url: "/api/accounts/" + used.id, headers: auth(token), payload: { currency: "USD" } }); expect(r.statusCode).toBe(409);
    expect(await balance(app, token, used.id)).toBe(200);
  });
});
