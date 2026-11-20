import * as XLSX from "xlsx";
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_DATA_ROWS = 10000;
export const MAX_SHEETS = 10;
export const MAX_COLUMNS = 100;
export const FETCH_TIMEOUT_MS = 10000;
const ERR = "Kaynak okunamad\u0131. L\u00fctfen ge\u00e7erli bir Excel dosyas\u0131 veya Google E-Tablolar ba\u011flant\u0131s\u0131 kullan\u0131n.";
const ERR_SIZE = "Kaynak boyutu 5 MiB s\u0131n\u0131r\u0131n\u0131 a\u015f\u0131yor.";
const ERR_LIMIT = "Tablo s\u0131n\u0131rlar\u0131 a\u015f\u0131l\u0131yor. En fazla 10 sayfa, 100 s\u00fctun ve 10000 veri sat\u0131r\u0131 desteklenir.";
export class ImportSourceError extends Error {
    statusCode = 400;
    constructor(m: string) { super(m); this.name = "ImportSourceError"; }
}
type FetchLike = (url: string, init: any) => Promise<any>;
function fail(m = ERR): never { throw new ImportSourceError(m); }
export function isValidSheetsId(id: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(id) && !id.includes('%'); }
function validateQuery(u: URL): void { const keys = [...u.searchParams.keys()]; const uniq = new Set(keys); if (keys.length !== uniq.size)
    fail(); for (const k of keys) {
    if (!['format', 'gid', 'tqx', 'headers', 'tq'].includes(k))
        fail();
} const f = u.searchParams.getAll('format'); if (u.pathname.endsWith('/export')) {
    if (f.length !== 1 || f[0] !== 'csv')
        fail();
    if (keys.some(k => !['format', 'gid'].includes(k)))
        fail();
    const g = u.searchParams.getAll('gid');
    if (g.length > 1 || (g.length === 1 && !/^\d+$/.test(g[0])))
        fail();
}
else {
    if (keys.some(k => !['tqx', 'headers', 'tq', 'gid'].includes(k)))
        fail();
    const t = u.searchParams.getAll('tqx');
    if (t.length > 1 || (t.length === 1 && t[0] !== 'out:csv'))
        fail();
    const h = u.searchParams.getAll('headers');
    if (h.length > 1 || (h.length === 1 && !/^\d+$/.test(h[0])))
        fail();
    const g = u.searchParams.getAll('gid');
    if (g.length > 1 || (g.length === 1 && !/^\d+$/.test(g[0])))
        fail();
} }
export function validateSheetsUrl(raw: string): string { if (typeof raw !== 'string' || !raw || raw !== raw.trim())
    fail(); if (raw.includes('\\') || /[\u0000-\u0020]/.test(raw))
    fail(); let u: URL; try {
    u = new URL(raw);
}
catch {
    fail();
} if (u.protocol !== 'https:')
    fail(); if (u.hostname !== 'docs.google.com')
    fail(); if (u.username || u.password)
    fail(); if (u.port)
    fail(); if (u.hash)
    fail(); if (raw.includes('#'))
    fail(); const enc = u.pathname; if (/%(?![0-9A-Fa-f]{2})/.test(enc))
    fail(); if (/%2f|%5c/i.test(enc))
    fail(); let dec: string; try {
    dec = decodeURIComponent(enc);
}
catch {
    fail();
} if (dec.includes('..') || dec.includes('\\'))
    fail(); const m = enc.match(/^\/spreadsheets\/d\/([^/]+)\/(export|gviz\/tq)$/); if (!m)
    fail(); if (!isValidSheetsId(m[1]))
    fail(); if (m[2] === 'gviz/tq') { /* pathname already exact */ } validateQuery(u); return u.toString(); }
export function decodeBase64Source(input: string): Buffer { if (typeof input !== 'string' || !input)
    fail(); let s = input; const m = s.match(/^data:[^;,]+;base64,/i); if (s.startsWith('data:')) {
    if (!m || !/^data:(application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel|application\/octet-stream|text\/csv);base64,/i.test(s))
        fail();
    s = s.slice(m![0].length);
} if (!s || s.length % 4 !== 0)
    fail(); if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s))
    fail(); const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0; const decodedLen = (s.length / 4) * 3 - pad; if (decodedLen > MAX_SOURCE_BYTES)
    fail(ERR_SIZE); let buf: Buffer; try {
    buf = Buffer.from(s, 'base64');
}
catch {
    fail();
} if (buf.length > MAX_SOURCE_BYTES)
    fail(ERR_SIZE); if (buf.toString('base64') !== s)
    fail(); return buf; }
