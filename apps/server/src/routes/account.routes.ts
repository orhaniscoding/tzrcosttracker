import type { FastifyPluginAsync } from "fastify";
import { CreateAccountSchema, InternalTransferSchema } from "@cost-core/types";
import { AccountRepository, AuditLogRepository, transactions, auditLogs, type AccountReadScope } from "@cost-core/database";
import { DomainError, GENERIC, accountSnapshot, money } from "../financial-effects.js";
import { computeLiquiditySummary, readBaseCurrencyInTx } from '../financial-report.js';
import { decryptField, isEncrypted } from "@cost-core/crypto";
import { ForbiddenError, NotFoundError, SessionInvalidError, isValidPathId, type ProjectScope } from '../services/project-access.service.js';

const ALLOWED = new Set(["projectId","name","type","currency","initialBalance","creditLimit","statementClosingDay","paymentDueDay","iban","bankName","description"]);
const IMMUTABLE = new Set(["id","isActive","createdAt","updatedAt","balance"]);

export const accountRoutes: FastifyPluginAsync = async (fastify) => {
  const { config } = fastify;
  const db: any = (fastify as any).db;
  const key = config.masterKey; const pepper = config.blindIndexPepper;

  function sendError(reply: any, err: any) {
    if (err instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz eri\u015Fim.' });
    if (err instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: 'Bulunamad\u0131.' });
    if (err instanceof DomainError) return reply.status(err.statusCode).send({ error: err.message });
    const msg = err && err.message ? String(err.message) : "";
    if (msg.includes("para birimi de\u011Fi\u015Ftirilemez")) return reply.status(409).send({ error: msg });
    if (msg.includes("mali kay\u0131tlarda kullan")) return reply.status(409).send({ error: msg });
    if (msg.includes("Ba\u015Flang\u0131\u00e7 bakiyesi")) return reply.status(409).send({ error: msg });
    return reply.status(500).send({ error: GENERIC });
  }
  function checkBody(body: any) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainError(400, "Ge\u00e7ersiz c\u00FCzdan verisi");
    for (const k of Object.keys(body)) {
      if (IMMUTABLE.has(k)) throw new DomainError(400, "De\u011Fi\u015Ftirilemez alan g\u00F6nderilemez: " + k);
      if (!ALLOWED.has(k)) throw new DomainError(400, "Bilinmeyen alan: " + k);
    }
  }
  function audit(tx: any, userId: string, action: string, entity: string, entityId: string, prev: any, next: any, request: any) {
    new AuditLogRepository(tx).logAction({ userId, action: action as any, entity, entityId, ipAddress: request.ip, userAgent: request.headers['user-agent'], previousState: prev, newState: next }, key);
  }
  const access: any = (fastify as any).projectAccess;
  function actorId(request: any): string { const u: any = request && request.user; return u && typeof u.id === 'string' ? u.id : ''; }
  function freshRole(tx: any, request: any): string { const sess: any = (request as any).authSession || null; return access.requireFreshActor(tx, actorId(request), sess && typeof sess.id === 'string' ? sess.id : '', sess ? Number(sess.expiresAt) : NaN); }
  function requireWritable(role: string) { if (!['admin','manager','accountant'].includes(role)) throw new ForbiddenError(); }
  function scopeOf(tx: any, request: any): ProjectScope { return access.resolveScopeInTx(tx, actorId(request)); }
  function toReadScope(scope: ProjectScope): AccountReadScope { return scope.all ? { all: true } : { all: false, projectIds: [...scope.projectIds] }; }
  function readScopeForQuery(tx: any, request: any, rawPid: any): AccountReadScope { const scope = scopeOf(tx, request); if (rawPid === undefined) return toReadScope(scope); if (!isValidPathId(rawPid)) throw new DomainError(400, 'Ge\u00e7ersiz proje kimli\u011Fi.'); const pid = rawPid as string; if (!(fastify as any).projectRepo.getProjectByIdInTx(tx, pid)) throw new NotFoundError(); if (!scope.all && !scope.projectIds.includes(pid)) throw new NotFoundError(); return { all: false, projectIds: [pid] }; }
  function isReferenced(tx: any, id: string): boolean {
    const a = tx.select().from(transactions).all().filter((t: any) => t.accountFromId === id || t.accountToId === id);
    return a.length > 0;
  }
  function hasInternalTransferActivity(tx: any, id: string): boolean { const rows = tx.select().from(auditLogs).all().filter((a: any) => a.entity === 'internal_transfer' && typeof a.entityId === 'string'); return rows.some((a: any) => { const parts = a.entityId.split('->'); return parts.length === 2 && (parts[0] === id || parts[1] === id); }); }
  function hasAuditSnapshotReference(tx: any, id: string): boolean {
    const rows = tx.select().from(auditLogs).all().filter((a: any) => a.entity === "transaction");
    for (const row of rows) {
      const cached: any = (row as any).diffEncrypted;
      if (typeof cached !== "string" || !isEncrypted(cached)) throw new DomainError(409, "Islem denetim kaydi dogrulanamadi; hesap islemi reddedildi.");
      let diff: any;
      try { diff = decryptField<any>(cached, key); } catch { throw new DomainError(409, "Islem denetim kaydi dogrulanamadi; hesap islemi reddedildi."); }
      if (!diff || typeof diff !== "object" || Array.isArray(diff) || !Object.prototype.hasOwnProperty.call(diff, "previousState") || !Object.prototype.hasOwnProperty.call(diff, "newState")) throw new DomainError(409, "Islem denetim kaydi okunamadi; hesap islemi reddedildi.");
      const states = [diff.previousState, diff.newState];
      for (const s of states) { if (s !== null && (typeof s !== "object" || Array.isArray(s))) throw new DomainError(409, "Islem denetim kaydi okunamadi; hesap islemi reddedildi."); }
      for (const s of states) { if (s && (s.accountFromId === id || s.accountToId === id)) return true; }
    }
    return false;
  }
  function hasFinancialActivity(tx: any, id: string): boolean { return isReferenced(tx, id) || hasInternalTransferActivity(tx, id) || hasAuditSnapshotReference(tx, id); }
  function canonMoney(n: any, label: string): number {
    if (typeof n !== "number" || !Number.isFinite(n)) throw new DomainError(400, label + " gecersiz.");
    const cents = Math.round(n * 100);
    if (!Number.isSafeInteger(cents)) throw new DomainError(400, label + " guvenli sinir disinda.");
    if (Math.abs(n * 100 - cents) > 1e-7) throw new DomainError(400, label + " en fazla 2 ondalik basamak icerebilir.");
    return cents / 100;
  }
  function canonicalizeAccountMoney(data: any, body: any) {
    if (!body) return;
    if (body.initialBalance !== undefined) data.initialBalance = canonMoney(data.initialBalance, "Baslangic bakiyesi");
    if (body.creditLimit !== undefined) data.creditLimit = canonMoney(data.creditLimit, "Kredi limiti");
  }

  fastify.get('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      let list: any;
      db.transaction((tx: any) => {
        freshRole(tx, request);
        const scope = readScopeForQuery(tx, request, (request.query as any)?.projectId);
        list = new AccountRepository(tx).listAccountsInScope(scope, key);
      });
      return reply.send(list);
    } catch (err: any) { return sendError(reply, err); }
  });
  fastify.post('/', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const parse = CreateAccountSchema.safeParse(request.body);
      if (!parse.success) return reply.status(400).send({ error: 'Ge\u00e7ersiz c\u00FCzdan verisi', details: parse.error.format() });
      checkBody(request.body);
      const body: any = request.body || {};
      let created: any;
      db.transaction((tx: any) => {
        const role = freshRole(tx, request); requireWritable(role);
        const scope = scopeOf(tx, request);
        const hasPid = Object.prototype.hasOwnProperty.call(body, 'projectId');
        const rawPid: any = hasPid ? body.projectId : undefined;
        let projectId: string | null;
        if (role === 'admin') {
          projectId = rawPid === undefined || rawPid === null ? null : rawPid;
          if (projectId !== null && !(fastify as any).projectRepo.getProjectByIdInTx(tx, projectId)) throw new NotFoundError();
        } else {
          if (!hasPid || rawPid === null || rawPid === undefined) throw new ForbiddenError();
          if (!(fastify as any).projectRepo.getProjectByIdInTx(tx, rawPid)) throw new NotFoundError();
          if (!scope.all && !scope.projectIds.includes(rawPid)) throw new NotFoundError();
          projectId = rawPid;
        }
        const d: any = { ...parse.data, projectId }; canonicalizeAccountMoney(d, body);
        created = new AccountRepository(tx).createAccount(d, key, pepper);
        audit(tx, actorId(request), 'CREATE', 'account', created.id, null, accountSnapshot(created), request);
      }, { behavior: 'immediate' });
      return reply.status(201).send(created);
    } catch (err: any) { return sendError(reply, err); }
  });
  fastify.post('/transfer', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const parse = InternalTransferSchema.safeParse(request.body);
      if (!parse.success) return reply.status(400).send({ error: 'Ge\u00e7ersiz transfer parametreleri', details: parse.error.format() });
      const body: any = request.body || {};
      if (body.id !== undefined) throw new DomainError(400, 'De\u011Fi\u015Ftirilemez alan g\u00F6nderilemez: id');
      const d: any = parse.data; d.amount = canonMoney(d.amount, 'Transfer tutar\u0131');
      let result: any; let fromBefore: any; let toBefore: any;
      db.transaction((tx: any) => {
        const role = freshRole(tx, request); requireWritable(role);
        const scope = toReadScope(scopeOf(tx, request));
        if (d.fromAccountId === d.toAccountId) throw new DomainError(400, 'Kaynak ve hedef hesap ayn\u0131 olamaz.');
        const txRepo: any = new AccountRepository(tx);
        const fromAcc: any = txRepo.getAccountInScope(d.fromAccountId, scope, key);
        const toAcc: any = txRepo.getAccountInScope(d.toAccountId, scope, key);
        if (!fromAcc || !toAcc) throw new DomainError(404, 'Hesap bulunamad\u0131.');
        if (!fromAcc.isActive || !toAcc.isActive) throw new DomainError(400, 'Hesap aktif de\u011Fil.');
        fromBefore = fromAcc; toBefore = toAcc;
        if (fromAcc.currency !== toAcc.currency && body.exchangeRate === undefined) throw new DomainError(400, 'Farkl\u0131 para birimleri i\u00e7in a\u00e7\u0131k pozitif kur gereklidir.');
        if (fromAcc.currency === toAcc.currency && body.exchangeRate !== undefined && Number(body.exchangeRate) !== 1) throw new DomainError(400, 'Ayn\u0131 para biriminde kur 1 olmal\u0131d\u0131r.');
        result = txRepo.executeInternalTransfer(d, key);
        audit(tx, actorId(request), 'CREATE', 'internal_transfer', d.fromAccountId + '->' + d.toAccountId, { from: accountSnapshot(fromBefore), to: accountSnapshot(toBefore) }, { fromAccount: result.fromAccount.name, toAccount: result.toAccount.name, amount: d.amount, exchangeRate: d.exchangeRate, fromNewBalance: result.fromAccount.balance, toNewBalance: result.toAccount.balance, fromCurrency: fromBefore.currency, toCurrency: toBefore.currency }, request);
      }, { behavior: 'immediate' });
      return reply.send({ success: true, message: 'Virman i\u015Flemi ba\u015Far\u0131yla ger\u00e7ekle\u015Ftirildi.', ...result });
    } catch (err: any) { return sendError(reply, err); }
  });
  fastify.get('/liquidity/summary', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      let out: any;
      db.transaction((tx: any) => {
        freshRole(tx, request);
        const scope = readScopeForQuery(tx, request, (request.query as any)?.projectId);
        const all = new AccountRepository(tx).listAccountsInScope(scope, key);
        out = computeLiquiditySummary({ accounts: all, baseCurrency: readBaseCurrencyInTx(tx) });
      });
      return reply.send(out);
    } catch (err: any) { return sendError(reply, err); }
  });

  fastify.get('/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const id = (request.params as any).id;
      let account: any;
      db.transaction((tx: any) => { freshRole(tx, request); const scope = toReadScope(scopeOf(tx, request)); account = new AccountRepository(tx).getAccountInScope(id, scope, key); });
      if (!account) return reply.status(404).send({ error: 'Hesap bulunamad\u0131.' });
      return reply.send(account);
    } catch (err: any) { return sendError(reply, err); }
  });
  fastify.put('/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const id = (request.params as any).id;
      checkBody(request.body);
      const body: any = request.body || {};
      let updated: any;
      db.transaction((tx: any) => {
        const role = freshRole(tx, request); requireWritable(role);
        const scope = toReadScope(scopeOf(tx, request));
        const txRepo: any = new AccountRepository(tx);
        const previous: any = txRepo.getAccountInScope(id, scope, key);
        if (!previous) throw new DomainError(404, 'D\u00FCzenlenecek hesap bulunamad\u0131.');
        const hasPid = Object.prototype.hasOwnProperty.call(body, 'projectId');
        if (hasPid) {
          const rawPid: any = body.projectId;
          if (rawPid !== null && rawPid !== previous.projectId && !isValidPathId(rawPid)) throw new DomainError(400, 'Ge\u00e7ersiz proje kimli\u011Fi.');
          if (rawPid !== previous.projectId) {
            if (role !== 'admin') throw new ForbiddenError();
            if (rawPid !== null && !(fastify as any).projectRepo.getProjectByIdInTx(tx, rawPid)) throw new NotFoundError();
          }
        }
        const merged: any = { name: previous.name, type: previous.type, currency: previous.currency, initialBalance: previous.balance, creditLimit: previous.creditLimit, statementClosingDay: previous.statementClosingDay, paymentDueDay: previous.paymentDueDay, iban: previous.iban, bankName: previous.bankName, description: previous.description, ...body };
        if (!hasPid) delete merged.projectId;
        const parse = CreateAccountSchema.safeParse(merged);
        if (!parse.success) throw new DomainError(400, 'Ge\u00e7ersiz c\u00FCzdan verisi');
        const data: any = parse.data; canonicalizeAccountMoney(data, body);
        const hasActivity = hasFinancialActivity(tx, id);
        if (hasPid && body.projectId !== previous.projectId && hasActivity) throw new DomainError(409, 'Mali ge\u00e7mi\u015Fi olan hesab\u0131n projesi de\u011Fi\u015Ftirilemez.');
        if (hasActivity && body.currency !== undefined && body.currency !== previous.currency) throw new DomainError(409, 'Bu hesap mali kay\u0131tlarda kullan\u0131ld\u0131\u011F\u0131 i\u00e7in para birimi de\u011Fi\u015Ftirilemez; d\u00FCzeltme i\u00e7in kay\u0131tl\u0131 virman veya yeni hesap kullan\u0131n.');
        if (hasActivity && body.initialBalance !== undefined && canonMoney(Number(body.initialBalance), 'Baslangic bakiyesi') !== money(previous.balance)) throw new DomainError(409, 'Ba\u015Flang\u0131\u00e7 bakiyesi mali hareket sonras\u0131 de\u011Fi\u015Ftirilemez; d\u00FCzeltme i\u00e7in kay\u0131tl\u0131 virman veya yeni hesap kullan\u0131n.');
        const updates: any = { ...data }; delete updates.initialBalance;
        if (!hasActivity && body.initialBalance !== undefined) updates.initialBalance = data.initialBalance;
        if (body.currency === undefined) delete updates.currency;
        if (body.creditLimit === undefined) delete updates.creditLimit;
        if (!hasPid) delete updates.projectId;
        updated = txRepo.updateAccount(id, updates, key, pepper);
        if (!updated) throw new DomainError(404, 'D\u00FCzenlenecek hesap bulunamad\u0131.');
        audit(tx, actorId(request), 'UPDATE', 'account', id, accountSnapshot(previous), accountSnapshot(updated), request);
      }, { behavior: 'immediate' });
      return reply.send(updated);
    } catch (err: any) { return sendError(reply, err); }
  });
  fastify.delete('/:id', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const id = (request.params as any).id;
      db.transaction((tx: any) => {
        const role = freshRole(tx, request); requireWritable(role);
        const scope = toReadScope(scopeOf(tx, request));
        const txRepo: any = new AccountRepository(tx);
        const previous: any = txRepo.getAccountInScope(id, scope, key);
        if (!previous) throw new DomainError(404, 'Hesap bulunamad\u0131 veya silinemedi.');
        if (hasFinancialActivity(tx, id)) throw new DomainError(409, 'Bu hesap mali kay\u0131tlarda kullan\u0131ld\u0131\u011F\u0131 i\u00e7in silinemez.');
        const deleted = txRepo.deleteAccount(id);
        if (!deleted) throw new DomainError(404, 'Hesap bulunamad\u0131 veya silinemedi.');
        audit(tx, actorId(request), 'DELETE', 'account', id, accountSnapshot(previous), null, request);
      }, { behavior: 'immediate' });
      return reply.send({ success: true, message: 'Hesap ba\u015Far\u0131yla silindi.' });
    } catch (err: any) { return sendError(reply, err); }
  });
};
