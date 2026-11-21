import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { AccountRepository, auditLogs, categories, projects, transactions } from '@cost-core/database';
import { buildApp } from '../src/app.js';
import { parseImportAmount, parseImportCurrency, parseImportDate, parseImportExchangeRate, parseImportPaid } from '../src/services/spreadsheet-import-rules.js';

describe('spreadsheet import value rules', () => {
  it('parses unambiguous Turkish and English amounts and rejects ambiguous separators', () => {
    expect(parseImportAmount('1.234,56')).toBe(1234.56);
    expect(parseImportAmount('1,234.56')).toBe(1234.56);
    expect(parseImportAmount('1 234,56 TL')).toBe(1234.56);
    expect(parseImportAmount(10.5)).toBe(10.5);
    for (const value of ['1.234', '1,234']) expect(() => parseImportAmount(value)).toThrowError(expect.objectContaining({ code: 'AMOUNT_AMBIGUOUS' }));
    expect(() => parseImportAmount('not-an-amount')).toThrowError(expect.objectContaining({ code: 'AMOUNT_INVALID' }));
    expect(() => parseImportAmount('0.001')).toThrowError(expect.objectContaining({ code: 'AMOUNT_PRECISION' }));
    expect(() => parseImportAmount('10USD20')).toThrowError(expect.objectContaining({ code: 'AMOUNT_INVALID' }));
  });

  it('rejects invalid dates instead of substituting the current date', () => {
    expect(parseImportDate('2026-01-02')).toBe('2026-01-02T00:00:00.000Z');
    expect(parseImportDate('02.01.2026')).toBe('2026-01-02T00:00:00.000Z');
    for (const value of ['2026-02-30', 'not-a-date', '']) expect(() => parseImportDate(value)).toThrowError(expect.objectContaining({ code: 'DATE_INVALID' }));
  });

  it('maps English and Turkish payment values conservatively', () => {
    expect(parseImportPaid('paid')).toBe(true);
    expect(parseImportPaid('ödendi')).toBe(true);
    expect(parseImportPaid('unpaid')).toBe(false);
    expect(parseImportPaid('not paid')).toBe(false);
    expect(parseImportPaid(undefined)).toBe(false);
    expect(() => parseImportPaid('maybe')).toThrowError(expect.objectContaining({ code: 'PAYMENT_INVALID' }));
  });

  it('uses an explicit currency column or the target project currency', () => {
    expect(parseImportCurrency('USD', 'EUR')).toBe('USD');
    expect(parseImportCurrency('$', 'EUR')).toBe('USD');
    expect(parseImportCurrency(undefined, 'EUR')).toBe('EUR');
    expect(parseImportCurrency(undefined, 'EUR', 'TRY 10.50')).toBe('TRY');
    expect(() => parseImportCurrency('USD', 'EUR', 'TRY 10.50')).toThrowError(expect.objectContaining({ code: 'CURRENCY_CONFLICT' }));
    expect(() => parseImportCurrency('TLR', 'EUR')).toThrowError(expect.objectContaining({ code: 'CURRENCY_INVALID' }));
  });

  it('requires a positive mapped exchange rate for foreign currencies', () => {
    expect(parseImportExchangeRate(undefined, 'EUR', 'EUR')).toBe(1);
    expect(parseImportExchangeRate('0,92', 'USD', 'EUR')).toBe(0.92);
    expect(() => parseImportExchangeRate(undefined, 'USD', 'EUR')).toThrowError(expect.objectContaining({ code: 'EXCHANGE_RATE_REQUIRED' }));
    expect(() => parseImportExchangeRate('0', 'USD', 'EUR')).toThrowError(expect.objectContaining({ code: 'EXCHANGE_RATE_INVALID' }));
    expect(() => parseImportExchangeRate('1.1', 'EUR', 'EUR')).toThrowError(expect.objectContaining({ code: 'EXCHANGE_RATE_INVALID' }));
  });
});

const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234' };
const workbook = (rows: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Synthetic');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })).toString('base64');
};

