import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as XLSX from "xlsx";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { decodeBase64Source, resolveImportSource, fetchSheetsSource, validateSheetsUrl, readWorkbookBounded, sheetRows, MAX_SOURCE_BYTES } from "../src/import-source.js";
const AMP = String.fromCharCode(38);
const ID = "abcDEF123_-".padEnd(20, "x");
const CSV_URL = "https://docs.google.com/spreadsheets/d/" + ID + "/export?format=csv" + AMP + "gid=0";
function wbB64(rows) { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "S0"); return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })).toString("base64"); }
function stream(chunks) { return new ReadableStream({ start(c) { for (const ch of chunks)
        c.enqueue(ch); c.close(); } }); }
function resp(status, chunks = [], headers = {}) { return { status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, body: stream(chunks) }; }
function enc(s) { return new TextEncoder().encode(s); }
describe("import-source helper", () => {
    it("valid base64 and data URI", () => { const b = decodeBase64Source(wbB64([["h"], ["v"]])); expect(b.length).toBeGreaterThan(0); const b2 = decodeBase64Source("data:application/octet-stream;base64," + wbB64([["h"], ["v"]])); expect(b2.length).toBe(b.length); });
    it("both and none rejected", async () => { await expect(resolveImportSource({ base64: wbB64([["h"], ["v"]]), sheetsUrl: CSV_URL })).rejects.toThrowError(); await expect(resolveImportSource({})).rejects.toThrowError(); await expect(resolveImportSource({ base64: "", sheetsUrl: "" })).rejects.toThrowError(); });
    it("invalid base64", () => { for (const s of ["!!!", "abc", "aGV sbG8=", "aGVsbG8*", "data:text/html;base64,aGVsbG8=", "data:;base64,aGVsbG8="])
        expect(() => decodeBase64Source(s)).toThrowError(); });
    it("decoded oversize before parse", () => { const s = Buffer.alloc(MAX_SOURCE_BYTES + 1, 65).toString("base64"); expect(() => decodeBase64Source(s)).toThrowError(/5 MiB/); });
    it("valid Google CSV and gviz", () => { expect(validateSheetsUrl(CSV_URL)).toContain("docs.google.com"); expect(validateSheetsUrl("https://docs.google.com/spreadsheets/d/" + ID + "/gviz/tq?tqx=out:csv")).toContain("gviz"); expect(validateSheetsUrl("https://docs.google.com/spreadsheets/d/" + ID + "/export?format=csv")).toContain("export"); });
    it("bad URLs rejected before fetch", async () => { const f = vi.fn(async () => resp(200, [enc("x")])); const bad = ["http://docs.google.com/spreadsheets/d/" + ID + "/export?format=csv", "https://docs.google.com.evil.com/spreadsheets/d/" + ID + "/export?format=csv", "https://user:pass@docs.google.com/spreadsheets/d/" + ID + "/export?format=csv", "https://127.0.0.1/spreadsheets/d/" + ID + "/export?format=csv", "https://docs.google.com/spreadsheets/d/" + ID + "/export?format=csv#frag", "https://docs.google.com:8443/spreadsheets/d/" + ID + "/export?format=csv", "https://docs.google.com/spreadsheets/d/" + ID + "%2f..%2fexport?format=csv", "https://docs.google.com/spreadsheets/d/" + ID + "/export?format=xlsx", "https://docs.google.com/spreadsheets/d/" + ID + "/export?format=csv" + AMP + "foo=1", "https://docs.google.com/spreadsheets/d/" + ID + "/export?format=csv" + AMP + "format=csv", "https://docs.google.com/spreadsheets/d/../" + ID + "/export?format=csv"]; for (const u of bad) {
        await expect(fetchSheetsSource(u, f)).rejects.toThrowError();
        expect(f).not.toHaveBeenCalled();
    } });
    it("fetch 200 CSV, manual redirect, timeout signal", async () => { const f = vi.fn(async (u, init) => { expect(init.redirect).toBe("manual"); expect(init.signal).toBeInstanceOf(AbortSignal); expect(init.credentials).toBeUndefined(); return resp(200, [enc("a,b")]); }); const b = await fetchSheetsSource(CSV_URL, f); expect(b.toString()).toBe("a,b"); expect(f).toHaveBeenCalledTimes(1); });
    it("redirect rejected no second fetch", async () => { const f = vi.fn(async () => resp(302, [], { location: "https://evil.example/x" })); await expect(fetchSheetsSource(CSV_URL, f)).rejects.toThrowError(); expect(f).toHaveBeenCalledTimes(1); });
    it("non-200 rejected", async () => { for (const s of [301, 403, 404, 500]) {
        const f = vi.fn(async () => resp(s, [enc("secret-body")]));
        await expect(fetchSheetsSource(CSV_URL, f)).rejects.not.toThrowError(/secret-body/);
    } });
    it("declared overflow", async () => { const f = vi.fn(async () => resp(200, [enc("x")], { "content-length": String(MAX_SOURCE_BYTES + 1) })); await expect(fetchSheetsSource(CSV_URL, f)).rejects.toThrowError(/5 MiB/); });
    it("streamed overflow cancels", async () => { let cancelled = false; const body = new ReadableStream({ start(c) { c.enqueue(enc("x".repeat(100))); c.enqueue(new Uint8Array(MAX_SOURCE_BYTES)); }, cancel() { cancelled = true; } }); const f = vi.fn(async () => ({ status: 200, headers: { get: () => null }, body })); await expect(fetchSheetsSource(CSV_URL, f)).rejects.toThrowError(/5 MiB/); expect(cancelled).toBe(true); });
    it("wb limits rows sheets cols", () => { const ok = readWorkbookBounded(Buffer.from(wbB64([["a", "b"], ["1", "2"]]), "base64")); expect(sheetRows(ok).rows.length).toBe(2); const many = [Array.from({ length: 101 }, (_, i) => "h" + i)]; expect(() => sheetRows(readWorkbookBounded(Buffer.from(wbB64(many), "base64")))).toThrowError(); const rows = [["h"]]; for (let i = 0; i < 10001; i++)
        rows.push(["v" + i]); expect(() => sheetRows(readWorkbookBounded(Buffer.from(wbB64(rows), "base64")))).toThrowError(); });
    it("huge sparse ref rejected before conversion", () => { const spy = vi.spyOn(XLSX.utils, "sheet_to_json").mockReturnValue([["h"]]); const mk = (ref, full) => ({ SheetNames: ["S"], Sheets: { S: { "!ref": ref, ...(full ? { "!fullref": full } : {}), A1: { v: "h", t: "s" } } } }); expect(() => sheetRows(mk("A1:XFD1048576"))).toThrowError(); expect(() => sheetRows(mk("A1:A2", "A1:XFD1048576"))).toThrowError(); expect(() => sheetRows(mk("B2:A1"))).toThrowError(); expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); });
    it("range max boundary and max+1 before conversion", () => { const spy = vi.spyOn(XLSX.utils, "sheet_to_json").mockReturnValue([["h"], ["v"]]); const mk = (ref, full) => ({ SheetNames: ["S"], Sheets: { S: { "!ref": ref, ...(full ? { "!fullref": full } : {}), A1: { v: "h", t: "s" } } } }); expect(sheetRows(mk("A1:CV10001")).rows.length).toBe(2); expect(spy).toHaveBeenCalledTimes(1); spy.mockClear(); expect(() => sheetRows(mk("A1:CV10002"))).toThrowError(); expect(() => sheetRows(mk("A1:CW10001"))).toThrowError(); expect(() => sheetRows(mk("A1:A10001", "A1:A10002"))).toThrowError(); expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); });
});
it("rejected and declared-overflow bodies canceled", async () => { for (const st of [302, 403, 500]) {
    let cd = false;
    const body = { cancel() { cd = true; } };
    const f = vi.fn(async () => ({ status: st, headers: { get: () => null }, body }));
    await expect(fetchSheetsSource(CSV_URL, f)).rejects.toThrowError();
    expect(cd).toBe(true);
} let cd2 = false; const body2 = { cancel() { cd2 = true; } }; const f2 = vi.fn(async () => ({ status: 200, headers: { get: (k) => k === "content-length" ? String(MAX_SOURCE_BYTES + 1) : null }, body: body2 })); await expect(fetchSheetsSource(CSV_URL, f2)).rejects.toThrowError(/5 MiB/); expect(cd2).toBe(true); });
it("timeout during stream after headers cancels", async () => { let cd = false; const reader = { read: () => new Promise(() => { }), cancel() { cd = true; return Promise.resolve(); }, releaseLock() { } }; const body = { getReader: () => reader }; const f = vi.fn(async () => ({ status: 200, headers: { get: () => null }, body })); await expect(fetchSheetsSource(CSV_URL, f, 25)).rejects.toThrowError(); expect(cd).toBe(true); });
it("timeout does not hang on nonresolving cancel", async () => { const reader = { read: () => new Promise(() => { }), cancel: () => new Promise(() => { }), releaseLock() { } }; const body = { getReader: () => reader }; const f = vi.fn(async () => ({ status: 200, headers: { get: () => null }, body })); const t0 = Date.now(); await expect(fetchSheetsSource(CSV_URL, f, 25)).rejects.toThrowError(); expect(Date.now() - t0).toBeLessThan(2000); });
it("sparse incomplete metadata no conversion", () => { const spy = vi.spyOn(XLSX.utils, "sheet_to_json").mockReturnValue([["h"]]); const mk = (o) => ({ SheetNames: ["S"], Sheets: { S: o } }); expect(() => sheetRows(mk({ "!fullref": "A1:XFD1048576" }))).toThrowError(); expect(() => sheetRows(mk({ "!ref": "A1:CW1" }))).toThrowError(); expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); });
it("real xlsx max and max+1 rows", () => { const mk = (n) => { const r = [["h"]]; for (let i = 0; i < n; i++)
    r.push(["v" + i]); return readWorkbookBounded(Buffer.from(wbB64(r), "base64")); }; expect(sheetRows(mk(10000)).rows.length).toBe(10001); expect(() => sheetRows(mk(10001))).toThrowError(); });
