import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { AccountRepository, AuditLogRepository, accounts, categories, TransactionRepository, type CostCoreDatabase } from '@cost-core/database';
import { eq } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { convertPositiveLedgerAmount, LedgerConversionError, normalizeLedgerCurrency, z } from '@cost-core/types';
import { resolveImportSource, readWorkbookBounded, assertWorkbookLimits, sheetRows, ImportSourceError } from '../import-source.js';
import { ForbiddenError, NotFoundError, SessionInvalidError, isValidPathId } from '../services/project-access.service.js';
import { parseImportAmount, parseImportCurrency, parseImportDate, parseImportExchangeRate, parseImportPaid, SpreadsheetImportValueError } from '../services/spreadsheet-import-rules.js';
import { effectOf, snapshot } from '../financial-effects.js';

class ImportValidationError extends Error {
  constructor(message = 'Geçersiz içe aktarma parametreleri.') { super(message); }
}
type ImportTx = Parameters<Parameters<CostCoreDatabase['transaction']>[0]>[0];

function importSheetRows(workbook: XLSX.WorkBook, sheetName?: string) {
  const result = sheetRows(workbook, sheetName);
  const ref = workbook.Sheets[result.sheetName]['!ref'];
  let firstRow = ref ? XLSX.utils.decode_range(ref).s.r : 0;
  let start = 0;
  while (start < result.rows.length && (!result.rows[start] || result.rows[start].every(value => value === null || value === undefined || (typeof value === 'string' && !value.trim())))) start++;
  firstRow += start;
  return { rows: result.rows.slice(start), firstRow };
}

function importSheetDigest(rows: unknown[][], firstRow: number): string {
  return createHash('sha256').update(JSON.stringify([firstRow, rows])).digest('hex');
}

const AnalyzeSchema = z.object({
  base64: z.string().optional(),
  sheetsUrl: z.string().optional(),
});

const ExecuteImportSchema = z.object({
  base64: z.string().optional(),
  sheetsUrl: z.string().optional(),
  sheetName: z.string().optional(),
  sheetDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  projectId: z.string().refine(isValidPathId),
  mapping: z.object({
    dateCol: z.number().int().min(0),
    titleCol: z.number().int().min(0),
    amountCol: z.number().int().min(0),
    categoryCol: z.number().int().min(0).optional(),
    subCategoryCol: z.number().int().min(0).optional(),
    partyCol: z.number().int().min(0).optional(),
    isPaidCol: z.number().int().min(0).optional(),
    payerPersonCol: z.number().int().min(0).optional(),
    currencyCol: z.number().int().min(0).optional(),
    exchangeRateCol: z.number().int().min(0).optional(),
    accountFromCol: z.number().int().min(0).optional(),
  }),
});