describe('spreadsheet import financial row reporting', () => {
  let app: any;
  afterEach(async () => { if (app) await app.close(); app = undefined; });

  it('imports only valid rows and reports every skipped row', async () => {
    app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
    const now = new Date().toISOString();
    app.db.insert(projects).values({ id: 'eur-project', name: 'Synthetic EUR project', budget: 0, currency: 'EUR', status: 'active', createdAt: now, updatedAt: now }).run();
    await app.userRepo.createUser({ username: 'import-rules-admin', email: 'import-rules-admin@example.test', fullName: 'Synthetic Admin', password: 'Synthetic-Password-1234', role: 'admin' }, app.config.masterKey);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: 'import-rules-admin', password: 'Synthetic-Password-1234' } });
    const token = JSON.parse(login.body).token;
    const rows = [
      ['Date', 'Title', 'Amount', 'Currency', 'Paid', 'Payer', 'Rate'],
      ['2026-01-01', 'TR amount', '1.234,56', 'EUR', 'ödendi', 'Synthetic payer'],
      ['2026-01-02', 'EN amount', '1,234.56', 'USD', 'unpaid', '', '0.92'],
      ['2026-01-03', 'Ambiguous amount', '1.234', 'EUR', 'paid', ''],
      ['2026-02-30', 'Invalid date', '10', 'EUR', 'paid', ''],
      ['2026-01-05', 'Unknown payment', '10', 'EUR', 'maybe', ''],
      ['2026-01-06', 'Fallback currency', '3', '', '', ''],
      ['2026-01-07', 'Unallocated paid company', '10', 'EUR', 'paid', ''],
      ['2026-01-08', '', '5', '', '', ''],
      ['2026-01-09', 'Missing rate', '5', 'USD', '', ''],
      ['2026-01-10', 'Invalid rate', '5', 'USD', '', '', '0'],
    ];
    const response = await app.inject({ method: 'POST', url: '/api/import/execute', headers: { authorization: 'Bearer ' + token }, payload: { base64: workbook(rows), projectId: 'eur-project', mapping: { dateCol: 0, titleCol: 1, amountCol: 2, currencyCol: 3, isPaidCol: 4, payerPersonCol: 5, exchangeRateCol: 6 } } });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.importedCount).toBe(3);
    expect(body.skippedRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ rowNumber: 4, code: 'AMOUNT_AMBIGUOUS' }),
      expect.objectContaining({ rowNumber: 5, code: 'DATE_INVALID' }),
      expect.objectContaining({ rowNumber: 6, code: 'PAYMENT_INVALID' }),
      expect.objectContaining({ rowNumber: 8, code: 'PAYMENT_ACCOUNT_REQUIRED' }),
      expect.objectContaining({ rowNumber: 9, code: 'TITLE_REQUIRED' }),
      expect.objectContaining({ rowNumber: 10, code: 'EXCHANGE_RATE_REQUIRED' }),
      expect.objectContaining({ rowNumber: 11, code: 'EXCHANGE_RATE_INVALID' }),
    ]));
    const imported = await app.transactionRepo.listTransactions({}, app.config.masterKey, app.config.blindIndexPepper);
    expect(imported).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'TR amount', amount: 1234.56, currency: 'EUR', isPaid: true, status: 'approved', paymentSource: 'person_out_of_pocket', date: '2026-01-01T00:00:00.000Z' }),
      expect.objectContaining({ title: 'EN amount', amount: 1234.56, currency: 'USD', exchangeRate: 0.92, baseAmount: 1135.8, isPaid: false, status: 'pending', date: '2026-01-02T00:00:00.000Z' }),
      expect.objectContaining({ title: 'Fallback currency', amount: 3, currency: 'EUR', isPaid: false, status: 'pending', date: '2026-01-06T00:00:00.000Z' }),
    ]));
    const audit = app.auditRepo.listAuditLogs(100, config.masterKey).filter((entry: any) => entry.entity === 'transaction' && entry.action === 'CREATE');
    expect(audit).toHaveLength(3);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });

  it.each(['B5:D6', 'A1:D6'])('reports physical row numbers for used range %s', async range => {
    app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
    const now = new Date().toISOString();
    app.db.insert(projects).values({ id: 'site', name: 'Synthetic project', budget: 0, currency: 'TRY', status: 'active', createdAt: now, updatedAt: now }).run();
    await app.userRepo.createUser({ username: 'offset-admin', email: 'offset-admin@example.test', fullName: 'Synthetic Admin', password: 'Synthetic-Password-1234', role: 'admin' }, config.masterKey);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: 'offset-admin', password: 'Synthetic-Password-1234' } });
    const sheet = XLSX.utils.aoa_to_sheet([['Date', 'Title', 'Amount'], ['bad date', 'Bad', '5']], { origin: 'B5' });
    sheet['!ref'] = range;
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheet, 'Offset');
    const data = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })).toString('base64');
    const token = JSON.parse(login.body).token;
    const analysis = await app.inject({ method: 'POST', url: '/api/import/analyze', headers: { authorization: 'Bearer ' + token }, payload: { base64: data } });
    const analyzedSheet = analysis.json().sheets[0];
    expect(analyzedSheet.totalRows).toBe(1);
    expect(analyzedSheet.sheetDigest).toMatch(/^[a-f0-9]{64}$/);
    const changed = await app.inject({ method: 'POST', url: '/api/import/execute', headers: { authorization: 'Bearer ' + token }, payload: {
      base64: workbook([['Date', 'Title', 'Amount'], ['2026-01-01', 'Changed row', 5]]),
      projectId: 'site', sheetDigest: analyzedSheet.sheetDigest, mapping: { dateCol: 0, titleCol: 1, amountCol: 2 },
    } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe('IMPORT_SHEET_CHANGED');
    expect(app.db.select().from(transactions).all()).toHaveLength(0);
    const offset = range === 'A1:D6' ? 1 : 0;
    const response = await app.inject({ method: 'POST', url: '/api/import/execute', headers: { authorization: 'Bearer ' + token }, payload: { base64: data, projectId: 'site', sheetDigest: analyzedSheet.sheetDigest, mapping: { dateCol: offset, titleCol: offset + 1, amountCol: offset + 2 } } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).skippedRows).toEqual([{ rowNumber: 6, code: 'DATE_INVALID' }]);
  });

  it('applies a paid company expense to the selected active wallet in the same transaction', async () => {
    app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
    const now = new Date().toISOString();
    app.db.insert(projects).values({ id: 'site', name: 'Synthetic project', budget: 0, currency: 'TRY', status: 'active', createdAt: now, updatedAt: now }).run();
    await app.userRepo.createUser({ username: 'wallet-admin', email: 'wallet-admin@example.test', fullName: 'Synthetic Admin', password: 'Synthetic-Password-1234', role: 'admin' }, app.config.masterKey);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: 'wallet-admin', password: 'Synthetic-Password-1234' } });
    const token = JSON.parse(login.body).token;
    const repo = new AccountRepository(app.db);
    const account = repo.createAccount({ name: 'Synthetic wallet', type: 'cash', currency: 'TRY', initialBalance: 100, projectId: 'site' }, config.masterKey, config.blindIndexPepper);
    const rows = [ ['Date', 'Title', 'Amount', 'Paid', 'Account'], ['2026-01-01', 'Paid expense', '12.50', 'paid', account.id] ];
    const response = await app.inject({ method: 'POST', url: '/api/import/execute', headers: { authorization: 'Bearer ' + token }, payload: { base64: workbook(rows), projectId: 'site', mapping: { dateCol: 0, titleCol: 1, amountCol: 2, isPaidCol: 3, accountFromCol: 4 } } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ importedCount: 1, skippedRows: [] });
    expect(repo.getAccountById(account.id, config.masterKey)?.balance).toBe(87.5);
  });

  it('does not create categories for invalid rows', async () => {
    app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
    const now = new Date().toISOString();
    app.db.insert(projects).values({ id: 'site', name: 'Synthetic project', budget: 0, currency: 'TRY', status: 'active', createdAt: now, updatedAt: now }).run();
    await app.userRepo.createUser({ username: 'invalid-admin', email: 'invalid-admin@example.test', fullName: 'Synthetic Admin', password: 'Synthetic-Password-1234', role: 'admin' }, app.config.masterKey);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: 'invalid-admin', password: 'Synthetic-Password-1234' } });
    const token = JSON.parse(login.body).token;
    const rows = [ ['Date', 'Title', 'Amount', 'Category', 'Paid'], ['2026-01-01', 'Invalid paid expense', '12.50', 'Do not create', 'paid'] ];
    const before = app.db.select().from(categories).all();
    const response = await app.inject({ method: 'POST', url: '/api/import/execute', headers: { authorization: 'Bearer ' + token }, payload: { base64: workbook(rows), projectId: 'site', mapping: { dateCol: 0, titleCol: 1, amountCol: 2, categoryCol: 3, isPaidCol: 4 } } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ importedCount: 0, skippedRows: [{ rowNumber: 2, code: 'PAYMENT_ACCOUNT_REQUIRED' }] });
    expect(app.db.select().from(categories).all()).toEqual(before);
    expect(app.db.select().from(transactions).all()).toHaveLength(0);
  });

  it('rejects payer and account conflicts and rolls back transaction plus audit on audit failure', async () => {
    app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
    const now = new Date().toISOString();
    app.db.insert(projects).values({ id: 'site', name: 'Synthetic project', budget: 0, currency: 'TRY', status: 'active', createdAt: now, updatedAt: now }).run();
    await app.userRepo.createUser({ username: 'atomic-admin', email: 'atomic-admin@example.test', fullName: 'Synthetic Admin', password: 'Synthetic-Password-1234', role: 'admin' }, app.config.masterKey);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: 'atomic-admin', password: 'Synthetic-Password-1234' } });
    const token = JSON.parse(login.body).token;
    const account = new AccountRepository(app.db).createAccount({ name: 'Synthetic wallet', type: 'cash', currency: 'TRY', initialBalance: 100, projectId: 'site' }, config.masterKey, config.blindIndexPepper);
    const conflict = await app.inject({ method: 'POST', url: '/api/import/execute', headers: { authorization: 'Bearer ' + token }, payload: { base64: workbook([['Date', 'Title', 'Amount', 'Paid', 'Payer', 'Account'], ['2026-01-01', 'Conflict', '10', 'paid', 'Person', account.id]]), projectId: 'site', mapping: { dateCol: 0, titleCol: 1, amountCol: 2, isPaidCol: 3, payerPersonCol: 4, accountFromCol: 5 } } });
    expect(conflict.statusCode).toBe(200);
    expect(JSON.parse(conflict.body).skippedRows[0]).toMatchObject({ code: 'PAYMENT_SOURCE_CONFLICT', rowNumber: 2 });
    app.db.$client.exec("CREATE TRIGGER fail_import_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'synthetic import audit failure'); END;");
    const before = { tx: app.db.select().from(transactions).all().length, cats: app.db.select().from(categories).all().length, audits: app.db.select().from(auditLogs).all().length };
    const payload = { base64: workbook([['Date', 'Title', 'Amount', 'Paid', 'Account'], ['2026-01-02', 'Rollback', '10', 'paid', account.id]]), projectId: 'site', mapping: { dateCol: 0, titleCol: 1, amountCol: 2, isPaidCol: 3, accountFromCol: 4 } };
    const failed = await app.inject({ method: 'POST', url: '/api/import/execute', headers: { authorization: 'Bearer ' + token }, payload });
    expect(failed.statusCode).toBe(500);
    expect({ tx: app.db.select().from(transactions).all().length, cats: app.db.select().from(categories).all().length, audits: app.db.select().from(auditLogs).all().length }).toEqual(before);
    expect(new AccountRepository(app.db).getAccountById(account.id, config.masterKey)?.balance).toBe(100);
    app.db.$client.exec('DROP TRIGGER fail_import_audit');
    const retry = await app.inject({ method: 'POST', url: '/api/import/execute', headers: { authorization: 'Bearer ' + token }, payload });
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(retry.body).importedCount).toBe(1);
    expect(new AccountRepository(app.db).getAccountById(account.id, config.masterKey)?.balance).toBe(90);
    expect(app.auditRepo.verifyChainIntegrity(config.masterKey).valid).toBe(true);
  });
});