describe("import routes", () => {
    let app;
    let token;
    beforeEach(async () => { app = await buildApp({ config: { jwtSecret: "test-jwt-secret-very-long-and-secure-1234", masterKey: "test-master-key-32-bytes-long-1234", blindIndexPepper: "test-pepper-for-blind-index-1234" }, dbPath: ":memory:" }); await app.ready(); await app.userRepo.createUser({ username: "imp_admin", email: "imp@example.test", fullName: "Synthetic", password: "Synthetic-Pass-1234", role: "admin" }, app.config.masterKey); const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { usernameOrEmail: "imp_admin", password: "Synthetic-Pass-1234" } }); token = JSON.parse(r.body).token; });
    afterEach(async () => { await app.close(); });
    const H = () => ({ authorization: "Bearer " + token });
    it("analyze+execute reject both/none/invalid/oversize and no tx", async () => { const cases = [{ base64: wbB64([["h"], ["v"]]), sheetsUrl: CSV_URL }, {}, { base64: "!!!" }, { base64: Buffer.alloc(MAX_SOURCE_BYTES + 1, 65).toString("base64") }]; for (const c of cases) {
        const a = await app.inject({ method: "POST", url: "/api/import/analyze", headers: H(), payload: c });
        expect(a.statusCode).toBe(400);
        const counts = (await app.transactionRepo.listTransactions({}, app.config.masterKey, app.config.blindIndexPepper)).length;
        const e = await app.inject({ method: "POST", url: "/api/import/execute", headers: H(), payload: { ...c, mapping: { dateCol: 0, titleCol: 0, amountCol: 0 } } });
        expect(e.statusCode).toBe(400);
        expect((await app.transactionRepo.listTransactions({}, app.config.masterKey, app.config.blindIndexPepper)).length).toBe(counts);
    } });
    it("analyze valid synthetic xlsx", async () => { const r = await app.inject({ method: "POST", url: "/api/import/analyze", headers: H(), payload: { base64: wbB64([["Tarih", "Baslik", "Tutar"], ["2026-01-01", "Kalem", "10"]]) } }); expect(r.statusCode).toBe(200); expect(JSON.parse(r.body).success).toBe(true); });
    it("analyze rejects too many rows", async () => { const rows = [["h"]]; for (let i = 0; i < 10001; i++)
        rows.push(["v"]); const r = await app.inject({ method: "POST", url: "/api/import/analyze", headers: H(), payload: { base64: wbB64(rows) } }); expect(r.statusCode).toBe(400); });
    it("bad sheetsUrl rejected", async () => { const r = await app.inject({ method: "POST", url: "/api/import/analyze", headers: H(), payload: { sheetsUrl: "https://docs.google.com.evil.com/spreadsheets/d/" + ID + "/export?format=csv" } }); expect(r.statusCode).toBe(400); });
    it("legacy 403 no writes", async () => { const before = (await app.projectRepo.listProjects()).length; const r = await app.inject({ method: "POST", url: "/api/import/karaelmas", headers: H(), payload: {} }); expect(r.statusCode).toBe(403); expect(JSON.parse(r.body).error).toContain("dosya"); expect((await app.projectRepo.listProjects()).length).toBe(before); expect((await app.transactionRepo.listTransactions({}, app.config.masterKey, app.config.blindIndexPepper)).length).toBe(0); });
});
