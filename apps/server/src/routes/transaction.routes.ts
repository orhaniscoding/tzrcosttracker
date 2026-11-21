import type { FastifyPluginAsync } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { CreateTransactionSchema, LedgerConversionError, normalizeLedgerCurrency } from "@cost-core/types";
import { auditLogs, projects, categories, transactions } from "@cost-core/database";
import { DomainError, GENERIC, effectOf, snapshot, money, sanitizeMoney } from "../financial-effects.js";
import { AccountRepository, TransactionRepository, type TransactionReadScope } from "@cost-core/database";
import { decryptField } from "@cost-core/crypto";
import { transactionCreateKey, parseTransactionCreateReceipt } from "../services/transaction-create-receipt.js";
import { ForbiddenError, NotFoundError, SessionInvalidError, isValidPathId, type ProjectScope } from "../services/project-access.service.js";

const ALLOWED = new Set(["projectId","type","date","amount","currency","exchangeRate","categoryId","subcategoryId","title","description","party","accountFromId","accountToId","paymentSource","payerPersonName","paymentMethod","dueDate","isPaid","customValues","attachments","status"]);
const IMMUTABLE = new Set(["id","createdById","approvedById","otoKasaTransactionId","deletedAt","createdAt","updatedAt","amountInWords","baseAmount"]);
const INVALID=new Set(["draft","pending_approval","rejected","cancelled"]);
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const transactionRoutes: FastifyPluginAsync = async (fastify) => {
  const { transactionRepo, accountRepo, auditRepo, config } = fastify;
  const db: any = (fastify as any).db;
  const key = config.masterKey; const pepper = config.blindIndexPepper;

  function sendError(reply: any, err: any) {
    if (err instanceof LedgerConversionError) return reply.status(400).send({ error: 'Tutar veya kur dönüşümü desteklenen sınırların dışında.' });
    if (err instanceof DomainError) return reply.status(err.statusCode).send({ error: err.message });
    const msg = err && err.message ? String(err.message) : "";
    if (msg.includes("para birimi değiştirilemez")) return reply.status(409).send({ error: msg });
    return reply.status(500).send({ error: GENERIC });
  }
  function checkBody(body: any) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainError(400, "Geçersiz veri");
    for (const k of Object.keys(body)) {
      if (IMMUTABLE.has(k)) throw new DomainError(400, "Değiştirilemez alan gönderilemez: " + k);
      if (!ALLOWED.has(k)) throw new DomainError(400, "Bilinmeyen alan: " + k);
    }
  }
  // Only metadata is examined until the entire bidirectional link is proven safe.
  function mutationPair(tx: any, id: string, scope: TransactionReadScope) {
    const repo = new TransactionRepository(tx);
    const cols = { id: transactions.id, projectId: transactions.projectId, type: transactions.type, link: transactions.otoKasaTransactionId, paymentSource: transactions.paymentSource, deletedAt: transactions.deletedAt };
    if (!scope.all && scope.projectIds.length === 0) throw new NotFoundError();
    const root: any = tx.select(cols).from(transactions).where(scope.all ? eq(transactions.id, id) : and(eq(transactions.id, id), inArray(transactions.projectId, [...scope.projectIds]))).get();
    if (!root) throw new NotFoundError();
    const incoming: any[] = tx.select(cols).from(transactions).where(eq(transactions.otoKasaTransactionId, id)).all();
    if (root.link === null && incoming.length === 0) {
      if (root.paymentSource === 'person_out_of_pocket') throw new DomainError(409, 'Geçersiz Oto-Kasa bağlantısı.');
      const existing: any = repo.getTransactionInScope(id, scope, key, true);
      if (!existing) throw new NotFoundError();
      return { existing, main: existing, oto: null, isLinkedIncome: false };
    }
    if (!isValidPathId(root.link) || root.link === id || incoming.length !== 1 || incoming[0].id !== root.link) throw new DomainError(409, 'Geçersiz Oto-Kasa bağlantısı.');
    const otherMeta: any = tx.select(cols).from(transactions).where(eq(transactions.id, root.link)).get();
    if (!otherMeta || otherMeta.link !== id || otherMeta.projectId !== root.projectId || root.paymentSource !== 'person_out_of_pocket' || otherMeta.paymentSource !== 'person_out_of_pocket' || !((root.type === 'expense' && otherMeta.type === 'income') || (root.type === 'income' && otherMeta.type === 'expense'))) throw new DomainError(409, 'Geçersiz Oto-Kasa bağlantısı.');
    if ((root.deletedAt === null) !== (otherMeta.deletedAt === null)) throw new DomainError(409, 'Geçersiz Oto-Kasa durumu.');
    const otherIncoming: any[] = tx.select(cols).from(transactions).where(eq(transactions.otoKasaTransactionId, otherMeta.id)).all();
    if (otherIncoming.length !== 1 || otherIncoming[0].id !== id) throw new DomainError(409, 'Geçersiz Oto-Kasa bağlantısı.');
    const existing: any = repo.getTransactionInScope(id, scope, key, true);
    const other: any = repo.getTransactionInScope(otherMeta.id, scope, key, true);
    if (!existing || !other) throw new NotFoundError();
    return root.type === 'expense' ? { existing, main: existing, oto: other, isLinkedIncome: false } : { existing, main: other, oto: existing, isLinkedIncome: true };
  }
  function mutationScope(tx: any, request: any): TransactionReadScope {
    const access = (fastify as any).projectAccess;
    const session = request.authSession;
    const role = access.requireFreshActor(tx, request.user?.id, session?.id, session ? Number(session.expiresAt) : NaN);
    if (!['admin', 'manager', 'accountant'].includes(role)) throw new ForbiddenError();
    const scope: ProjectScope = access.resolveScopeInTx(tx, request.user?.id);
    return scope.all ? { all: true } : { all: false, projectIds: scope.projectIds };
  }
  function mutationWallet(tx: any, scope: TransactionReadScope, data: any, validate = false) {
    if (scope.all) return;
    if (data.paymentSource === 'person_out_of_pocket') return;
    const id = data.type === 'expense' ? data.accountFromId : data.type === 'income' ? data.accountToId : null;
    if (!id) return;
    const walletScope: TransactionReadScope = scope.all ? { all: true } : { all: false, projectIds: [data.projectId] };
    const account = new AccountRepository(tx).getAccountInScope(id, walletScope, key);
    if (!account) throw new NotFoundError();
    if (validate && !account.isActive) throw new DomainError(400, 'Hesap aktif değil.');
    if (validate && normalizeLedgerCurrency(account.currency) !== data.currency) throw new DomainError(400, 'Para birimi hesap para birimi ile eşleşmiyor.');
  }
  function rejectLegacy(tx:any){ if(tx && tx.type==="transfer") throw new DomainError(409,"Legacy transfer kaydi degistirilemez."); }
  function accountOrThrow(id: string) {
    const acc: any = accountRepo.getAccountById(id, key);
    if (!acc) throw new DomainError(400, "Hesap bulunamadı.");
    if (!acc.isActive) throw new DomainError(400, "Hesap aktif değil.");
    return acc;
  }
  function validateRefs(data: any) {
    if (data.projectId) { const r = db.select().from(projects).all().find((p: any) => p.id === data.projectId); if (!r) throw new DomainError(400, "Proje bulunamadı."); }
    if (data.categoryId) { const r = db.select().from(categories).all().find((c: any) => c.id === data.categoryId); if (!r) throw new DomainError(400, "Kategori bulunamadı."); }
    if (data.subcategoryId) { const r = db.select().from(categories).all().find((c: any) => c.id === data.subcategoryId); if (!r) throw new DomainError(400, "Alt kategori bulunamadı."); }
    if (data.subcategoryId && data.categoryId) { const sub: any = db.select().from(categories).all().find((c: any) => c.id === data.subcategoryId); if (sub && sub.parentId !== data.categoryId) throw new DomainError(400, "Alt kategori secilen kategoriye ait degil."); }
    const isPerson = data.paymentSource === "person_out_of_pocket";
    if (isPerson) {
      if (data.type !== "expense") throw new DomainError(400, "Sahsi kaynak yalnizca gider icin kullanilabilir.");
      if (!data.payerPersonName || !String(data.payerPersonName).trim()) throw new DomainError(400, "Şahsi ödeme için ödeyen kişi gereklidir.");
      return;
    }
    if (data.type === "transfer") throw new DomainError(400, "Transfer islemleri /api/accounts/transfer uzerinden yapilmalidir.");
    if (data.type === "expense" && data.accountToId) throw new DomainError(400, "Gider kaydinda hedef hesap kullanilamaz.");
    if (data.type === "income" && data.accountFromId) throw new DomainError(400, "Gelir kaydinda kaynak hesap kullanilamaz.");
    if (data.type === "expense" && data.accountFromId) { const a = accountOrThrow(data.accountFromId); if (a.currency !== data.currency) throw new DomainError(400, "Para birimi hesap para birimi ile eşleşmiyor."); }
    if (data.type === "income" && data.accountToId) { const a = accountOrThrow(data.accountToId); if (a.currency !== data.currency) throw new DomainError(400, "Para birimi hesap para birimi ile eşleşmiyor."); }
    if (data.type === "transfer") {
      if (data.accountFromId) accountOrThrow(data.accountFromId);
      if (data.accountToId) accountOrThrow(data.accountToId);
    }
    if (data.type !== "expense" && data.type !== "income" && data.type !== "transfer") throw new DomainError(400, "Geçersiz işlem tipi.");
    if ((data.type === "expense" && data.accountToId && !data.accountFromId) || (data.type === "income" && data.accountFromId && !data.accountToId)) { /* yön alanı serbest */ }
  }
  function applyMap(map: Map<string, number>) {
    for (const [accId, delta] of map.entries()) { if (delta !== 0) accountRepo.adjustBalance(accId, delta, key); }
  }
  function deltaMap(pairs: Array<any>) {
    const m = new Map<string, number>();
    for (const e of pairs) { if (!e) continue; m.set(e.accountId, money((m.get(e.accountId) || 0) + e.delta)); }
    for (const [k, v] of Array.from(m.entries())) if (v === 0) m.delete(k);
    return m;
  }
  function rev(e: any) { return e ? { accountId: e.accountId, delta: -e.delta } : null; }

  function audit(userId: string, action: string, entityId: string, prev: any, next: any, request: any) {
    auditRepo.logAction({ userId, action: action as any, entity: "transaction", entityId, ipAddress: request.ip, userAgent: request.headers["user-agent"], previousState: prev, newState: next }, key);
  }

  // Read scope is derived afresh from the authenticated actor inside the same DB transaction.
  function readScope(tx: any, request: any, projectId?: unknown): TransactionReadScope {
    const scope: ProjectScope = (fastify as any).projectAccess.resolveScopeInTx(tx, request.user?.id);
    if (projectId === undefined) return scope.all ? { all: true } : { all: false, projectIds: scope.projectIds };
    if (!isValidPathId(projectId)) throw new DomainError(400, "Geçersiz proje kimliği.");
    if (!((fastify as any).projectRepo.getProjectByIdInTx(tx, projectId)) || (!scope.all && !scope.projectIds.includes(projectId))) throw new NotFoundError();
    return { all: false, projectIds: [projectId] };
  }
  function readError(reply: any, err: any) {
    if (err instanceof NotFoundError) return reply.status(404).send({ error: "Bulunamadı." });
    return sendError(reply, err);
  }
  function duplicateInput(value: any) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 1000 || typeof value.date !== 'string') throw new DomainError(400, 'Geçersiz veri');
    const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.exec(value.date);
    if (!match || !Number.isFinite(Date.parse(value.date)) || new Date(match[1] + 'T00:00:00.000Z').toISOString().slice(0, 10) !== match[1]) throw new DomainError(400, 'Geçersiz tarih');
    if (Object.prototype.hasOwnProperty.call(value, 'projectId') && !isValidPathId(value.projectId)) throw new DomainError(400, 'Geçersiz proje kimliği.');
    return { title: value.title, date: value.date, projectId: value.projectId };
  }

  function createError(reply: any, err: any) {
    if (err instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
    if (err instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: 'Bulunamadı.' });
    return sendError(reply, err);
  }

  function authorizeCreateAccess(tx: any, request: any, projectId: string | null) {
    const access = (fastify as any).projectAccess;
    const session = request.authSession;
    const role = access.requireFreshActor(tx, request.user?.id, session?.id, session ? Number(session.expiresAt) : NaN);
    if (!['admin', 'manager', 'accountant'].includes(role)) throw new ForbiddenError();
    const scope: ProjectScope = access.resolveScopeInTx(tx, request.user?.id);
    if (projectId == null) {
      if (role !== 'admin') throw new ForbiddenError();
    } else if (!((fastify as any).projectRepo.getProjectByIdInTx(tx, projectId)) || (!scope.all && !scope.projectIds.includes(projectId))) {
      throw new NotFoundError();
    }
    return role;
  }

  function authorizeCreate(tx: any, request: any, data: any) {
    const role = authorizeCreateAccess(tx, request, data.projectId);
    const pid = data.projectId;
    if (data.paymentSource === 'person_out_of_pocket') { validateRefs(data); return; }
    if (data.type === 'expense' && data.accountToId) throw new DomainError(400, 'Gider kaydinda hedef hesap kullanilamaz.');
    if (data.type === 'income' && data.accountFromId) throw new DomainError(400, 'Gelir kaydinda kaynak hesap kullanilamaz.');
    validateRefs({ ...data, accountFromId: null, accountToId: null });
    const id = data.type === 'expense' ? data.accountFromId : data.accountToId;
    if (id) {
      // Restrict to the transaction project before decrypting, even for multi-project members.
      const walletScope = role === 'admin' ? { all: true as const } : { all: false as const, projectIds: [pid] };
      const account = new AccountRepository(tx).getAccountInScope(id, walletScope, key);
      if (!account) throw new NotFoundError();
      if (!account.isActive) throw new DomainError(400, 'Hesap aktif değil.');
      if (normalizeLedgerCurrency(account.currency) !== data.currency) throw new DomainError(400, 'Para birimi hesap para birimi ile eşleşmiyor.');
    }
  }

  fastify.post("/check-duplicate", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const body = duplicateInput(request.body);
      let result: any;
      db.transaction((tx: any) => { result = new TransactionRepository(tx).checkDuplicateInScope(body as any, readScope(tx, request, body.projectId), pepper); });
      return reply.send(result);
    } catch (err) { return readError(reply, err); }
  });

  fastify.get("/", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const query = request.query as any;
      let results: any;
      db.transaction((tx: any) => { results = new TransactionRepository(tx).listTransactionsInScope(query, readScope(tx, request, query?.projectId), key, pepper); });
      return reply.send(results);
    } catch (err) { return readError(reply, err); }
  });

  fastify.post("/", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const parse = CreateTransactionSchema.safeParse(request.body);
      if (!parse.success) return reply.status(400).send({ error: "Geçersiz veri", details: parse.error.format() });
      checkBody(request.body);
      const authUser = request.user as { id: string };
      const data: any = parse.data;
      const body: any = request.body;
      let idempotency;
      try { idempotency = transactionCreateKey(request.headers["idempotency-key"], authUser.id, body); }
      catch { throw new DomainError(400, "Geçersiz işlem tekrar anahtarı."); }
      const hasExplicitPaid = Object.prototype.hasOwnProperty.call(body, 'isPaid');
      if (hasExplicitPaid && ((data.status === 'paid' && data.isPaid === false) || (data.status === 'pending' && data.isPaid === true))) throw new DomainError(400, 'Çelişkili ödeme durumu.');
      if (!hasExplicitPaid && ['pending', 'draft', 'pending_approval', 'rejected', 'cancelled'].includes(data.status)) data.isPaid = false;
      if (data.isPaid === false && (body.status === undefined || data.status === 'approved')) data.status = 'pending';
      if (data.paymentSource === 'person_out_of_pocket') { data.accountFromId = null; data.accountToId = null; }
      data.amount = sanitizeMoney(data.amount);
      let outTxn: any; let outOto: any;
      db.transaction((tx: any) => {
        const repo = new TransactionRepository(tx);
        if (idempotency) {
          authorizeCreateAccess(tx, request, data.projectId ?? null);
          const existing = tx.select().from(auditLogs).where(eq(auditLogs.id, idempotency.auditId)).get();
          if (existing) {
            if (existing.userId !== authUser.id || existing.action !== "CREATE" || existing.entity !== "transaction" || !existing.diffEncrypted || !existing.entityId) throw new DomainError(409, "İşlem tekrar anahtarı geçersiz.");
            const diff = decryptField<any>(existing.diffEncrypted, key);
            const receipt = parseTransactionCreateReceipt(diff.newState?._creationReceipt);
            if (receipt.scope !== idempotency.scope || idempotency.fingerprint(receipt.nonce) !== receipt.fingerprint) throw new DomainError(409, "İşlem tekrar anahtarı farklı bir istek için kullanılmış.");
            authorizeCreateAccess(tx, request, receipt.projectId);
const replayScope = receipt.projectId === null ? readScope(tx, request) : readScope(tx, request, receipt.projectId);
            outTxn = repo.getTransactionInScope(existing.entityId, replayScope, key);
            if (!outTxn) throw new NotFoundError();
            outOto = outTxn.otoKasaTransactionId ? repo.getTransactionInScope(outTxn.otoKasaTransactionId, replayScope, key) : undefined;
            return;
          }
        }
        authorizeCreate(tx, request, data);
        const created: any = repo.createTransaction({ ...data, createdById: authUser.id }, key, pepper);
        outTxn = created.transaction; outOto = created.otoKasaTransaction;
        const eff = effectOf(outTxn);
        if (eff) new AccountRepository(tx).adjustBalance(eff.accountId, eff.delta, key);
        if (idempotency) {
          const receipt = idempotency.receipt(data.projectId ?? null);
          auditRepo.logAction({ userId: authUser.id, action: "CREATE" as any, entity: "transaction", entityId: outTxn.id, ipAddress: request.ip, userAgent: request.headers["user-agent"], previousState: null, newState: { ...snapshot(outTxn), _creationReceipt: receipt } }, key, idempotency.auditId);
const createdScope = data.projectId == null ? readScope(tx, request) : readScope(tx, request, data.projectId);
          outTxn = repo.getTransactionInScope(outTxn.id, createdScope, key);
          if (outTxn?.otoKasaTransactionId) outOto = repo.getTransactionInScope(outTxn.otoKasaTransactionId, createdScope, key);
        } else {
          audit(authUser.id, "CREATE", outTxn.id, null, snapshot(outTxn), request);
        }
      }, { behavior: "immediate" });
      return reply.status(201).send({ transaction: outTxn, otoKasaTransaction: outOto });
    } catch (err: any) { return createError(reply, err); }
  });

  fastify.get("/trash", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      let list: any;
      db.transaction((tx: any) => { list = new TransactionRepository(tx).listTrashInScope(readScope(tx, request, (request.query as any)?.projectId), key); });
      return reply.send(list);
    } catch (err) { return readError(reply, err); }
  });

  fastify.get("/:id", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      if (!isValidPathId(id)) throw new DomainError(400, 'Geçersiz kimlik.');
      let found: any;
      db.transaction((tx: any) => { found = new TransactionRepository(tx).getTransactionInScope(id, readScope(tx, request), key); });
      if (!found) return reply.status(404).send({ error: "Kayıt bulunamadı." });
      return reply.send(found);
    } catch (err) { return readError(reply, err); }
  });

  fastify.put("/:id", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const authUser = request.user as { id: string };
      if (!isValidPathId(id)) throw new DomainError(400, 'Geçersiz kimlik.');
      checkBody(request.body);
      const body: any = request.body || {};
      let updated: any;
      db.transaction((tx: any) => {
        const scope = mutationScope(tx, request);
        const pair0 = mutationPair(tx, id, scope);
        const existing: any = pair0.existing;
        if (!existing) throw new DomainError(404, "Düzenlenecek kayıt bulunamadı."); rejectLegacy(existing); if (existing.deletedAt) throw new DomainError(404, "Düzenlenecek kayıt bulunamadı.");
        if (pair0.isLinkedIncome) throw new DomainError(409, "Bu kayıt bağlı Oto-Kasa geliridir; lütfen asıl gider kaydını düzenleyin.");
        const main: any = pair0.main; rejectLegacy(main); if (body.type !== undefined && body.type !== main.type) throw new DomainError(409, "Transaction type cannot be changed."); if (Object.prototype.hasOwnProperty.call(body, 'projectId') && (body.projectId ?? null) !== (main.projectId ?? null)) throw new DomainError(409, "Transaction project cannot be changed.");
        if (main.id !== id) throw new DomainError(409, "Bu kayıt bağlı Oto-Kasa geliridir; lütfen asıl gider kaydını düzenleyin.");
        if (body.isPaid === true && body.status !== "approved" && (INVALID.has(main.status) || (body.status !== undefined && INVALID.has(body.status)))) throw new DomainError(409, "Invalid paid-state transition requires explicit approved status.");
        if (INVALID.has(main.status) && body.status !== undefined && body.status !== "approved" && !INVALID.has(body.status)) throw new DomainError(409, "Invalid state transition requires explicit approved status.");
        const merged: any = { projectId: main.projectId ?? null, type: main.type, date: main.date, amount: main.amount, currency: main.currency, exchangeRate: main.exchangeRate, categoryId: main.categoryId, subcategoryId: main.subcategoryId ?? null, title: main.title, description: main.description ?? null, party: main.party ?? null, accountFromId: main.accountFromId ?? null, accountToId: main.accountToId ?? null, paymentSource: main.paymentSource, payerPersonName: main.payerPersonName ?? null, paymentMethod: main.paymentMethod, dueDate: main.dueDate ?? null, isPaid: main.isPaid, customValues: main.customValues || {}, attachments: main.attachments || [], status: main.status, ...body };
        if (merged.isPaid === true && merged.status === "pending") merged.status = "approved";
        if (merged.isPaid === false && merged.status === "approved") merged.status = "pending";
        const schemaInput: any = { ...merged };
        if (schemaInput.isPaid === undefined) schemaInput.isPaid = main.isPaid;
        const parse = CreateTransactionSchema.safeParse(schemaInput);
        if (!parse.success) throw new DomainError(400, "Geçersiz veri");
        const data: any = parse.data;
        if (data.paymentSource === 'person_out_of_pocket') { data.accountFromId = null; data.accountToId = null; }
        if (body.amount !== undefined) data.amount = sanitizeMoney(data.amount);
        data.projectId = merged.projectId; data.type = merged.type; data.status = merged.status; data.isPaid = merged.isPaid;
        if (data.paymentSource !== 'person_out_of_pocket') {
          if (data.type === 'expense' && data.accountToId) throw new DomainError(400, 'Gider kaydinda hedef hesap kullanilamaz.');
          if (data.type === 'income' && data.accountFromId) throw new DomainError(400, 'Gelir kaydinda kaynak hesap kullanilamaz.');
        }
        mutationWallet(tx, scope, main);
        if (pair0.oto) mutationWallet(tx, scope, pair0.oto);
        mutationWallet(tx, scope, data, true);
        validateRefs(scope.all ? data : { ...data, accountFromId: null, accountToId: null });
        const beforeEff = effectOf(main);
        const beforeOtoEff = pair0.oto ? effectOf(pair0.oto) : null;
        const updates: any = {};
        for (const k of Object.keys(body)) updates[k] = (data as any)[k];
        if (data.paymentSource === 'person_out_of_pocket') { updates.accountFromId = null; updates.accountToId = null; }
        if (body.isPaid !== undefined && body.status === undefined) { /* status repo tarafında ayarlanır */ }
        else if (body.status !== undefined) updates.status = data.status;
        if (body.isPaid !== undefined && body.status !== undefined) updates.status = data.status;
        updated = transactionRepo.updateTransaction(id, updates, key, pepper);
        if (!updated) throw new DomainError(404, "Düzenlenecek kayıt bulunamadı.");
        if (body.status !== undefined || body.isPaid !== undefined) {
          const wantStatus = data.status;
          if (updated.status !== wantStatus) { const again: any = transactionRepo.updateTransaction(id, { status: wantStatus } as any, key, pepper); if (again) updated = again; }
        }
        const pair1 = mutationPair(tx, id, scope);
        const afterMain: any = pair1.main;
        const afterEff = effectOf(afterMain);
        const afterOtoEff = pair1.oto ? effectOf(pair1.oto) : null;
        const map = deltaMap([rev(beforeEff), rev(beforeOtoEff), afterEff, afterOtoEff]);
        applyMap(map);
        audit(authUser.id, "UPDATE", id, snapshot(main), snapshot(afterMain), request);
      }, { behavior: "immediate" });
      return reply.send(updated);
    } catch (err: any) { return createError(reply, err); }
  });

  function doDelete(id: string, authUser: any, request: any, permanent: boolean, viaPermanentUrl: boolean) {
    let outMsg = permanent ? "Kayıt kalıcı olarak silindi." : "Kayıt çöp kutusuna taşındı.";
    if (!isValidPathId(id)) throw new DomainError(400, 'Geçersiz kimlik.');
    db.transaction((tx: any) => {
      const scope = mutationScope(tx, request);
      const pair = mutationPair(tx, id, scope);
      const existing: any = pair.existing;
      if (!existing) throw new DomainError(404, permanent ? "Kayıt bulunamadı veya kalıcı olarak silinemedi." : "Silinecek kayıt bulunamadı.");
      rejectLegacy(existing); rejectLegacy(pair.main); if (pair.oto) rejectLegacy(pair.oto);
      mutationWallet(tx, scope, pair.main); if (pair.oto) mutationWallet(tx, scope, pair.oto);
      if (permanent) {
        if (!existing.deletedAt) {
          const map = deltaMap([rev(effectOf(pair.main)), rev(pair.oto ? effectOf(pair.oto) : null)]);
          applyMap(map);
        }
        const delId = pair.main.id;
        let ok: any;
        if (viaPermanentUrl) ok = transactionRepo.permanentDeleteTransaction(delId, key);
        else ok = transactionRepo.deleteTransaction(delId, key, true);
        if (!ok) throw new DomainError(404, "Kayıt bulunamadı veya kalıcı olarak silinemedi.");
        if (pair.oto) { const still = new TransactionRepository(tx).getTransactionInScope(pair.oto.id, scope, key, true); if (still) transactionRepo.permanentDeleteTransaction(pair.oto.id, key); }
        audit(authUser.id, "PERMANENT_DELETE", delId, snapshot(existing), null, request);
      } else {
        if (existing.deletedAt) throw new DomainError(404, "Silinecek kayıt bulunamadı.");
        const map = deltaMap([rev(effectOf(pair.main)), rev(pair.oto ? effectOf(pair.oto) : null)]);
        applyMap(map);
        const ok: any = transactionRepo.deleteTransaction(pair.main.id, key, false);
        if (!ok) throw new DomainError(400, "Kayıt silinemedi.");
        if (pair.oto && pair.main.id === id) { /* repo pair trash */ }
        if (pair.oto && pair.main.id !== id) { transactionRepo.deleteTransaction(pair.oto.id, key, false); }
        audit(authUser.id, "DELETE", pair.main.id, snapshot(existing), null, request);
      }
    }, { behavior: "immediate" });
    return outMsg;
  }

  fastify.delete("/:id", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const authUser = request.user as { id: string };
      const query = request.query as { permanent?: string };
      const isPermanent = query.permanent === "true";
      const msg = doDelete(id, authUser, request, isPermanent, false);
      return reply.send({ success: true, message: msg });
    } catch (err: any) { return createError(reply, err); }
  });

  fastify.delete("/:id/permanent", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const authUser = request.user as { id: string };
      const msg = doDelete(id, authUser, request, true, true);
      return reply.send({ success: true, message: "Kayıt veritabanından kalıcı olarak silindi." });
    } catch (err: any) { return createError(reply, err); }
  });

  fastify.post("/:id/restore", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const authUser = request.user as { id: string };
      if (!isValidPathId(id)) throw new DomainError(400, 'Geçersiz kimlik.');
      let restored: any; let wasLive = false;
      db.transaction((tx: any) => {
        const scope = mutationScope(tx, request);
        const pair = mutationPair(tx, id, scope);
        const existing: any = pair.existing;
        if (!existing) throw new DomainError(404, "Geri yüklenecek kayıt bulunamadı.");
        rejectLegacy(pair.main); if (pair.oto) rejectLegacy(pair.oto);
        mutationWallet(tx, scope, pair.main); if (pair.oto) mutationWallet(tx, scope, pair.oto);
        rejectLegacy(existing); if (!existing.deletedAt) { restored = existing; wasLive = true; return; }
        restored = transactionRepo.restoreTransaction(pair.main.id, key);
        if (!restored) throw new DomainError(404, "Geri yüklenecek kayıt bulunamadı.");
        const pair1 = mutationPair(tx, pair.main.id, scope);
        const afterMain: any = pair1.main;
        const map = deltaMap([effectOf(afterMain), pair1.oto ? effectOf(pair1.oto) : null]);
        applyMap(map);
        audit(authUser.id, "RESTORE", pair.main.id, snapshot(existing), snapshot(afterMain), request);
        restored = afterMain;
      }, { behavior: "immediate" });
      return reply.send(restored);
    } catch (err: any) { return createError(reply, err); }
  });

  fastify.post("/:id/mark-paid", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const authUser = request.user as { id: string };
      if (!isValidPathId(id)) throw new DomainError(400, 'Geçersiz kimlik.');
      let paidTx: any;
      db.transaction((tx: any) => {
        const scope = mutationScope(tx, request);
        const pair = mutationPair(tx, id, scope);
        const existing: any = pair.existing;
        if (!existing) throw new DomainError(404, "Kayıt bulunamadı."); rejectLegacy(existing); if (existing.deletedAt) throw new DomainError(404, "Kayıt bulunamadı.");
        mutationWallet(tx, scope, pair.main); if (pair.oto) mutationWallet(tx, scope, pair.oto);
        if (pair.isLinkedIncome) throw new DomainError(409, "Bu kayıt bağlı Oto-Kasa geliridir; lütfen asıl gider kaydını düzenleyin.");
        if (INVALID.has(pair.main.status)) throw new DomainError(409, "Invalid state cannot be marked paid.");
        if (existing.isPaid) { paidTx = existing; return; }
        const beforeEff = effectOf(existing);
        paidTx = transactionRepo.markTransactionPaid(pair.main.id, key);
        if (!paidTx) throw new DomainError(404, "Kayıt bulunamadı.");
        const afterMain: any = mutationPair(tx, pair.main.id, scope).main;
        const afterEff = effectOf(afterMain);
        const map = deltaMap([rev(beforeEff), afterEff]);
        applyMap(map);
        audit(authUser.id, "UPDATE", pair.main.id, snapshot(existing), snapshot(afterMain), request);
        paidTx = afterMain;
      }, { behavior: "immediate" });
      return reply.send(paidTx);
    } catch (err: any) { return createError(reply, err); }
  });
};
