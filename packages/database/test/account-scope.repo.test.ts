import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { initDatabase, AccountRepository, accounts, projects } from '../src/index.js';
import { CreateAccountSchema } from '@cost-core/types';
import type { AccountReadScope } from '../src/index.js';
const KEY = 'unit-test-master-encryption-key-32b!';
const PEPPER = 'unit-test-blind-index-pepper-key!';
const ISO = '2024-01-15T10:00:00.000Z';
let db: any; let sqlite: any; let repo: AccountRepository;
function seedProject(id: string) { db.insert(projects).values({ id, name: 'Project ' + id, code: null, description: null, budget: 0, currency: 'TRY', status: 'active', createdAt: ISO, updatedAt: ISO }).run(); }
function mk(name: string, projectId?: string | null, balance = 100) { return repo.createAccount({ name, type: 'cash', currency: 'TRY', initialBalance: balance, ...(projectId === undefined ? {} : { projectId }) } as any, KEY, PEPPER); }
function setCreated(id: string, ts: string) { db.update(accounts).set({ createdAt: ts }).where(eq(accounts.id, id)).run(); }
beforeEach(() => { const init = initDatabase({ path: ':memory:' }); db = init.db; sqlite = init.sqlite; repo = new AccountRepository(db); seedProject('proj-a'); seedProject('proj-b'); seedProject(' site A/07 '); });
afterEach(() => { sqlite.close(); });
describe('AccountRepository project scope', () => {
  it('persists omitted as null, explicit project, and opaque spaced id without trimming', () => {
    const legacy = mk('legacy'); expect(legacy.projectId).toBeNull();
    const a = mk('a', 'proj-a'); expect(a.projectId).toBe('proj-a');
    const spaced = mk('spaced', ' site A/07 '); expect(spaced.projectId).toBe(' site A/07 ');
    const raw = db.select().from(accounts).where(eq(accounts.id, spaced.id)).all()[0]; expect(raw.projectId).toBe(' site A/07 ');
    expect(repo.getAccountById(legacy.id, KEY)!.projectId).toBeNull();
    expect(CreateAccountSchema.parse({ name: 'x', projectId: ' site A/07 ' }).projectId).toBe(' site A/07 ');
    expect(CreateAccountSchema.safeParse({ name: 'x', projectId: '   ' }).success).toBe(false);
    expect(CreateAccountSchema.safeParse({ name: 'x', projectId: '' }).success).toBe(false);
    expect(CreateAccountSchema.safeParse({ name: 'x', projectId: 'x'.repeat(129) }).success).toBe(false);
    expect(CreateAccountSchema.safeParse({ name: 'x', projectId: 'x'.repeat(128) }).success).toBe(true);
  });
  it('scoped list and detail only return requested independent projects, empty denies all', () => {
    const a = mk('a', 'proj-a'); const b = mk('b', 'proj-b'); const legacy = mk('legacy');
    setCreated(a.id, '2024-01-01T00:00:00.000Z'); setCreated(b.id, '2024-01-03T00:00:00.000Z'); setCreated(legacy.id, '2024-01-02T00:00:00.000Z');
    const a2 = mk('a2', 'proj-a'); setCreated(a2.id, '2024-01-04T00:00:00.000Z');
    expect(repo.listAccountsInScope({ all: false, projectIds: ['proj-a'] }, KEY).map((x: any) => x.id)).toEqual([a2.id, a.id]);
    expect(repo.listAccountsInScope({ all: false, projectIds: ['proj-b', 'proj-a'] }, KEY).map((x: any) => x.id)).toEqual([a2.id, b.id, a.id]);
    expect(repo.listAccountsInScope({ all: false, projectIds: [] }, KEY)).toEqual([]);
    expect(repo.listAccountsInScope({ all: true }, KEY).map((x: any) => x.id)).toEqual([a2.id, b.id, legacy.id, a.id]);
    expect(repo.listAccounts(KEY).map((x: any) => x.id)).toEqual([a2.id, b.id, legacy.id, a.id]);
    expect(repo.listAccounts(KEY).find((x: any) => x.id === legacy.id)!.projectId).toBeNull();
    expect(repo.getAccountInScope(b.id, { all: false, projectIds: ['proj-a'] }, KEY)).toBeNull();
    expect(repo.getAccountInScope(legacy.id, { all: false, projectIds: ['proj-a'] }, KEY)).toBeNull();
    expect(repo.getAccountInScope(a.id, { all: false, projectIds: [] }, KEY)).toBeNull();
    expect(repo.getAccountInScope(a.id, { all: false, projectIds: ['proj-a'] }, KEY)!.projectId).toBe('proj-a');
    expect(repo.getAccountInScope(legacy.id, { all: true }, KEY)!.projectId).toBeNull();
  });
  it('update clears on explicit null, preserves on absent or undefined', () => {
    const a = mk('a', 'proj-a');
    expect(repo.updateAccount(a.id, { name: 'a-renamed' }, KEY, PEPPER)!.projectId).toBe('proj-a');
    expect(repo.updateAccount(a.id, { projectId: undefined }, KEY, PEPPER)!.projectId).toBe('proj-a');
    expect(repo.updateAccount(a.id, { projectId: 'proj-b' }, KEY, PEPPER)!.projectId).toBe('proj-b');
    expect(repo.updateAccount(a.id, { projectId: null }, KEY, PEPPER)!.projectId).toBeNull();
    expect(repo.getAccountById(a.id, KEY)!.projectId).toBeNull();
    expect(repo.updateAccount(a.id, { projectId: 'proj-a' }, KEY, PEPPER)!.projectId).toBe('proj-a');
  });
  it('enforces real FK on create and update', () => {
    expect(() => mk('bad', 'missing-project')).toThrow();
    const a = mk('a', 'proj-a');
    expect(() => repo.updateAccount(a.id, { projectId: 'missing-project' }, KEY, PEPPER)).toThrow();
    expect(repo.getAccountById(a.id, KEY)!.projectId).toBe('proj-a');
  });
  it('trusted DTO paths keep projectId through transfer', () => {
    const a = mk('a', 'proj-a', 500); const b = mk('b', 'proj-b', 0);
    const t = repo.executeInternalTransfer({ fromAccountId: a.id, toAccountId: b.id, amount: 120 } as any, KEY);
    expect(t.fromAccount.projectId).toBe('proj-a'); expect(t.toAccount.projectId).toBe('proj-b');
    expect(t.fromAccount.balance).toBe(380); expect(t.toAccount.balance).toBe(120);
  });
  it('rolls back account writes inside caller transaction', () => {
    const a = mk('a', 'proj-a');
    expect(() => db.transaction(() => { const tmp = mk('temp', 'proj-b'); expect(repo.getAccountById(tmp.id, KEY)).not.toBeNull(); repo.updateAccount(a.id, { projectId: 'proj-b' }, KEY, PEPPER); throw new Error('synthetic-abort'); })).toThrow('synthetic-abort');
    expect(repo.listAccounts(KEY).map((x: any) => x.name)).toEqual(['a']);
    expect(repo.getAccountById(a.id, KEY)!.projectId).toBe('proj-a');
  });
  it('does not decrypt corrupt excluded wallet in scoped reads, allowed corrupt read fails', () => {
    const good = mk('good', 'proj-a', 42); const bad = mk('bad', 'proj-b', 99);
    db.update(accounts).set({ balanceEncrypted: 'enc:v1:000102030405060708090a0b:000102030405060708090a0b0c0d0e0f:deadbeef' }).where(eq(accounts.id, bad.id)).run();
    expect(repo.listAccountsInScope({ all: false, projectIds: ['proj-a'] }, KEY).map((x: any) => x.id)).toEqual([good.id]);
    expect(repo.getAccountInScope(bad.id, { all: false, projectIds: ['proj-a'] }, KEY)).toBeNull();
    expect(repo.getAccountInScope(good.id, { all: false, projectIds: ['proj-a'] }, KEY)!.balance).toBe(42);
    expect(() => repo.getAccountInScope(bad.id, { all: false, projectIds: ['proj-b'] }, KEY)).toThrow();
    expect(() => repo.getAccountInScope(bad.id, { all: true }, KEY)).toThrow();
    expect(() => repo.listAccountsInScope({ all: false, projectIds: ['proj-b'] }, KEY)).toThrow();
    expect(() => repo.listAccounts(KEY)).toThrow();
  });
});
