import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { initDatabase, TransactionRepository, transactions } from '../src/index.js';
import type { TransactionReadScope } from '../src/index.js';
const KEY = 'unit-test-master-encryption-key-32b!';
const PEPPER = 'unit-test-blind-index-pepper-key!';
const CAT = 'cat-1';
const USER = 'user-1';
let db: any; let sqlite: any; let repo: TransactionRepository;
function mk(title: string, projectId: string | null, over: any = {}) { const input: any = { type: 'expense', date: '2024-01-15T10:00:00.000Z', amount: 100, currency: 'TRY', exchangeRate: 1, categoryId: CAT, title, createdById: USER, ...over }; if (projectId !== undefined) input.projectId = projectId; return repo.createTransaction(input, KEY, PEPPER).transaction; }
const scopeA: TransactionReadScope = { all: false, projectIds: ['proj-a'] };
const scopeAB: TransactionReadScope = { all: false, projectIds: ['proj-a', 'proj-b'] };
beforeEach(() => { const init = initDatabase({ path: ':memory:' }); db = init.db; sqlite = init.sqlite; repo = new TransactionRepository(db); });
afterEach(() => { sqlite.close(); });
describe('TransactionRepository project scope', () => {
  it('returns two allowed projects, denies third and null-project', () => {
    const a = mk('A1', 'proj-a', { date: '2024-01-10T10:00:00.000Z' });
    const b = mk('B1', 'proj-b', { date: '2024-01-12T10:00:00.000Z' });
    const c = mk('C1', 'proj-c', { date: '2024-01-13T10:00:00.000Z' });
    const legacy = mk('Legacy', null, { date: '2024-01-11T10:00:00.000Z' });
    expect(repo.listTransactionsInScope({}, scopeAB, KEY, PEPPER).map((x: any) => x.id)).toEqual([b.id, a.id]);
    expect(repo.listTransactionsInScope({}, { all: true }, KEY, PEPPER).map((x: any) => x.id)).toEqual([c.id, b.id, legacy.id, a.id]);
    expect(repo.getTransactionInScope(c.id, scopeAB, KEY)).toBeNull();
    expect(repo.getTransactionInScope(legacy.id, scopeAB, KEY)).toBeNull();
    expect(repo.getTransactionInScope(a.id, scopeA, KEY)!.title).toBe('A1');
    expect(repo.getTransactionInScope(legacy.id, { all: true }, KEY)!.projectId).toBeNull();
  });
  it('empty and malformed scopes deny all without throwing to global', () => {
    const a = mk('A1', 'proj-a');
    const bad: any[] = [{ all: false, projectIds: [] }, { all: false, projectIds: [''] }, { all: false, projectIds: ['   '] }, { all: false, projectIds: ['x'.repeat(129)] }, { all: false, projectIds: [123] }, { all: false, projectIds: [null] }, { all: false }, { all: 'yes' }, null, undefined, {}, { all: false, projectIds: 'proj-a' }];
    for (const s of bad) { expect(repo.listTransactionsInScope({}, s, KEY, PEPPER)).toEqual([]); expect(repo.getTransactionInScope(a.id, s, KEY)).toBeNull(); expect(repo.listTrashInScope(s, KEY)).toEqual([]); expect(repo.checkDuplicateInScope({ title: 'A1', date: '2024-01-15T10:00:00.000Z', projectId: 'proj-a' } as any, s, PEPPER)).toEqual({ isDuplicate: false }); }
    expect(repo.listTransactionsInScope({}, { all: false, projectIds: ['x'.repeat(128)] }, KEY, PEPPER)).toEqual([]);
  });
  it('explicit filter intersects scope, never overrides', () => {
    const a = mk('A1', 'proj-a');
    const b = mk('B1', 'proj-b');
    expect(repo.listTransactionsInScope({ projectId: 'proj-b' }, scopeA, KEY, PEPPER)).toEqual([]);
    expect(repo.listTransactionsInScope({ projectId: 'proj-a' }, scopeAB, KEY, PEPPER).map((x: any) => x.id)).toEqual([a.id]);
    expect(repo.listTransactionsInScope({ projectId: 'proj-c' }, { all: true }, KEY, PEPPER)).toEqual([]);
    expect(repo.listTransactionsInScope({ projectId: 'proj-b' }, scopeAB, KEY, PEPPER).map((x: any) => x.id)).toEqual([b.id]);
  });
  it('preserves opaque spaced ID', () => {
    const spaced = mk('Spaced', ' site A/07 ');
    expect(spaced.projectId).toBe(' site A/07 ');
    expect(repo.listTransactionsInScope({}, { all: false, projectIds: [' site A/07 '] }, KEY, PEPPER).map((x: any) => x.id)).toEqual([spaced.id]);
    expect(repo.listTransactionsInScope({}, { all: false, projectIds: ['site A/07'] }, KEY, PEPPER)).toEqual([]);
    expect(repo.getTransactionInScope(spaced.id, { all: false, projectIds: [' site A/07 '] }, KEY)!.id).toBe(spaced.id);
  });
  it('legacy wrappers are equivalent to all:true', () => {
    const a = mk('A1', 'proj-a'); mk('B1', 'proj-b');
    expect(repo.listTransactions({}, KEY, PEPPER)).toEqual(repo.listTransactionsInScope({}, { all: true }, KEY, PEPPER));
    expect(repo.getTransactionById(a.id, KEY)).toEqual(repo.getTransactionInScope(a.id, { all: true }, KEY));
    repo.softDeleteTransaction(a.id, KEY);
    expect(repo.listTrash(KEY)).toEqual(repo.listTrashInScope({ all: true }, KEY));
    expect(repo.listTransactions({}, KEY, PEPPER).map((x: any) => x.id)).not.toContain(a.id);
    expect(repo.listTransactions({ includeDeleted: true }, KEY, PEPPER).map((x: any) => x.id)).toContain(a.id);
    expect(repo.getTransactionById(a.id, KEY)).toBeNull();
    expect(repo.getTransactionById(a.id, KEY, true)!.id).toBe(a.id);
    expect(repo.getTransactionInScope(a.id, scopeA, KEY)).toBeNull();
    expect(repo.getTransactionInScope(a.id, scopeA, KEY, true)!.id).toBe(a.id);
  });

  it('preserves filters, order, deleted and trash behavior', () => {
    const a1 = mk('Shared', 'proj-a', { date: '2024-01-10T10:00:00.000Z', categoryId: 'cat-1', type: 'expense', status: 'approved', isPaid: true, party: 'PartyX' });
    const a2 = mk('Other', 'proj-a', { date: '2024-01-12T10:00:00.000Z', categoryId: 'cat-2', subcategoryId: 'sub-1', type: 'income', status: 'pending', isPaid: false });
    const a3 = mk('Shared', 'proj-a', { date: '2024-01-11T10:00:00.000Z', categoryId: 'cat-1', type: 'expense', status: 'approved', isPaid: true, party: 'PartyY' });
    expect(repo.listTransactionsInScope({}, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a2.id, a3.id, a1.id]);
    expect(repo.listTransactionsInScope({ categoryId: 'cat-1' }, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a3.id, a1.id]);
    expect(repo.listTransactionsInScope({ subcategoryId: 'sub-1' }, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a2.id]);
    expect(repo.listTransactionsInScope({ type: 'income' }, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a2.id]);
    expect(repo.listTransactionsInScope({ status: 'pending' }, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a2.id]);
    expect(repo.listTransactionsInScope({ isPaid: false }, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a2.id]);
    expect(repo.listTransactionsInScope({ startDate: '2024-01-11T00:00:00.000Z', endDate: '2024-01-12T23:59:59.999Z' }, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a2.id, a3.id]);
    expect(repo.listTransactionsInScope({ searchTitle: 'Shared' }, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a3.id, a1.id]);
    expect(repo.listTransactionsInScope({ searchParty: 'PartyX' }, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a1.id]);
    repo.softDeleteTransaction(a2.id, KEY);
    expect(repo.listTransactionsInScope({}, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a3.id, a1.id]);
    expect(repo.listTransactionsInScope({ includeDeleted: true }, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([a2.id, a3.id, a1.id]);
    expect(repo.listTrashInScope(scopeA, KEY).map((x: any) => x.id)).toEqual([a2.id]);
    expect(repo.listTrashInScope({ all: false, projectIds: ['proj-b'] }, KEY)).toEqual([]);
    expect(repo.listTrash(KEY).map((x: any) => x.id)).toEqual([a2.id]);
  });
  it('excluded malformed ciphertext causes no decrypt or error, allowed still throws', () => {
    const good = mk('Good', 'proj-a');
    const bad = mk('Bad', 'proj-b');
    db.update(transactions).set({ amountEncrypted: 'enc:v1:000102030405060708090a0b:000102030405060708090a0b0c0d0e0f:deadbeef' }).where(eq(transactions.id, bad.id)).run();
    expect(repo.listTransactionsInScope({}, scopeA, KEY, PEPPER).map((x: any) => x.id)).toEqual([good.id]);
    expect(repo.getTransactionInScope(bad.id, scopeA, KEY)).toBeNull();
    expect(repo.listTrashInScope(scopeA, KEY)).toEqual([]);
    db.update(transactions).set({ deletedAt: '2024-02-01T00:00:00.000Z' }).where(eq(transactions.id, bad.id)).run();
    expect(repo.listTrashInScope(scopeA, KEY)).toEqual([]);
    expect(() => repo.getTransactionInScope(bad.id, { all: false, projectIds: ['proj-b'] }, KEY, true)).toThrow();
    expect(() => repo.listTransactionsInScope({ includeDeleted: true }, { all: false, projectIds: ['proj-b'] }, KEY, PEPPER)).toThrow();
    expect(() => repo.listTransactionsInScope({ includeDeleted: true }, { all: true }, KEY, PEPPER)).toThrow();
  });

  it('duplicate applies scope before match and never reveals excluded id', () => {
    const a = mk('DupTitle', 'proj-a');
    const b = mk('DupTitle', 'proj-b');
    const legacy = mk('DupTitle', null);
    const inputA: any = { title: 'DupTitle', date: '2024-01-15T10:00:00.000Z', amount: 999, categoryId: CAT, projectId: 'proj-a' };
    expect(repo.checkDuplicateInScope(inputA, scopeA, PEPPER)).toEqual({ isDuplicate: true, existingTransactionId: a.id });
    expect(repo.checkDuplicateInScope(inputA, { all: false, projectIds: ['proj-b'] }, PEPPER)).toEqual({ isDuplicate: false });
    expect(repo.checkDuplicateInScope({ ...inputA, projectId: 'proj-b' }, scopeA, PEPPER)).toEqual({ isDuplicate: false });
    const noProj: any = { title: 'DupTitle', date: '2024-01-15T10:00:00.000Z', amount: 999, categoryId: CAT };
    expect(repo.checkDuplicateInScope(noProj, scopeA, PEPPER)).toEqual({ isDuplicate: true, existingTransactionId: a.id });
    expect(repo.checkDuplicateInScope(noProj, { all: false, projectIds: ['proj-b'] }, PEPPER)).toEqual({ isDuplicate: true, existingTransactionId: b.id });
    expect(repo.checkDuplicateInScope(noProj, { all: true }, PEPPER).isDuplicate).toBe(true);
    expect(repo.checkDuplicate(noProj, PEPPER).isDuplicate).toBe(true);
    expect(repo.checkDuplicateInScope(noProj, { all: false, projectIds: [] } as any, PEPPER)).toEqual({ isDuplicate: false });
    expect(repo.checkDuplicateInScope({ ...noProj, date: '2024-01-16T10:00:00.000Z' }, { all: true }, PEPPER)).toEqual({ isDuplicate: false });
    const all = repo.checkDuplicateInScope(noProj, { all: true }, PEPPER); expect([a.id, b.id, legacy.id]).toContain(all.existingTransactionId);
    expect(repo.listTransactionsInScope({}, { all: false, projectIds: ['proj-a', 'proj-b'] }, KEY, PEPPER).map((x: any) => x.id)).not.toContain(legacy.id);
  });
  it('caller transaction rollback with repository bound to tx remains usable', () => {
    let innerId = '';
    expect(() => db.transaction((tx: any) => { const txRepo = new TransactionRepository(tx); innerId = txRepo.createTransaction({ type: 'expense', date: '2024-01-15T10:00:00.000Z', amount: 50, currency: 'TRY', exchangeRate: 1, categoryId: CAT, title: 'Temp', projectId: 'proj-a', createdById: USER } as any, KEY, PEPPER).transaction.id; expect(txRepo.getTransactionInScope(innerId, scopeA, KEY)).not.toBeNull(); expect(txRepo.listTransactionsInScope({}, scopeA, KEY, PEPPER).length).toBe(1); throw new Error('synthetic-abort'); })).toThrow('synthetic-abort');
    expect(repo.getTransactionInScope(innerId, scopeA, KEY)).toBeNull();
    expect(repo.listTransactionsInScope({}, scopeA, KEY, PEPPER)).toEqual([]);
    const after = mk('After', 'proj-a'); expect(repo.getTransactionInScope(after.id, scopeA, KEY)!.title).toBe('After');
  });

  it('duplicate legacy-only row is visible only to all:true', () => {
    const legacy = mk('OnlyLegacy', null);
    const inp: any = { title: 'OnlyLegacy', date: '2024-01-15T10:00:00.000Z', amount: 1, categoryId: CAT };
    expect(repo.checkDuplicateInScope(inp, scopeAB, PEPPER)).toEqual({ isDuplicate: false });
    expect(repo.checkDuplicateInScope(inp, { all: true }, PEPPER)).toEqual({ isDuplicate: true, existingTransactionId: legacy.id });
  });
  it('OTO two rows remain intact and both only in same project scope', () => {
    const res = repo.createTransaction({ type: 'expense', date: '2024-01-15T10:00:00.000Z', amount: 75, currency: 'TRY', exchangeRate: 1, categoryId: CAT, title: 'OtoSpend', projectId: 'proj-a', paymentSource: 'person_out_of_pocket', payerPersonName: 'Person One', createdById: USER } as any, KEY, PEPPER);
    expect(res.otoKasaTransaction).toBeDefined();
    const main = res.transaction; const oto: any = res.otoKasaTransaction;
    expect(main.otoKasaTransactionId).toBe(oto.id); expect(oto.otoKasaTransactionId).toBe(main.id);
    expect(main.projectId).toBe('proj-a'); expect(oto.projectId).toBe('proj-a');
    const scoped = repo.listTransactionsInScope({}, scopeA, KEY, PEPPER);
    expect(scoped.map((x: any) => x.id).sort()).toEqual([main.id, oto.id].sort());
    expect(repo.listTransactionsInScope({}, { all: false, projectIds: ['proj-b'] }, KEY, PEPPER)).toEqual([]);
    expect(repo.getTransactionInScope(main.id, scopeA, KEY)!.otoKasaTransactionId).toBe(oto.id);
    expect(repo.getTransactionInScope(oto.id, scopeA, KEY)!.otoKasaTransactionId).toBe(main.id);
    expect(repo.getTransactionInScope(oto.id, { all: false, projectIds: ['proj-b'] }, KEY)).toBeNull();
    const all = repo.listTransactionsInScope({}, { all: true }, KEY, PEPPER); expect(all.map((x: any) => x.id).sort()).toEqual([main.id, oto.id].sort());
  });
});

