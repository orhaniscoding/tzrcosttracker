import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initDatabase, AccountRepository, TransactionRepository, AuditLogRepository } from "../src/index.js";
const KEY = "fake-master-key-for-tests-only-32!";
const PEPPER = "fake-pepper-for-tests-only";
const CAT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
describe("financial atomic repositories", () => {
  let db: any; let sqlite: any; let accounts: AccountRepository; let txs: TransactionRepository; let audit: AuditLogRepository;
  beforeEach(() => { const init = initDatabase({ path: ":memory:" }); db = init.db; sqlite = init.sqlite; accounts = new AccountRepository(db); txs = new TransactionRepository(db); audit = new AuditLogRepository(db); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); sqlite.close(); });
  const mkAccount = (name: string, bal: number) => accounts.createAccount({ name, type: "cash", currency: "TRY", initialBalance: bal } as any, KEY, PEPPER);
  const mkTx = (over: any = {}) => txs.createTransaction({ type: "expense", date: "2024-01-15T10:00:00.000Z", amount: 100, currency: "TRY", exchangeRate: 1, categoryId: CAT, title: "Test Harcama", paymentSource: "company_account", createdById: USER, ...over } as any, KEY, PEPPER);
  const COUNT_SQL = { transactions: "SELECT COUNT(*) AS c FROM transactions", audit_logs: "SELECT COUNT(*) AS c FROM audit_logs" } as const;
  const count = (t: keyof typeof COUNT_SQL) => (sqlite.prepare(COUNT_SQL[t]).get() as any).c;
  it("legacy awaited usage still works", async () => {
    const acc = await accounts.createAccount({ name: "Legacy", type: "cash", currency: "TRY", initialBalance: 50 } as any, KEY, PEPPER);
    expect(await accounts.adjustBalance(acc.id, 25, KEY)).toBe(75);
    expect((await accounts.getAccountById(acc.id, KEY))?.balance).toBe(75);
    const created = await txs.createTransaction({ type: "income", date: "2024-01-15T10:00:00.000Z", amount: 10, currency: "TRY", exchangeRate: 1, categoryId: CAT, title: "Legacy Gelir", createdById: USER } as any, KEY, PEPPER);
    expect(created.transaction.amount).toBe(10);
    const entry = await audit.logAction({ userId: USER, action: "CREATE", entity: "transaction", entityId: created.transaction.id, previousState: null, newState: { amount: 10 } }, KEY);
    expect(entry.hash).toBeTruthy(); expect(entry.previousHash).toBe("GENESIS");
  });
  it("transfer rolls back when target update trigger fails", () => {
    const from = mkAccount("Kaynak", 1000); const to = mkAccount("Hedef", 0);
    sqlite.exec("CREATE TRIGGER fail_target BEFORE UPDATE ON accounts WHEN NEW.name = char(72,101,100,101,102) BEGIN SELECT RAISE(ABORT, char(102,97,105,108)); END;");
    expect(() => accounts.executeInternalTransfer({ fromAccountId: from.id, toAccountId: to.id, amount: 300, exchangeRate: 1 } as any, KEY)).toThrow();
    expect(accounts.getAccountById(from.id, KEY)?.balance).toBe(1000);
    expect(accounts.getAccountById(to.id, KEY)?.balance).toBe(0);
  });
  it("OTO second insert failure rolls back both rows", () => {
    sqlite.exec("CREATE TRIGGER fail_oto_insert BEFORE INSERT ON transactions WHEN NEW.type = char(105,110,99,111,109,101) AND NEW.oto_kasa_transaction_id IS NOT NULL BEGIN SELECT RAISE(ABORT, char(102,97,105,108)); END;");
    expect(() => mkTx({ paymentSource: "person_out_of_pocket", payerPersonName: "Ali" })).toThrow();
    expect(count("transactions")).toBe(0);
  });
  it("OTO second update failure rolls back both rows", () => {
    const created = mkTx({ paymentSource: "person_out_of_pocket", payerPersonName: "Ali" });
    const mainId = created.transaction.id; const otoId = created.transaction.otoKasaTransactionId!;
    expect(otoId).toBeTruthy();
    sqlite.exec("CREATE TRIGGER fail_oto_update BEFORE UPDATE ON transactions WHEN OLD.type = char(105,110,99,111,109,101) AND OLD.oto_kasa_transaction_id IS NOT NULL BEGIN SELECT RAISE(ABORT, char(102,97,105,108)); END;");
    expect(() => txs.updateTransaction(mainId, { amount: 999 } as any, KEY, PEPPER)).toThrow();
    expect(txs.getTransactionById(mainId, KEY)?.amount).toBe(100);
    expect(txs.getTransactionById(otoId, KEY)?.amount).toBe(100);
  });
  it("outer tx rolls everything back on audit trigger", () => {
    const acc = mkAccount("Outer", 500);
    sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, char(102,97,105,108)); END;");
    expect(() => db.transaction(() => { txs.createTransaction({ type: "expense", date: "2024-01-15T10:00:00.000Z", amount: 40, currency: "TRY", exchangeRate: 1, categoryId: CAT, title: "Outer Tx", createdById: USER } as any, KEY, PEPPER); accounts.adjustBalance(acc.id, -40, KEY); audit.logAction({ userId: USER, action: "CREATE", entity: "transaction", entityId: "x", previousState: null, newState: {} }, KEY); }, { behavior: "immediate" })).toThrow();
    expect(count("transactions")).toBe(0); expect(count("audit_logs")).toBe(0);
    expect(accounts.getAccountById(acc.id, KEY)?.balance).toBe(500);
  });
  it("outer tx composes via savepoints when nothing fails", () => {
    const acc = mkAccount("OuterOK", 500);
    db.transaction(() => { txs.createTransaction({ type: "expense", date: "2024-01-15T10:00:00.000Z", amount: 40, currency: "TRY", exchangeRate: 1, categoryId: CAT, title: "Outer OK", createdById: USER } as any, KEY, PEPPER); accounts.adjustBalance(acc.id, -40, KEY); audit.logAction({ userId: USER, action: "CREATE", entity: "transaction", entityId: "y", previousState: null, newState: {} }, KEY); }, { behavior: "immediate" });
    expect(count("transactions")).toBe(1); expect(count("audit_logs")).toBe(1);
    expect(accounts.getAccountById(acc.id, KEY)?.balance).toBe(460);
  });
  it("many audit appends keep chain intact and rowid order", () => {
    const ids: string[] = []; vi.useFakeTimers(); vi.setSystemTime(new Date("2024-06-01T12:00:00.000Z"));
    for (let i = 0; i < 25; i++) { ids.push(audit.logAction({ userId: USER, action: "CREATE", entity: "item", entityId: "e" + i, previousState: null, newState: { i } }, KEY).id); }
    expect(audit.listAuditLogs(25, KEY)).toHaveLength(25); expect(audit.listAuditLogs(25, KEY).every((l: any) => l.timestamp === "2024-06-01T12:00:00.000Z")).toBe(true); vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z")); ids.push(audit.logAction({ userId: USER, action: "CREATE", entity: "item", entityId: "e25", previousState: null, newState: { i: 25 } }, KEY).id); const result = audit.verifyChainIntegrity(KEY);
    expect(result.valid).toBe(true); expect(result.count).toBe(26);
    expect(audit.listAuditLogs(30, KEY).map((l: any) => l.id)).toEqual([...ids].reverse()); const listed = audit.listAuditLogs(30, KEY); expect(listed[0].id).toBe(ids[25]); expect(listed[0].timestamp).toBe("2024-01-01T00:00:00.000Z"); expect(listed[1].timestamp).toBe("2024-06-01T12:00:00.000Z"); sqlite.prepare("UPDATE audit_logs SET previous_hash = ? WHERE id = ?").run("TAMPERED", ids[1]); const tampered = audit.verifyChainIntegrity(KEY); expect(tampered.valid).toBe(false); expect(tampered.corruptedAtId).toBe(ids[1]); expect(tampered.count).toBe(26); vi.useRealTimers();
  });
  it("Promise.all balance adjustments do not lose updates", async () => {
    const acc = mkAccount("Concurrent", 0);
    await Promise.all(Array.from({ length: 20 }, async () => accounts.adjustBalance(acc.id, 10, KEY)));
    expect(accounts.getAccountById(acc.id, KEY)?.balance).toBe(200);
  });
  it("paired soft-delete and restore stay together", () => {
    const created = mkTx({ paymentSource: "person_out_of_pocket", payerPersonName: "Veli" });
    expect(txs.softDeleteTransaction(created.transaction.id, KEY)).toBe(true);
    expect(txs.listTransactions({}, KEY, PEPPER).length).toBe(0);
    expect(txs.restoreTransaction(created.transaction.id, KEY)?.id).toBe(created.transaction.id);
    expect(txs.listTransactions({}, KEY, PEPPER).length).toBe(2);
  });
});
