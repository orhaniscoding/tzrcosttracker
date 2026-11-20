import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AccountRepository, accounts, authSessions, projectMemberships, projects, users, whiteLabelSettings } from '@cost-core/database';
import { buildApp } from '../src/app.js';
import { cashEffectOf, effectOf, isOtoKasaIncome, isRecognizedStatus } from '../src/financial-effects.js';
import { computeBalanceReport, computeSummaryReport } from '../src/financial-report.js';

// Synthetic values only; no filesystem DB, environment or external service access.
const config = { jwtSecret: 'test-jwt-secret-very-long-and-secure-1234', masterKey: 'test-master-key-32-bytes-long-1234', blindIndexPepper: 'test-pepper-for-blind-index-1234', bootstrapToken: 'synthetic-bootstrap-token-32chars' };
// Synthetic UUID project identifiers required by CreateTransactionSchema (projectId: z.string().uuid()).
const SITE1 = '11111111-1111-4111-8111-111111111111', SITE2 = '22222222-2222-4222-8222-222222222222';
let app: any;
afterEach(async () => { vi.restoreAllMocks(); if (app) { await app.close(); app = undefined; } });

async function setup() {
  app = await buildApp({ config, dbPath: ':memory:' }); await app.ready();
  const now = new Date().toISOString();
  for (const id of [SITE1, SITE2]) app.db.insert(projects).values({ id, name: id, budget: 0, currency: 'TRY', status: 'active', createdAt: now, updatedAt: now }).run();
  const tokens: Record<string, string> = {};
  for (const id of ['admin', 'member']) {
    const role = id === 'admin' ? 'admin' : 'manager';
    app.db.insert(users).values({ id, username: id, email: id + '@example.test', fullName: 'Synthetic', passwordHash: 'synthetic-hash', role, isActive: true, createdAt: now, updatedAt: now }).run();
    const session = app.sessionRepo.createSession(id);
    tokens[id] = app.jwt.sign({ id, username: id, role, sid: session.id, exp: session.expiresAt });
  }
  app.db.insert(projectMemberships).values({ userId: 'member', projectId: SITE1, createdAt: now }).run();
  const cat = await app.categoryRepo.createCategory({ name: 'Synthetic cost' });
  const headers = (actor = 'admin') => ({ authorization: 'Bearer ' + tokens[actor] });
  async function request(method: 'GET' | 'POST' | 'PUT', url: string, payload?: any, actor = 'admin') {
    return app.inject({ method, url: '/api/' + url, headers: headers(actor), ...(payload === undefined ? {} : { payload }) });
  }
  async function get(url: string, actor = 'admin') {
    const r = await request('GET', url, undefined, actor); expect(r.statusCode, r.body).toBe(200); return JSON.parse(r.body);
  }
  async function wallet(initialBalance: number, extra: any = {}) {
    const r = await request('POST', 'accounts', { name: 'Synthetic wallet', type: 'cash', currency: 'TRY', initialBalance, ...extra });
    expect(r.statusCode, r.body).toBe(201); return JSON.parse(r.body);
  }
  const txPayload = (extra: any = {}) => ({ type: 'expense', date: '2026-10-10T10:00:00.000Z', amount: 200, currency: 'TRY', categoryId: cat.id, title: 'Synthetic movement', ...extra });
  async function post(extra: any = {}) {
    const r = await request('POST', 'transactions', txPayload(extra)); expect(r.statusCode, r.body).toBe(201); return JSON.parse(r.body);
  }
  return { request, get, wallet, post, txPayload, cat };
}

