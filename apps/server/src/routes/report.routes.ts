import type { FastifyPluginAsync } from 'fastify';
import { inArray } from 'drizzle-orm';
import { AccountRepository, categories, TransactionRepository, type TransactionFilter, type TransactionReadScope } from '@cost-core/database';
import { ForbiddenError, NotFoundError, SessionInvalidError, isValidPathId } from '../services/project-access.service.js';
import { computeBalanceReport, computeSummaryReport, readBaseCurrencyInTx } from '../financial-report.js';

class ReportValidationError extends Error {}
class CsvExportLimitError extends Error {}
const MAX_CSV_ROWS = 10_000;
const MAX_CSV_BYTES = 16 * 1024 * 1024;

// Only these three query fields may reach the repository. No caller-supplied scope
// or repository-only filter (including dateComparison/includeDeleted) is forwarded.
function reportFilters(value: unknown): TransactionFilter {
  const query = (value ?? {}) as Record<string, unknown>;
  const filters: TransactionFilter = { dateComparison: 'instant' };
  if (Object.prototype.hasOwnProperty.call(query, 'projectId')) {
    if (!isValidPathId(query.projectId)) throw new ReportValidationError();
    filters.projectId = query.projectId;
  }
  function date(name: 'startDate' | 'endDate'): string | undefined {
    if (!Object.prototype.hasOwnProperty.call(query, name)) return undefined;
    const input = query[name];
    if (typeof input !== 'string') throw new ReportValidationError();
    const match = /^(\d{4}-\d{2}-\d{2})(?:T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?Z)?$/.exec(input);
    const time = Date.parse(input);
    if (!match || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== match[1]) throw new ReportValidationError();
    // SQL instant comparison treats stored date-only rows as UTC midnight.
    // The upper bound includes every millisecond of the UTC day.
    if (input.length === 10) return name === 'startDate' ? input : input + 'T23:59:59.999Z';
    return new Date(time).toISOString();
  }
  filters.startDate = date('startDate');
  filters.endDate = date('endDate');
  if (filters.startDate && filters.endDate && Date.parse(filters.startDate) > Date.parse(filters.endDate)) throw new ReportValidationError();
  return filters;
}