export const importRoutes: FastifyPluginAsync = async (fastify) => {
  const { projectRepo, projectAccess, config } = fastify;
  const db = fastify.db as CostCoreDatabase;

  function freshAdmin(tx: ImportTx, request: any) {
    const session = request.authSession;
    projectAccess.requireFreshAdmin(tx, request.user?.id, session?.id, session ? Number(session.expiresAt) : NaN);
  }
  function targetInTx(tx: ImportTx, projectId: string) {
    const project = projectRepo.getProjectByIdInTx(tx, projectId);
    if (!project) throw new NotFoundError();
    return project;
  }
  function importError(reply: any, error: unknown) {
    if (error instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
    if (error instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
    if (error instanceof NotFoundError) return reply.status(404).send({ error: 'Bulunamadı.' });
    if (error instanceof ImportValidationError) return reply.status(400).send({ error: error.message });
    return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
  }

  // 1. EXCEL VEYA GOOGLE E-TABLOLAR DOSYASINI ANALİZ ET
  fastify.post('/analyze', { onRequest: [fastify.authenticate], bodyLimit: 8388608 }, async (request, reply) => {
    try {
    db.transaction(tx => { freshAdmin(tx, request); });
    const parse = AnalyzeSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Geçersiz parametre', details: parse.error.format() });
    }

    const { base64, sheetsUrl } = parse.data;
    let workbook: XLSX.WorkBook;
    let buf: Buffer;
    try { buf = await resolveImportSource({ base64, sheetsUrl }); } catch (e:unknown) { const s=e instanceof ImportSourceError?e.statusCode:400; return reply.status(s).send({ error: e instanceof ImportSourceError?e.message:'Kaynak okunamad\u0131.' }); }
    // The source await never holds a database transaction or grants stale access.
    db.transaction(tx => { freshAdmin(tx, request); });
    let sheetSummaries;
    try {
    workbook = readWorkbookBounded(buf); assertWorkbookLimits(workbook);

    sheetSummaries = workbook.SheetNames.map((name) => {
      const { rows, firstRow } = importSheetRows(workbook, name);
      const headers = rows.length > 0 ? rows[0].map(String) : [];
      const preview = rows.slice(1, 6); // İlk 5 örnek satır

      return {
        sheetName: name,
        sheetDigest: importSheetDigest(rows, firstRow),
        headers,
        totalRows: Math.max(0, rows.length - 1),
        preview,
      };
    });
    } catch (e:unknown) { const s=e instanceof ImportSourceError?e.statusCode:400; return reply.status(s).send({ error: e instanceof ImportSourceError?e.message:'Kaynak okunamad\u0131.' }); }

    return reply.send({
      success: true,
      sheets: sheetSummaries,
    });
    } catch (error) { return importError(reply, error); }
  });

  // 2. EVRENSEL EŞLEŞTİRİLMİŞ İÇE AKTARMA (UNIVERSAL SMART IMPORT)
  fastify.post('/execute', { onRequest: [fastify.authenticate], bodyLimit: 8388608 }, async (request, reply) => {
    try {
    const authUser = request.user as { id: string };
    const input = db.transaction(tx => {
      freshAdmin(tx, request);
      const parse = ExecuteImportSchema.safeParse(request.body);
      if (!parse.success) throw new ImportValidationError();
      targetInTx(tx, parse.data.projectId);
      return parse.data;
    });

    const { base64, sheetsUrl, sheetName, sheetDigest, projectId, mapping } = input;
    let workbook: XLSX.WorkBook;
    let rows: any[][];
    let firstRow = 0;
    try { const buf = await resolveImportSource({ base64, sheetsUrl }); workbook = readWorkbookBounded(buf); assertWorkbookLimits(workbook); const r = importSheetRows(workbook, sheetName); rows = r.rows; firstRow = r.firstRow; } catch (e:unknown) { const st=e instanceof ImportSourceError?e.statusCode:400; return reply.status(st).send({ error: e instanceof ImportSourceError?e.message:'Kaynak okunamad\u0131.' }); }
    // One synchronous write transaction owns final authorization, target and ALL
    // categories, transactions, balances, and audit records.
    const result = db.transaction(tx => {
    freshAdmin(tx, request);
    const targetProject = targetInTx(tx, projectId);
    if (sheetDigest && sheetDigest !== importSheetDigest(rows, firstRow)) {
      return null;
    }
    if (rows.length < 2) throw new ImportValidationError('Tabloda aktarılacak veri satırı bulunamadı.');
    const transactionRepo = new TransactionRepository(tx as unknown as CostCoreDatabase);

    // Kategorileri önbelleğe al
    const existingCats = tx.select().from(categories).all();
    const catMap = new Map<string, string>();
    for (const c of existingCats) {
      catMap.set(c.name.toLowerCase().trim(), c.id);
    }

    function getOrCreateCat(name: string, parentId?: string): string {
      const key = (parentId ? `${parentId}_` : '') + name.toLowerCase().trim();
      if (catMap.has(key)) return catMap.get(key)!;

      // CategoryRepository is async; mirror its defaults with typed synchronous
      // Drizzle operations so no Promise can escape the enclosing transaction.
      const now = new Date().toISOString();
      const created = {
        id: randomUUID(), name: name.trim(), code: null, parentId: parentId || null,
        description: null, budget: 0, color: '#2563EB', icon: 'folder', orderIndex: 0,
        customFieldIds: [], isActive: true, createdAt: now, updatedAt: now,
      };
      tx.insert(categories).values({ ...created, customFieldIds: JSON.stringify(created.customFieldIds) }).run();
      catMap.set(key, created.id);
      return created.id;
    }

    let importedCount = 0;
    const skippedRows: Array<{ rowNumber: number; code: string }> = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row) { skippedRows.push({ rowNumber: firstRow + i + 1, code: 'TITLE_REQUIRED' }); continue; }

      try {
      const titleRaw = row[mapping.titleCol];
      const amountRaw = row[mapping.amountCol];
      if (!titleRaw) throw new SpreadsheetImportValueError('TITLE_REQUIRED', 'Başlık boş olamaz.');
      if (amountRaw === undefined || amountRaw === null || amountRaw === '') throw new SpreadsheetImportValueError('AMOUNT_REQUIRED', 'Tutar boş olamaz.');

      const title = String(titleRaw).trim();
      if (!title) throw new SpreadsheetImportValueError('TITLE_REQUIRED', 'Başlık boş olamaz.');
      const amount = parseImportAmount(amountRaw);
      const dateIso = parseImportDate(row[mapping.dateCol]);
      const currency = parseImportCurrency(mapping.currencyCol === undefined ? undefined : row[mapping.currencyCol], targetProject.currency, amountRaw);
      const exchangeRate = parseImportExchangeRate(mapping.exchangeRateCol === undefined ? undefined : row[mapping.exchangeRateCol], currency, targetProject.currency);
      try { convertPositiveLedgerAmount(amount, exchangeRate); } catch (error) {
        if (!(error instanceof LedgerConversionError)) throw error;
        throw new SpreadsheetImportValueError('EXCHANGE_RATE_INVALID', 'Döviz kuru ile hesaplanan tutar geçersiz.');
      }

      // Cari & Tedarikçi
      const party = mapping.partyCol !== undefined && row[mapping.partyCol] ? String(row[mapping.partyCol]).trim() : undefined;

      // Ödeme Durumu
      const isPaid = parseImportPaid(mapping.isPaidCol === undefined ? undefined : row[mapping.isPaidCol]);

      // Şahsın Cebinden Ödeme (Oto-Kasa)
      const payerPerson = mapping.payerPersonCol !== undefined && row[mapping.payerPersonCol]
        ? String(row[mapping.payerPersonCol]).replace(/✅/g, '').replace(/🔗/g, '').trim()
        : undefined;

      let accountFromId: string | undefined;
      if (mapping.accountFromCol !== undefined && row[mapping.accountFromCol]) {
        accountFromId = String(row[mapping.accountFromCol]).trim();
        if (payerPerson && accountFromId) throw new SpreadsheetImportValueError('PAYMENT_SOURCE_CONFLICT', 'Şahıs ödemesi ile şirket hesabı birlikte kullanılamaz.');
      }
      if (accountFromId) {
        const account = tx.select().from(accounts).where(eq(accounts.id, accountFromId)).get();
        if (!account || !account.isActive || normalizeLedgerCurrency(account.currency) !== currency || (account.projectId !== null && account.projectId !== targetProject.id)) throw new SpreadsheetImportValueError('PAYMENT_ACCOUNT_INVALID', 'Ödeme hesabı geçersiz, pasif, kapsam dışı veya para birimiyle uyumsuz.');
      }
      if (isPaid && !payerPerson && !accountFromId) throw new SpreadsheetImportValueError('PAYMENT_ACCOUNT_REQUIRED', 'Ödenmiş şirket gideri için kullanılabilir ödeme hesabı gerekir.');

      // Create categories only after every row value has passed validation.
      let catId: string;
      if (mapping.categoryCol !== undefined && row[mapping.categoryCol]) {
        const catName = String(row[mapping.categoryCol]).trim();
        catId = getOrCreateCat(catName);
        if (mapping.subCategoryCol !== undefined && row[mapping.subCategoryCol]) {
          const subName = String(row[mapping.subCategoryCol]).trim();
          catId = getOrCreateCat(subName, catId);
        }
      } else {
        catId = getOrCreateCat('Genel Harcamalar');
      }

      const created = transactionRepo.createTransaction(
        {
          projectId: targetProject.id,
          type: 'expense',
          date: dateIso,
          amount,
          currency,
          exchangeRate,
          paymentMethod: 'Banka',
          categoryId: catId,
          title,
          party,
          paymentSource: payerPerson ? 'person_out_of_pocket' : 'company_account',
          accountFromId,
          payerPersonName: payerPerson,
          isPaid,
          status: isPaid ? 'approved' : 'pending',
          createdById: authUser.id,
        },
        config.masterKey,
        config.blindIndexPepper
      );
      const effect = effectOf(created.transaction);
      if (effect) new AccountRepository(tx as unknown as CostCoreDatabase).adjustBalance(effect.accountId, effect.delta, config.masterKey);
      new AuditLogRepository(tx as unknown as CostCoreDatabase).logAction({ userId: authUser.id, action: 'CREATE', entity: 'transaction', entityId: created.transaction.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], previousState: null, newState: snapshot(created.transaction) }, config.masterKey);

      importedCount++;
      } catch (error) {
        if (error instanceof SpreadsheetImportValueError) {
          skippedRows.push({ rowNumber: firstRow + i + 1, code: error.code });
          continue;
        }
        throw error;
      }
    }

    return {
      success: true,
      message: `${importedCount} adet harcama kaydı başarıyla sisteme aktarıldı!`,
      importedCount,
      skippedRows,
      project: targetProject,
    };
    }, { behavior: 'immediate' });
    if (!result) return reply.status(409).send({ code: 'IMPORT_SHEET_CHANGED', error: 'Tablo değişti. Yeniden analiz edin.' });
    return reply.send(result);
    } catch (error) { return importError(reply, error); }
  });

  // 3. GERİYE DÖNÜK UYUMLULUK FALLBACK ROUTE
  fastify.post('/karaelmas', { onRequest: [fastify.authenticate] }, async (_request, reply) => {
    return reply.status(403).send({ error: 'Bu eski y\u00f6ntem devre d\u0131\u015f\u0131d\u0131r. L\u00fctfen Excel dosyas\u0131n\u0131 dosya y\u00fckleme yoluyla g\u00f6nderin.' });
  });
};