describe('financial reconciliation HTTP', () => {
  it.each(['list', 'detail'])('uses one read transaction for fresh actor, scope and account %s', async endpoint => {
    const s = await setup(), w = await s.wallet(1000, { projectId: SITE1 });
    const access = app.projectAccess;
    const originalFresh = access.requireFreshActor, originalScope = access.resolveScopeInTx;
    const method = endpoint === 'list' ? 'listAccountsInScope' : 'getAccountInScope';
    const originalRead = AccountRepository.prototype[method];
    let currentTx: any; const order: string[] = [];
    vi.spyOn(access, 'requireFreshActor').mockImplementation(function (this: any, tx: any, ...args: any[]) {
      expect(tx).not.toBe(app.db); currentTx = tx; order.push('fresh');
      return originalFresh.call(this, tx, ...args);
    });
    vi.spyOn(access, 'resolveScopeInTx').mockImplementation(function (this: any, tx: any, ...args: any[]) {
      expect(tx).toBe(currentTx); order.push('scope');
      return originalScope.call(this, tx, ...args);
    });
    vi.spyOn(AccountRepository.prototype, method).mockImplementation(function (this: any, ...args: any[]) {
      expect(this.db).toBe(currentTx); order.push('read');
      return (originalRead as any).apply(this, args);
    } as any);
    const result = await s.get(endpoint === 'list' ? 'accounts' : 'accounts/' + w.id, 'member');
    if (endpoint === 'list') expect(result.some((account: any) => account.id === w.id)).toBe(true);
    else expect(result.id).toBe(w.id);
    expect(order).toEqual(['fresh', 'scope', 'read']);
  });

  it('does not reclassify paid history of an inactive wallet as unallocated cash', async () => {
    const s = await setup(), w = await s.wallet(1000);
    await s.post({ amount: 200, accountFromId: w.id });
    app.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, w.id)).run();
    expect(await s.get('reports/balance')).toMatchObject({ inactiveWalletBalanceTotal: 800, unallocatedCashTotal: 0, crossScopeWalletNetTotal: 0, actualCashInHand: 0 });
  });

  it('includes opening money exactly once, reconciles wallet-less cash, and separates period flows', async () => {
    const s = await setup(), w = await s.wallet(1000);
    await s.post({ accountFromId: w.id });
    expect((await s.get('accounts/' + w.id)).balance).toBe(800);
    expect(await s.get('reports/balance')).toMatchObject({ actualCashInHand: 800, walletBalanceTotal: 800, unallocatedCashTotal: 0, totalPaidExpense: 200, cashScopeMode: 'current' });
    await s.post({ type: 'income', amount: 100, accountToId: w.id });
    await s.post({ type: 'income', amount: 50 });
    await s.post({ amount: 20 });
    expect(await s.get('reports/balance')).toMatchObject({ actualCashInHand: 930, walletBalanceTotal: 900, unallocatedCashTotal: 30, totalIncome: 150, companyPaidExpenseTotal: 220 });
    const spy = vi.spyOn(AccountRepository.prototype, 'listAccountsInScope').mockImplementation(() => { throw new Error('Period must not read wallets'); });
    expect(await s.get('reports/balance?startDate=2026-10-10&endDate=2026-10-10')).toMatchObject({ actualCashInHand: -70, cashScopeMode: 'filtered_period', walletBalanceTotal: 0 });
    spy.mockRestore();
  });

  it('keeps internal transfers neutral and accounts for cards, other assets, pos and inactive wallets', async () => {
    const s = await setup();
    const cash = await s.wallet(100000), bank = await s.wallet(250000, { type: 'bank' });
    const r = await s.request('POST', 'accounts/transfer', { fromAccountId: bank.id, toAccountId: cash.id, amount: 30000 });
    expect(r.statusCode, r.body).toBe(200);
    expect(await s.get('reports/balance')).toMatchObject({ actualCashInHand: 350000, totalIncome: 0, totalPaidExpense: 0, totalTransactions: 0 });
    expect(await s.get('reports/summary')).toMatchObject({ totalIncome: 0, totalExpense: 0, transactionCount: 0 });
    const card = await s.wallet(0, { type: 'credit_card', creditLimit: 5000 });
    await s.post({ amount: 200, accountFromId: card.id });
    await s.wallet(40, { type: 'credit_card' });
    await s.wallet(25, { type: 'other' });
    await s.wallet(10, { type: 'pos' });
    const inactive = await s.wallet(9999);
    app.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, inactive.id)).run();
    expect(await s.get('reports/balance')).toMatchObject({ walletBalanceTotal: 350035, ccDebt: 200, ccCredit: 40, actualCashInHand: 349875 });
    expect(await s.get('accounts/liquidity/summary')).toMatchObject({ totalCashBase: 130000, totalBankBase: 220010, totalOtherBase: 25, totalLiquidAssets: 350035, totalCreditCardDebtBase: 200, totalCreditCardCreditBase: 40, netLiquidityAfterCC: 349875, accountCount: 7, activeAccountCount: 6, inactiveAccountCount: 1 });
  });

  it('treats an Oto-Kasa pair as one realized cost, not company cash or revenue', async () => {
    const s = await setup(); await s.wallet(1000);
    const pair = await s.post({ amount: 75, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic partner' });
    expect(pair.otoKasaTransaction).toBeDefined();
    for (const t of [pair.transaction, pair.otoKasaTransaction]) { expect(effectOf(t)).toBeNull(); expect(cashEffectOf(t)).toBe(0); }
    expect(await s.get('reports/balance')).toMatchObject({ actualCashInHand: 1000, totalIncome: 0, totalPaidExpense: 75, companyPaidExpenseTotal: 0, personFundedExpenseTotal: 75, totalTransactions: 1,
      personContributions: [{ personName: 'Synthetic partner', directKasaAmount: 0, otoKasaAmount: 75, totalAmount: 75, transactionCount: 1 }] });
    expect(await s.get('reports/summary')).toMatchObject({ totalIncome: 0, totalExpense: 75, netBalance: -75, transactionCount: 1, otoKasaExcludedTotal: 75 });
    expect(await s.get('reports/balance?startDate=2026-10-10')).toMatchObject({ actualCashInHand: 0, personFundedExpenseTotal: 75 });
  });

  it.each(['draft', 'pending_approval', 'rejected', 'cancelled'])('excludes %s even with explicit paid=true, preserving draft approval compatibility', async status => {
    const s = await setup(), w = await s.wallet(1000);
    const implicit = await s.post({ status, accountFromId: w.id });
    expect(implicit.transaction).toMatchObject({ status, isPaid: false });
    const explicit = await s.post({ status, isPaid: true, accountFromId: w.id });
    await s.post({ type: 'income', status, isPaid: true, amount: 900, accountToId: w.id });
    expect((await s.get('accounts/' + w.id)).balance).toBe(1000);
    expect(await s.get('reports/balance')).toMatchObject({ actualCashInHand: 1000, totalIncome: 0, totalPaidExpense: 0, totalPendingExpense: 0, totalTransactions: 0, excludedDraftOrRejectedCount: 3, personContributions: [] });
    expect(await s.get('reports/summary')).toMatchObject({ totalIncome: 0, totalExpense: 0, transactionCount: 0, categoryBreakdown: [], unrecognizedCount: 3 });
    const approved = await s.request('PUT', 'transactions/' + explicit.transaction.id, { status: 'approved' });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await s.get('accounts/' + w.id)).balance).toBe(800);
    expect(await s.get('reports/balance')).toMatchObject({ actualCashInHand: 800, totalPaidExpense: 200, totalTransactions: 1 });
  });

  it('normalizes POST payment defaults and rejects explicit recognized-state conflicts without effects', async () => {
    const s = await setup(), w = await s.wallet(1000);
    for (const extra of [{ status: 'paid', isPaid: false }, { status: 'pending', isPaid: true }]) {
      const r = await s.request('POST', 'transactions', s.txPayload({ accountFromId: w.id, ...extra })); expect(r.statusCode).toBe(400);
    }
    expect((await s.get('accounts/' + w.id)).balance).toBe(1000);
    expect(await s.get('reports/summary')).toMatchObject({ transactionCount: 0 });
    for (const extra of [{ status: 'pending' }, { isPaid: false }, { status: 'approved', isPaid: false }]) {
      expect((await s.post({ accountFromId: w.id, ...extra })).transaction).toMatchObject({ status: 'pending', isPaid: false });
    }
    expect((await s.post({ status: 'paid', accountFromId: w.id })).transaction).toMatchObject({ status: 'paid', isPaid: true });
    expect((await s.get('accounts/' + w.id)).balance).toBe(800);
    expect(await s.get('reports/balance')).toMatchObject({ totalPaidExpense: 200, totalPendingExpense: 600, actualCashInHand: 800, netPositionAfterDue: 200 });
  });

  it('counts only company unpaid obligations and uses inclusive UTC due-day boundaries', async () => {
    const s = await setup(); await s.wallet(1000);
    const today = new Date().toISOString().slice(0, 10);
    await s.post({ amount: 100, isPaid: false, dueDate: today + 'T23:59:59.999Z' });
    await s.post({ amount: 200, isPaid: false, dueDate: '2099-01-01T00:00:00.000Z' });
    await s.post({ amount: 50, isPaid: false });
    await s.post({ amount: 300, isPaid: false, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic person', dueDate: today + 'T00:00:00.000Z' });
    await s.post({ amount: 900, status: 'draft', dueDate: today + 'T00:00:00.000Z' });
    expect(await s.get('reports/balance')).toMatchObject({ totalPendingExpense: 350, overdueDebt: 100, actualCashInHand: 1000, netPositionAfterDue: 650, totalPaidExpense: 0 });
  });

  it('separates recognized pending revenue from realized cash and rounds native-currency money', async () => {
    const s = await setup(), w = await s.wallet(100);
    await s.post({ type: 'income', amount: 80, status: 'pending', accountToId: w.id, party: 'Synthetic contributor' });
    await s.post({ type: 'income', amount: 0.1, accountToId: w.id, party: 'Synthetic contributor' });
    await s.post({ type: 'income', amount: 0.2, party: 'Synthetic contributor' });
    expect((await s.get('accounts/' + w.id)).balance).toBe(100.1);
    expect(await s.get('reports/balance')).toMatchObject({ actualCashInHand: 100.3, totalIncome: 80.3, walletBalanceTotal: 100.1, unallocatedCashTotal: 0.2,
      personContributions: [{ personName: 'Synthetic contributor', directKasaAmount: 0.3, otoKasaAmount: 0, totalAmount: 0.3, transactionCount: 2 }] });
    expect(await s.get('reports/summary')).toMatchObject({ totalIncome: 80.3, netBalance: 80.3, transactionCount: 3 });
    expect(await s.get('reports/balance?startDate=2026-10-10')).toMatchObject({ actualCashInHand: 0.3 });
    // An unpaid person-funded expense only creates an unpaid Oto-Kasa reflection, so it is not realized person money yet.
    const unpaid = await s.post({ amount: 40, isPaid: false, paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic unpaid person' });
    expect(unpaid.otoKasaTransaction).toBeDefined();
    expect(unpaid.otoKasaTransaction.isPaid).toBe(false);
    expect(await s.get('reports/balance')).toMatchObject({ totalPaidExpense: 0, totalPendingExpense: 0, personFundedExpenseTotal: 0,
      personContributions: [{ personName: 'Synthetic contributor', directKasaAmount: 0.3, otoKasaAmount: 0, totalAmount: 0.3, transactionCount: 2 }] });
  });

  it('never adds TRY, USD and EUR, including when the configured base changes to USD', async () => {
    const s = await setup();
    for (const [currency, opening, expense, income] of [['TRY', 1000, 100, 20], ['USD', 500, 50, 10], ['EUR', 300, 30, 5]] as const) {
      const w = await s.wallet(opening, { currency });
      await s.post({ currency, amount: expense, accountFromId: w.id, exchangeRate: 37 });
      await s.post({ type: 'income', currency, amount: income, accountToId: w.id, exchangeRate: 37 });
    }
    const balance = await s.get('reports/balance'), summary = await s.get('reports/summary'), liquidity = await s.get('accounts/liquidity/summary');
    for (const report of [balance, summary, liquidity]) expect(report).toMatchObject({ baseCurrency: 'TRY', mixedCurrency: true, excludedCurrencies: ['EUR', 'USD'] });
    expect(balance).toMatchObject({ actualCashInHand: 920, totalIncome: 20, totalPaidExpense: 100, totalTransactions: 2 });
    expect(balance.byCurrency.USD).toMatchObject({ actualCashInHand: 460, totalIncome: 10, totalPaidExpense: 50 });
    expect(balance.byCurrency.EUR.actualCashInHand).toBe(275);
    expect(summary).toMatchObject({ totalIncome: 20, totalExpense: 100, netBalance: -80, transactionCount: 2 });
    expect(summary.byCurrency.USD).toMatchObject({ totalIncome: 10, totalExpense: 50, netBalance: -40, transactionCount: 2, categoryBreakdown: [{ name: 'Synthetic cost', amount: 50 }] });
    expect(liquidity.totalLiquidAssets).toBe(920); expect(liquidity.byCurrency.USD.totalLiquidAssets).toBe(460);
    app.db.insert(whiteLabelSettings).values({ id: 'global', baseCurrency: 'USD', updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: whiteLabelSettings.id, set: { baseCurrency: 'USD' } }).run();
    expect(await s.get('reports/balance')).toMatchObject({ baseCurrency: 'USD', excludedCurrencies: ['EUR', 'TRY'], actualCashInHand: 460, totalIncome: 10, totalPaidExpense: 50, totalTransactions: 2 });
    expect(await s.get('reports/summary')).toMatchObject({ baseCurrency: 'USD', totalIncome: 10, totalExpense: 50, netBalance: -40, transactionCount: 2 });
    expect(await s.get('accounts/liquidity/summary')).toMatchObject({ baseCurrency: 'USD', totalLiquidAssets: 460, accountCount: 3 });
    expect(await s.get('reports/balance?startDate=2026-10-10')).toMatchObject({ baseCurrency: 'USD', actualCashInHand: -40, cashScopeMode: 'filtered_period' });
  });

  it('isolates single-project wallets from global wallets, foreign projects and corrupted balances', async () => {
    const s = await setup();
    const global = await s.wallet(1000), site1 = await s.wallet(100, { projectId: SITE1 }), site2 = await s.wallet(200, { projectId: SITE2 });
    await s.post({ projectId: SITE1, accountFromId: site1.id, amount: 20 });
    expect(await s.get(`reports/balance?projectId=${SITE1}`)).toMatchObject({ actualCashInHand: 80, walletBalanceTotal: 80 });
    expect(await s.get('reports/balance')).toMatchObject({ actualCashInHand: 1280 });
    expect(await s.get('reports/balance', 'member')).toMatchObject({ actualCashInHand: 80 });
    expect(await s.get('accounts/liquidity/summary', 'member')).toMatchObject({ totalLiquidAssets: 80, accountCount: 1 });
    expect((await s.request('GET', `reports/balance?projectId=${SITE2}`, undefined, 'member')).statusCode).toBe(404);
    for (const w of [global, site2]) app.db.update(accounts).set({ balanceEncrypted: 'enc:v1:corrupt' }).where(eq(accounts.id, w.id)).run();
    expect(await s.get(`reports/balance?projectId=${SITE1}`)).toMatchObject({ actualCashInHand: 80 });
    expect(await s.get('reports/balance', 'member')).toMatchObject({ actualCashInHand: 80 });
    expect((await s.request('GET', 'reports/balance')).statusCode).toBe(500);
  });

  it('reads scoped wallets and base currency on the same synchronous report transaction', async () => {
    const s = await setup(); await s.wallet(100, { projectId: SITE1 });
    const original = app.projectAccess.requireFreshActor, list = AccountRepository.prototype.listAccountsInScope;
    let currentTx: any;
    app.projectAccess.requireFreshActor = function (tx: any, ...args: any[]) { currentTx = tx; expect(tx).not.toBe(app.db); return original.call(this, tx, ...args); };
    const spy = vi.spyOn(AccountRepository.prototype, 'listAccountsInScope').mockImplementation(function (this: any, ...args) {
      expect(this.db).toBe(currentTx); expect(args[0]).toEqual({ all: false, projectIds: [SITE1] });
      // Changing settings within this synthetic read transaction proves the helper
      // reads the same snapshot instead of a separately cached/default currency.
      currentTx.insert(whiteLabelSettings).values({ id: 'global', baseCurrency: 'USD', updatedAt: new Date().toISOString() }).onConflictDoUpdate({ target: whiteLabelSettings.id, set: { baseCurrency: 'USD' } }).run();
      return list.apply(this, args);
    });
    for (const url of [`reports/balance?projectId=${SITE1}`, `accounts/liquidity/summary?projectId=${SITE1}`]) expect(await s.get(url)).toMatchObject({ baseCurrency: 'USD' });
    expect(spy).toHaveBeenCalledTimes(2);
    app.projectAccess.requireFreshActor = original;
  });

  it('keeps cashless and wallet-linked effects disjoint, and legacy transfers P&L-neutral', async () => {
    const s = await setup();
    const base = { type: 'expense', amount: 25, currency: 'TRY', status: 'approved', isPaid: true, paymentSource: 'company_account', categoryId: s.cat.id };
    for (const type of ['expense', 'income']) for (const linked of [true, false]) {
      const t: any = { ...base, type, ...(linked ? (type === 'expense' ? { accountFromId: 'synthetic-wallet' } : { accountToId: 'synthetic-wallet' }) : {}) };
      const walletLinked = effectOf(t) !== null, unallocatedCash = effectOf(t) === null && cashEffectOf(t) !== 0;
      expect(walletLinked && unallocatedCash).toBe(false); expect(walletLinked || unallocatedCash).toBe(true);
    }
    expect(isRecognizedStatus('unknown')).toBe(false);
    expect(isOtoKasaIncome({ ...base, type: 'income', otoKasaTransactionId: 'synthetic-link' })).toBe(true);
    for (const t of [{ ...base, deletedAt: '2026-01-01' }, { ...base, status: 'draft' }, { ...base, type: 'income', status: 'pending' }, { ...base, paymentSource: 'person_out_of_pocket' }]) expect(cashEffectOf(t)).toBe(0);
    const transfer: any = { ...base, type: 'transfer', amount: 999 };
    expect(computeBalanceReport({ accounts: [], transactions: [transfer], baseCurrency: 'TRY', todayStr: '2026-11-13', isPeriodFiltered: false })).toMatchObject({ actualCashInHand: 0, totalIncome: 0, totalPaidExpense: 0, totalTransactions: 0 });
    expect(computeSummaryReport({ transactions: [transfer], categoryMap: new Map(), baseCurrency: 'TRY' })).toMatchObject({ totalIncome: 0, totalExpense: 0, transactionCount: 0 });
  });

  it('M2: flags a single non-base USD wallet and expense as mixed without adding either to TRY scalars', async () => {
    const s = await setup();
    const usd = await s.wallet(500, { currency: 'USD' });
    await s.post({ currency: 'USD', amount: 50, accountFromId: usd.id, exchangeRate: 37 });
    const balance = await s.get('reports/balance'), summary = await s.get('reports/summary'), liquidity = await s.get('accounts/liquidity/summary');
    for (const report of [balance, summary, liquidity]) expect(report).toMatchObject({ baseCurrency: 'TRY', mixedCurrency: true, excludedCurrencies: ['USD'] });
    expect(balance).toMatchObject({ actualCashInHand: 0, walletBalanceTotal: 0, totalIncome: 0, totalPaidExpense: 0, byCurrency: { USD: { actualCashInHand: 450 } } });
    expect(summary).toMatchObject({ totalIncome: 0, totalExpense: 0, netBalance: 0, transactionCount: 0, byCurrency: { USD: { totalExpense: 50, netBalance: -50 } } });
    expect(liquidity).toMatchObject({ totalLiquidAssets: 0, byCurrency: { USD: { totalCashBase: 450, totalLiquidAssets: 450 } } });
  });

  it('M1: keeps a cross-scope global wallet payment out of a site balance while reporting its net effect', async () => {
    const s = await setup();
    const global = await s.wallet(1000, { projectId: null }), site1 = await s.wallet(100, { projectId: SITE1 });
    await s.post({ projectId: SITE1, accountFromId: global.id, amount: 200 });
    expect((await s.get('accounts/' + global.id)).balance).toBe(800);
    expect((await s.get('accounts/' + site1.id)).balance).toBe(100);
    expect(await s.get('reports/balance')).toMatchObject({ actualCashInHand: 900, totalPaidExpense: 200, crossScopeWalletNetTotal: 0 });
    expect(await s.get(`reports/balance?projectId=${SITE1}`)).toMatchObject({ actualCashInHand: 100, totalPaidExpense: 200, crossScopeWalletNetTotal: -200 });
  });

  it('M3: reports inactive wallets in balance and liquidity without counting their money as liquid', async () => {
    const s = await setup();
    const active = await s.wallet(500), inactive = await s.wallet(9999);
    app.db.update(accounts).set({ isActive: false }).where(eq(accounts.id, inactive.id)).run();
    expect((await s.get('accounts/' + active.id)).balance).toBe(500);
    expect(await s.get('reports/balance')).toMatchObject({ actualCashInHand: 500, walletBalanceTotal: 500, inactiveAccountCount: 1, inactiveWalletBalanceTotal: 9999 });
    expect(await s.get('accounts/liquidity/summary')).toMatchObject({ totalLiquidAssets: 500, inactiveAccountCount: 1, inactiveWalletBalanceBase: 9999 });
  });

  it('L5: revalidates the fresh actor inside account read transactions and rejects revoked sessions', async () => {
    const s = await setup(), w = await s.wallet(500);
    const original = app.projectAccess.requireFreshActor;
    app.projectAccess.requireFreshActor = function (tx: any, ...args: any[]) {
      tx.update(authSessions).set({ revokedAt: Math.floor(Date.now() / 1000) }).where(eq(authSessions.id, args[1])).run();
      return original.call(this, tx, ...args);
    };
    try {
      for (const url of ['accounts', 'accounts/' + w.id]) {
        const r = await s.request('GET', url);
        expect(r.statusCode, r.body).toBe(401);
        expect(JSON.parse(r.body)).toMatchObject({ code: 'SESSION_INVALID' });
      }
    } finally { app.projectAccess.requireFreshActor = original; }
  });
});