export const reportRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, projectAccess, projectRepo } = fastify;
  const db: any = fastify.db;

  function readReport<T>(request: any, read: (tx: any, repo: TransactionRepository, filters: TransactionFilter, scope: TransactionReadScope) => T): T {
    return db.transaction((tx: any) => {
      const session = request.authSession;
      projectAccess.requireFreshActor(tx, request.user?.id, session?.id, session ? Number(session.expiresAt) : NaN);
      const current = projectAccess.resolveScopeInTx(tx, request.user?.id);
      const filters = reportFilters(request.query);
      if (filters.projectId !== undefined && (!projectRepo.getProjectByIdInTx(tx, filters.projectId) || (!current.all && !current.projectIds.includes(filters.projectId)))) throw new NotFoundError();
      const scope: TransactionReadScope = current.all ? { all: true } : { all: false, projectIds: current.projectIds };
      return read(tx, new TransactionRepository(tx), filters, scope);
    });
  }

  function reportError(reply: any, error: unknown) {
    if (error instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
    if (error instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
    if (error instanceof NotFoundError) return reply.status(404).send({ error: 'Bulunamadı.' });
    if (error instanceof CsvExportLimitError) return reply.status(413).send({ code: 'CSV_EXPORT_LIMIT_EXCEEDED', error: 'Daha kısa bir tarih aralığı seçin.' });
    if (error instanceof ReportValidationError) return reply.status(400).send({ error: 'Geçersiz rapor filtresi.' });
    return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
  }

  function reportRows(request: any, maxRows?: number) {
    return readReport(request, (tx, repo, filters, scope) => {
      const all = repo.listTransactionsInScope(filters, scope, config.masterKey, config.blindIndexPepper, maxRows === undefined ? undefined : maxRows + 1);
      if (maxRows !== undefined && all.length > maxRows) throw new CsvExportLimitError();
      const ids = [...new Set(all.map((row) => row.categoryId))];
      const labels: Array<{ id: string; name: string }> = ids.length === 0 ? [] : tx.select({ id: categories.id, name: categories.name }).from(categories).where(inArray(categories.id, ids)).all();
      return { all, categoryMap: new Map(labels.map((c) => [c.id, c.name])) };
    });
  }

  // Current cash reconciles wallet balances; a date filter reports period cash flows.
  fastify.get('/balance', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const balance = readReport(request, (tx, repo, filters, scope) => {
        const transactions = repo.listTransactionsInScope(filters, scope, config.masterKey, config.blindIndexPepper);
        const isPeriodFiltered = Boolean(filters.startDate || filters.endDate);
        const accountScope = filters.projectId !== undefined ? { all: false as const, projectIds: [filters.projectId] } : scope;
        const accounts = isPeriodFiltered ? [] : new AccountRepository(tx).listAccountsInScope(accountScope, config.masterKey);
        return computeBalanceReport({ accounts, transactions, baseCurrency: readBaseCurrencyInTx(tx), todayStr: new Date().toISOString().slice(0, 10), isPeriodFiltered });
      });
      return reply.send(balance);
    } catch (error) { return reportError(reply, error); }
  });

  fastify.get('/summary', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
    const summary = readReport(request, (tx, repo, filters, scope) => {
      const transactions = repo.listTransactionsInScope(filters, scope, config.masterKey, config.blindIndexPepper);
      const ids = [...new Set(transactions.map(row => row.categoryId))];
      const labels: Array<{ id: string; name: string }> = ids.length === 0 ? [] : tx.select({ id: categories.id, name: categories.name }).from(categories).where(inArray(categories.id, ids)).all();
      return computeSummaryReport({ transactions, categoryMap: new Map(labels.map(c => [c.id, c.name])), baseCurrency: readBaseCurrencyInTx(tx) });
    });
    return reply.send(summary);
    } catch (error) { return reportError(reply, error); }
  });

  // EXCEL / CSV DIŞA AKTARMA (Formatlı ve Excel UTF-8 Uyumlu)
  fastify.get('/export/csv', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
    const { all, categoryMap } = reportRows(request, MAX_CSV_ROWS);

    const formulaTriggers = new Set(["=", "+", "-", "@", "\uFF1D", "\uFF0B", "\uFF0D", "\uFF20"]);
    const isDangerousText = (value: string): boolean => {
      if (/^[\t\r\n\u0000]/.test(value)) return true;
      const stripped = value.normalize('NFKC').replace(/^(?:[\p{White_Space}\p{Cc}\p{Cf}]|\u0027)+/u, '');
      return stripped.length > 0 && formulaTriggers.has(stripped.charAt(0));
    };
    const csvTextField = (value: string): string => {
      const text = isDangerousText(value) ? "Metin: " + value : value;
      return "\"" + text.replace(/"/g, "\"\"") + "\"";
    };
    const headers = ['Tarih', 'Başlık / Kalem', 'Tutar', 'Para Birimi', 'Kategori', 'Tedarikçi / Cari', 'Açıklama'];
    const lines = ['\uFEFF' + headers.join(';')];
    let bytes = Buffer.byteLength(lines[0]!);
    for (const row of all) {
      const line = [
        csvTextField(row.date.split('T')[0]),
        csvTextField(row.title),
        row.amount,
        csvTextField(row.currency),
        csvTextField(categoryMap.get(row.categoryId) || ''),
        csvTextField(row.party || ''),
        csvTextField(row.description || ''),
      ].join(';');
      bytes += 2 + Buffer.byteLength(line);
      if (bytes > MAX_CSV_BYTES) throw new CsvExportLimitError();
      lines.push(line);
    }
    const csvContent = lines.join('\r\n');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="TZRCoster_Rapor_${new Date().toISOString().split('T')[0]}.csv"`);
    return reply.send(csvContent);
    } catch (error) { return reportError(reply, error); }
  });
};