function cancelBody(b: any): void { try {
    const p = b?.cancel?.();
    if (p)
        Promise.resolve(p).catch(() => { });
}
catch { } }
async function readBounded(res: any, signal: AbortSignal): Promise<Buffer> { const cl = res.headers?.get?.("content-length"); if (cl != null) {
    const n = Number(cl);
    if (!Number.isFinite(n) || n < 0) {
        cancelBody(res.body);
        fail();
    }
    if (n > MAX_SOURCE_BYTES) {
        cancelBody(res.body);
        fail(ERR_SIZE);
    }
} if (!res.body)
    fail(); let reader: any; try {
    reader = res.body.getReader();
}
catch {
    fail();
} const chunks: Uint8Array[] = []; let total = 0; try {
    for (;;) {
        if (signal.aborted)
            fail();
        const r: any = await new Promise((res2, rej) => { const onA = () => rej(new Error("aborted")); if (signal.aborted) {
            rej(new Error("aborted"));
            return;
        } signal.addEventListener("abort", onA, { once: true }); reader.read().then((v: any) => { signal.removeEventListener("abort", onA); res2(v); }, (e: any) => { signal.removeEventListener("abort", onA); rej(e); }); });
        if (r.done)
            break;
        const v = r.value as Uint8Array;
        total += v.byteLength;
        if (total > MAX_SOURCE_BYTES) {
            try {
                const cp = reader.cancel();
                if (cp)
                    Promise.resolve(cp).catch(() => { });
            }
            catch { }
            fail(ERR_SIZE);
        }
        chunks.push(v);
    }
}
catch (e) {
    try {
        const cp = reader.cancel();
        if (cp)
            Promise.resolve(cp).catch(() => { });
    }
    catch { }
    if (e instanceof ImportSourceError)
        throw e;
    fail();
}
finally {
    try {
        reader.releaseLock();
    }
    catch { }
} return Buffer.concat(chunks, total); }
export async function fetchSheetsSource(raw: string, fetchFn: FetchLike = globalThis.fetch as any, timeoutMs = FETCH_TIMEOUT_MS): Promise<Buffer> { const url = validateSheetsUrl(raw); if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10000)
    timeoutMs = FETCH_TIMEOUT_MS; const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs); try {
    let res: any;
    try {
        res = await Promise.race([fetchFn(url, { method: "GET", redirect: "manual", signal: ctrl.signal, headers: {} }), new Promise((_, rej) => { if (ctrl.signal.aborted)
                rej(new Error("aborted"));
            else
                ctrl.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }); })]);
    }
    catch {
        fail();
    }
    if (!res || res.status !== 200) {
        cancelBody(res?.body);
        fail();
    }
    const buf = await readBounded(res, ctrl.signal);
    if (ctrl.signal.aborted)
        fail();
    return buf;
}
finally {
    clearTimeout(timer);
} }
export async function resolveImportSource(input: {
    base64?: unknown;
    sheetsUrl?: unknown;
}, fetchFn?: FetchLike): Promise<Buffer> { const hasB = typeof input.base64 === 'string' && input.base64.length > 0; const hasU = typeof input.sheetsUrl === 'string' && input.sheetsUrl.length > 0; if (hasB === hasU)
    fail(); if (hasB)
    return decodeBase64Source(input.base64 as string); return fetchSheetsSource(input.sheetsUrl as string, fetchFn); }
function assertSheetRange(sheet: any): void { for (const k of ["!fullref", "!ref"]) {
    const v = sheet?.[k];
    if (v == null)
        continue;
    if (typeof v !== "string" || !v)
        fail(ERR_LIMIT);
    let r: any;
    try {
        r = XLSX.utils.decode_range(v);
    }
    catch {
        fail(ERR_LIMIT);
    }
    const s = r?.s, e = r?.e;
    for (const pt of [s, e]) {
        if (!pt || !Number.isSafeInteger(pt.c) || !Number.isSafeInteger(pt.r) || pt.c < 0 || pt.r < 0)
            fail(ERR_LIMIT);
    }
    if (s.c > e.c || s.r > e.r)
        fail(ERR_LIMIT);
    if (e.c >= MAX_COLUMNS || e.r > MAX_DATA_ROWS || e.c - s.c + 1 > MAX_COLUMNS || e.r - s.r + 1 > MAX_DATA_ROWS + 1)
        fail(ERR_LIMIT);
} }
export function readWorkbookBounded(buf: Buffer): XLSX.WorkBook { let wb: XLSX.WorkBook; try {
    wb = XLSX.read(buf, { type: "buffer", cellDates: true, sheetRows: MAX_DATA_ROWS + 2 });
}
catch {
    fail();
} if (!wb.SheetNames || wb.SheetNames.length === 0 || wb.SheetNames.length > MAX_SHEETS)
    fail(ERR_LIMIT); for (const n of wb.SheetNames) {
    const sh = wb.Sheets?.[n];
    if (!sh)
        fail(ERR_LIMIT);
    assertSheetRange(sh);
} return wb; }
export function sheetRows(wb: XLSX.WorkBook, sheetName?: string): {
    sheetName: string;
    rows: any[][];
} { const name = sheetName || wb.SheetNames[0]; const sheet = name ? wb.Sheets[name] : undefined; if (!sheet)
    throw new ImportSourceError('Se\u00e7ilen sayfa bulunamad\u0131.'); assertSheetRange(sheet); const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][]; const dataRows = Math.max(0, rows.length - 1); if (dataRows > MAX_DATA_ROWS)
    fail(ERR_LIMIT); for (const r of rows) {
    if (r && r.length > MAX_COLUMNS)
        fail(ERR_LIMIT);
} return { sheetName: name, rows }; }
export function assertWorkbookLimits(wb: XLSX.WorkBook): void { if (wb.SheetNames.length > MAX_SHEETS)
    fail(ERR_LIMIT); for (const n of wb.SheetNames) {
    sheetRows(wb, n);
} }
