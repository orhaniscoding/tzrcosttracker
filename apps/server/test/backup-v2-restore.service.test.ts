import { createDecipheriv } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlindIndex, deriveKey, encryptField } from '@cost-core/crypto';
import { AuditLogRepository, initDatabase } from '@cost-core/database';
import { BACKUP_V2_TABLE_NAMES, BackupV2Error, buildFullBackupV2 } from '../src/services/backup-v2-export.service.js';
import { buildApp } from '../src/app.js';
import { restoreFullBackupV2 } from '../src/services/backup-v2-restore.service.js';

vi.mock('@cost-core/database', async (importOriginal) => {
  const real = await importOriginal<typeof import('@cost-core/database')>();
  return { ...real, initDatabase: vi.fn(real.initDatabase) };
});

const timestamp = '2026-06-01T12:00:00.000Z';
const restoredAt = new Date('2026-06-02T12:00:00.000Z');
const password = 'synthetic backup password';
const sourceMaster = Buffer.alloc(32, 23);
const sourcePepper = Buffer.alloc(32, 47);
const open = new Set<ReturnType<typeof initDatabase>['sqlite']>();

function rawPlaintext(ciphertext: string, key: Buffer): string {
  const [, , nonce, tag, encoded] = ciphertext.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encoded, 'hex')), decipher.final()]).toString('utf8');
}

function fixture() {
  const source = initDatabase({ path: ':memory:' });
  const { sqlite } = source;
  open.add(sqlite);
  const encrypt = (value: string) => encryptField(value, sourceMaster);
  const index = (value: string) => createBlindIndex(value, sourcePepper);
  sqlite.prepare(`INSERT INTO users (id, username, email, full_name, password_hash, role,
    two_factor_enabled, two_factor_secret, two_factor_backup_codes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('u', 'example', 'example@example.test',
    'Example User', 'synthetic-hash', 'admin', 1, encrypt('SYNTHETICTOTP'), '["synthetic-hash"]', timestamp, timestamp);
  sqlite.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run('p', 'Example Project', timestamp, timestamp);
  sqlite.prepare(`INSERT INTO project_memberships (user_id, project_id, created_at) VALUES (?, ?, ?)`)
    .run('u', 'p', timestamp);
  sqlite.prepare(`INSERT INTO parties (id, name, name_blind_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('party', ' Örnek Cari ', index(' Örnek Cari '), timestamp, timestamp);
  const wallet = sqlite.prepare(`INSERT INTO accounts (id, name, name_blind_index, balance_encrypted,
    project_id, iban_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  wallet.run('a', 'Wallet A', index('Wallet A'), encrypt('1.00'), 'p', encrypt('SYNTHETIC-IBAN'), timestamp, timestamp);
  wallet.run('b', 'Wallet B', index('Wallet B'), encrypt('2'), 'p', null, timestamp, timestamp);
  sqlite.prepare(`INSERT INTO custom_fields (id, name, label, type, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('cf', 'precision', 'Precision', 'number', timestamp);
  const category = sqlite.prepare(`INSERT INTO categories (id, name, parent_id, custom_field_ids, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  category.run('c', 'Parent', null, '[]', timestamp, timestamp);
  category.run('c2', 'Child', 'c', '["cf"]', timestamp, timestamp);
  const transaction = sqlite.prepare(`INSERT INTO transactions (id, project_id, type, date, amount_encrypted,
    base_amount_encrypted, category_id, subcategory_id, title_encrypted, title_blind_index, description_encrypted,
    party_encrypted, party_blind_index, account_from_id, account_to_id, payment_source, oto_kasa_transaction_id,
    custom_values_encrypted, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  transaction.run('t', 'p', 'expense', '2026-06-01', encrypt('7.00'), encrypt('7.00'), 'c', 'c2',
    encrypt('"123"'), index('"123"'), encrypt('null'), encrypt(' Örnek Cari '), index(' Örnek Cari '),
    'a', null, 'company_account', null, encrypt('{"cf":1.00}'), 'u', timestamp, timestamp);
  transaction.run('transfer', 'p', 'transfer', '2026-06-01', encrypt('1'), encrypt('1'), 'c', null,
    encrypt('Transfer'), index('Transfer'), null, null, '', 'a', 'b', 'company_account', null, '', 'u', timestamp, timestamp);
  transaction.run('oto-main', 'p', 'expense', '2026-06-01', encrypt('1'), encrypt('1'), 'c', null,
    encrypt('Expense'), index('Expense'), null, null, null, null, null, 'person_out_of_pocket', 'oto-pair', '', 'u', timestamp, timestamp);
  transaction.run('oto-pair', 'p', 'income', '2026-06-01', encrypt('1'), encrypt('1'), 'c', null,
    encrypt('Contribution'), index('Contribution'), null, null, '', null, null, 'person_out_of_pocket', 'oto-main', '', 'u', timestamp, timestamp);
  sqlite.prepare(`INSERT INTO white_label_settings (id, company_name, updated_at) VALUES (?, ?, ?)`)
    .run('global', 'Synthetic Company', timestamp);
  const session = sqlite.prepare(`INSERT INTO auth_sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)`);
  session.run('open', 'u', 1_780_000_000, 1_880_000_000, null);
  session.run('closed', 'u', 1_780_000_000, 1_880_000_000, 1_780_000_100);
  const audit = new AuditLogRepository(source.db);
  audit.logAction({ userId: 'u', action: 'CREATE', entity: 'transaction', entityId: 't', newState: { text: 'Örnek 🙂' } }, sourceMaster);
  audit.logAction({ userId: 'u', action: 'UPDATE', entity: 'transaction', entityId: 't', previousState: { rate: '1.00' } }, sourceMaster);
  return source;
}

async function makeVault(sqlite: ReturnType<typeof initDatabase>['sqlite'], pepper = sourcePepper) {
  const { vault } = await buildFullBackupV2({ sqlite, password, masterKey: sourceMaster, blindIndexPepper: pepper });
  return vault;
}

function tableCounts(sqlite: ReturnType<typeof initDatabase>['sqlite']) {
  return BACKUP_V2_TABLE_NAMES.map((name) => sqlite.prepare(`SELECT count(*) FROM "${name}"`).pluck().get());
}

afterEach(() => {
  for (const sqlite of open) if (sqlite.open) sqlite.close();
  open.clear();
  vi.mocked(initDatabase).mockClear();
});

describe('V2 staged restore', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'restores all tables and rekeys with changed master %s and changed pepper %s', async (changeMaster, changePepper) => {
      const source = fixture();
      const masterKey = changeMaster ? Buffer.alloc(32, 79) : Buffer.from(sourceMaster);
      const blindIndexPepper = changePepper ? Buffer.alloc(32, 91) : Buffer.from(sourcePepper);
      const expectedMaster = Buffer.from(masterKey);
      const expectedPepper = Buffer.from(blindIndexPepper);
      const vaultData = await makeVault(source.sqlite);
      const result = await restoreFullBackupV2({ vaultData, password, masterKey, blindIndexPepper, now: restoredAt });
      expect(result.missingWalletReferences).toBe(0);
      const { sqlite, db } = result.database;
      open.add(sqlite);
      expect(sqlite).not.toBe(source.sqlite);
      expect(sqlite.memory).toBe(true);
      expect(tableCounts(sqlite)).toEqual([1, 1, 1, 1, 2, 2, 1, 4, 2, 1, 2]);
      expect(Object.values(result.tableCounts)).toEqual(tableCounts(source.sqlite));
      expect(result.revokedSessions).toBe(1);
      expect(sqlite.prepare('SELECT id, revoked_at FROM auth_sessions ORDER BY rowid').all()).toEqual([
        { id: 'open', revoked_at: restoredAt.getTime() / 1000 }, { id: 'closed', revoked_at: 1_780_000_100 },
      ]);
      expect(source.sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?').pluck().get('open')).toBeNull();
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      const restored = sqlite.prepare('SELECT * FROM transactions WHERE id = ?').get('t') as Record<string, string>;
      expect(rawPlaintext(restored.title_encrypted, masterKey)).toBe('"123"');
      expect(rawPlaintext(restored.description_encrypted, masterKey)).toBe('null');
      expect(rawPlaintext(restored.custom_values_encrypted, masterKey)).toBe('{"cf":1.00}');
      expect(rawPlaintext(restored.amount_encrypted, masterKey)).toBe('7.00');
      const wallet = sqlite.prepare('SELECT * FROM accounts WHERE id = ?').get('a') as Record<string, string>;
      expect(rawPlaintext(wallet.balance_encrypted, masterKey)).toBe('1.00');
      expect(rawPlaintext(wallet.iban_encrypted, masterKey)).toBe('SYNTHETIC-IBAN');
      const secret = sqlite.prepare('SELECT two_factor_secret FROM users').pluck().get() as string;
      expect(rawPlaintext(secret, masterKey)).toBe('SYNTHETICTOTP');
      if (changeMaster) expect(() => rawPlaintext(restored.title_encrypted, sourceMaster)).toThrow();
      expect(restored.title_blind_index).toBe(createBlindIndex('"123"', blindIndexPepper));
      expect(restored.party_blind_index).toBe(createBlindIndex(' Örnek Cari ', blindIndexPepper));
      expect(sqlite.prepare('SELECT name_blind_index FROM parties').pluck().get()).toBe(createBlindIndex(' Örnek Cari ', blindIndexPepper));
      expect(wallet.name_blind_index).toBe(createBlindIndex('Wallet A', blindIndexPepper));
      expect(wallet.credit_limit_encrypted).toBeNull();
      expect(sqlite.prepare('SELECT custom_values_encrypted, party_encrypted, party_blind_index FROM transactions WHERE id = ?').get('transfer'))
        .toEqual({ custom_values_encrypted: '', party_encrypted: null, party_blind_index: '' });
      const auditRows = (connection: typeof sqlite) => connection.prepare('SELECT id, hash, previous_hash FROM audit_logs ORDER BY rowid').all();
      expect(auditRows(sqlite)).toEqual(auditRows(source.sqlite));
      const audit = new AuditLogRepository(db);
      expect(audit.verifyChainIntegrity(masterKey)).toEqual({ valid: true, count: 2 });
      audit.logAction({ userId: 'u', action: 'UPDATE', entity: 'restore-test' }, masterKey);
      expect(audit.verifyChainIntegrity(masterKey)).toEqual({ valid: true, count: 3 });
      expect(masterKey).toEqual(expectedMaster);
      expect(blindIndexPepper).toEqual(expectedPepper);
    },
  );

  it('preserves historical category references after deleting a parent category', async () => {
    const source = fixture();
    source.sqlite.prepare('DELETE FROM categories WHERE id = ?').run('c');
    const result = await restoreFullBackupV2({
      vaultData: await makeVault(source.sqlite), password, masterKey: sourceMaster, blindIndexPepper: sourcePepper,
    });
    const target = result.database.sqlite;
    open.add(target);
    expect(target.prepare('SELECT id, parent_id FROM categories ORDER BY id').all()).toEqual([
      { id: 'c2', parent_id: 'c' },
    ]);
    expect(target.prepare('SELECT category_id, subcategory_id FROM transactions WHERE id = ?').get('t'))
      .toEqual({ category_id: 'c', subcategory_id: 'c2' });
  });

  it('preserves category and field metadata that no longer matches the current definitions', async () => {
    const source = fixture();
    const fieldRefs = '["cf","legacy-field","cf"]';
    const oldValues = '{"legacy-field":1.00}';
    source.sqlite.prepare('UPDATE categories SET parent_id = NULL, custom_field_ids = ? WHERE id = ?').run(fieldRefs, 'c2');
    source.sqlite.prepare('UPDATE transactions SET custom_values_encrypted = ? WHERE id = ?')
      .run(encryptField(oldValues, sourceMaster), 't');
    const masterKey = Buffer.alloc(32, 79);
    const result = await restoreFullBackupV2({
      vaultData: await makeVault(source.sqlite), password, masterKey, blindIndexPepper: sourcePepper,
    });
    const target = result.database.sqlite;
    open.add(target);
    expect(target.prepare('SELECT parent_id, custom_field_ids FROM categories WHERE id = ?').get('c2'))
      .toEqual({ parent_id: null, custom_field_ids: fieldRefs });
    const row = target.prepare('SELECT category_id, subcategory_id, custom_values_encrypted FROM transactions WHERE id = ?').get('t') as {
      category_id: string; subcategory_id: string; custom_values_encrypted: string;
    };
    expect(row).toMatchObject({ category_id: 'c', subcategory_id: 'c2' });
    expect(rawPlaintext(row.custom_values_encrypted, masterKey)).toBe(oldValues);
  });

  it('restores historical actor IDs from an existing legacy ledger', async () => {
    const config = {
      host: '127.0.0.1', port: 4000,
      jwtSecret: 'synthetic restore JWT signing value',
      masterKey: 'synthetic restore master key material',
      blindIndexPepper: 'synthetic restore blind index material',
      bootstrapToken: undefined,
    };
    const app = await buildApp({ config, dbPath: ':memory:' });
    try {
      app.sqlite.prepare(`INSERT INTO users (id, username, email, full_name, password_hash, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('current-admin', 'admin', 'admin@example.test',
        'Synthetic administrator', 'synthetic-hash', 'admin', timestamp, timestamp);
      const session = app.sessionRepo.createSession('current-admin');
      const authorization = `Bearer ${app.jwt.sign({ id: 'current-admin', username: 'admin', role: 'admin', sid: session.id, exp: session.expiresAt })}`;
      const headers = { authorization };
      const title = 'V1 synthetic expense';
      const encryptedAmount = encryptField(24, config.masterKey);
      app.sqlite.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('v1-category', 'Synthetic V1 category', timestamp, timestamp);
      app.sqlite.prepare(`INSERT INTO transactions (id, category_id, date, created_at, updated_at, amount_encrypted,
        base_amount_encrypted, title_encrypted, title_blind_index, created_by_id, approved_by_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('v1-expense', 'v1-category', timestamp, timestamp, timestamp,
        encryptedAmount, encryptedAmount, encryptField(title, config.masterKey), createBlindIndex(title, config.blindIndexPepper),
        'legacy-creator', 'legacy-approver');
      new AuditLogRepository(app.db).logAction({ userId: 'current-admin', action: 'RESTORE',
        entity: 'system_backup', entityId: 'synthetic-historical-import' }, config.masterKey);
      const exported = await app.inject({ method: 'POST', url: '/api/backup/export-v2', headers, payload: { backupPassword: password } });
      expect(exported.statusCode).toBe(200);
      const masterKey = deriveKey(config.masterKey);
      const { database, revokedSessions } = await restoreFullBackupV2({
        vaultData: exported.json().vaultData, password, masterKey, blindIndexPepper: config.blindIndexPepper,
      });
      open.add(database.sqlite);
      expect(database.sqlite.prepare('SELECT id FROM users').pluck().all()).toEqual(['current-admin']);
      expect(database.sqlite.prepare('SELECT created_by_id, approved_by_id FROM transactions').get())
        .toEqual({ created_by_id: 'legacy-creator', approved_by_id: 'legacy-approver' });
      expect(revokedSessions).toBe(1);
      expect(new AuditLogRepository(database.db).verifyChainIntegrity(masterKey)).toEqual({ valid: true, count: 1 });
    } finally {
      await app.close();
    }
  });

  async function withBackupAdmin(run: (app: Awaited<ReturnType<typeof buildApp>>, headers: { authorization: string }) => Promise<void>) {
    const app = await buildApp({ config: {
      jwtSecret: 'synthetic backup JWT signing value', masterKey: 'synthetic backup master key material',
      blindIndexPepper: 'synthetic backup blind index material',
    }, dbPath: ':memory:' });
    try {
      app.sqlite.prepare(`INSERT INTO users (id, username, email, full_name, password_hash, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('backup-admin', 'backup-admin', 'backup-admin@example.test',
        'Synthetic administrator', 'synthetic-hash', 'admin', timestamp, timestamp);
      const session = app.sessionRepo.createSession('backup-admin');
      const token = app.jwt.sign({ id: 'backup-admin', username: 'backup-admin', role: 'admin', sid: session.id, exp: session.expiresAt });
      await run(app, { authorization: `Bearer ${token}` });
    } finally {
      await app.close();
    }
  }

  it('does not export a V2 vault from a legacy category cycle', async () => {
    await withBackupAdmin(async (app, headers) => {
      const insert = app.sqlite.prepare('INSERT INTO categories (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
      insert.run('legacy-root', 'Synthetic root', 'legacy-child', timestamp, timestamp);
      insert.run('legacy-child', 'Synthetic child', 'legacy-root', timestamp, timestamp);
      const exported = await app.inject({ method: 'POST', url: '/api/backup/export-v2', headers, payload: { backupPassword: password } });
      expect(exported.statusCode).toBe(409);
      expect(exported.json()).toMatchObject({ code: 'BACKUP_V2_RELATION_INVALID' });
      expect(exported.json()).not.toHaveProperty('vaultData');
      expect(app.sqlite.prepare('SELECT count(*) FROM audit_logs').pluck().get()).toBe(0);
    });
  });

  it('does not export a V2 vault when a personal payment pair references a company wallet', async () => {
    await withBackupAdmin(async (app, headers) => {
      const categoryId = '56b9be59-dad7-42fc-84d7-8b69c070f47e';
      app.sqlite.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(categoryId, 'Synthetic category', timestamp, timestamp);
      const wallet = await app.inject({ method: 'POST', url: '/api/accounts', headers,
        payload: { name: 'Synthetic wallet', type: 'cash', currency: 'TRY', initialBalance: 100 } });
      expect(wallet.statusCode).toBe(201);
      const expense = await app.inject({ method: 'POST', url: '/api/transactions', headers, payload: {
        type: 'expense', date: timestamp, amount: 24, currency: 'TRY', categoryId, title: 'Synthetic expense',
        paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic payer',
      } });
      expect(expense.statusCode).toBe(201);
      const expenseId = expense.json().transaction.id;
      app.sqlite.prepare('UPDATE transactions SET account_from_id = ? WHERE id = ?').run(wallet.json().id, expenseId);
      const auditCount = app.sqlite.prepare('SELECT count(*) FROM audit_logs').pluck();
      const before = auditCount.get();
      const exported = await app.inject({ method: 'POST', url: '/api/backup/export-v2', headers, payload: { backupPassword: password } });
      expect(exported.statusCode).toBe(409);
      expect(exported.json()).toMatchObject({ code: 'BACKUP_V2_RELATION_INVALID' });
      expect(exported.json()).not.toHaveProperty('vaultData');
      expect(auditCount.get()).toBe(before);
    });
  });

  it('does not export a V2 vault when an existing ledger has an unmatched OTO-Kasa entry', async () => {
    await withBackupAdmin(async (app, headers) => {
      const categoryId = '56b9be59-dad7-42fc-84d7-8b69c070f47e';
      app.sqlite.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(categoryId, 'Synthetic category', timestamp, timestamp);
      const wallet = await app.inject({ method: 'POST', url: '/api/accounts', headers,
        payload: { name: 'Synthetic wallet', type: 'cash', currency: 'TRY', initialBalance: 100 } });
      expect(wallet.statusCode).toBe(201);
      const expense = await app.inject({ method: 'POST', url: '/api/transactions', headers, payload: {
        type: 'expense', date: timestamp, amount: 24, currency: 'TRY', categoryId, title: 'Synthetic expense',
        paymentSource: 'company_account', accountFromId: wallet.json().id,
      } });
      expect(expense.statusCode).toBe(201);
      const expenseId = expense.json().transaction.id;

      const switched = await app.inject({ method: 'PUT', url: `/api/transactions/${expenseId}`, headers, payload: {
        paymentSource: 'person_out_of_pocket', payerPersonName: 'Synthetic payer',
      } });
      expect(switched.statusCode).toBe(200);
      const healthy = await app.inject({ method: 'POST', url: '/api/backup/export-v2', headers, payload: { backupPassword: password } });
      expect(healthy.statusCode).toBe(200);
      // Represent a database damaged by a previous version, without restoring a V1 vault.
      app.sqlite.prepare(`UPDATE transactions SET oto_kasa_transaction_id = NULL, payment_source = 'company_account' WHERE id = ?`).run(expenseId);
      const count = app.sqlite.prepare('SELECT count(*) FROM audit_logs').pluck();
      const before = count.get();
      const transactions = app.sqlite.prepare('SELECT id, oto_kasa_transaction_id, payment_source FROM transactions ORDER BY id');
      const rows = transactions.all();
      expect(rows).toHaveLength(2);
      const exported = await app.inject({ method: 'POST', url: '/api/backup/export-v2', headers, payload: { backupPassword: password } });
      expect(exported.statusCode).toBe(409);
      expect(exported.json()).toMatchObject({ code: 'BACKUP_V2_RELATION_INVALID' });
      expect(exported.json()).not.toHaveProperty('vaultData');
      expect(count.get()).toBe(before);
      expect(transactions.all()).toEqual(rows);
    });
  });


  it('preserves historical wallet references when the wallet is absent', async () => {
    const config = {
      host: '127.0.0.1', port: 4000,
      jwtSecret: 'synthetic restore JWT signing value',
      masterKey: 'synthetic restore master key material',
      blindIndexPepper: 'synthetic restore blind index material',
      bootstrapToken: undefined,
    };
    const source = await buildApp({ config, dbPath: ':memory:' });
    const destination = await buildApp({ config, dbPath: ':memory:' });
    function authorize(app: typeof source, id: string) {
      app.sqlite.prepare(`INSERT INTO users (id, username, email, full_name, password_hash, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, id, `${id}@example.test`, 'Synthetic administrator',
        'synthetic-hash', 'admin', timestamp, timestamp);
      const session = app.sessionRepo.createSession(id);
      const token = app.jwt.sign({ id, username: id, role: 'admin', sid: session.id, exp: session.expiresAt });
      return { authorization: `Bearer ${token}` };
    }
    try {
      const sourceHeaders = authorize(source, 'source-admin');
      const destinationHeaders = authorize(destination, 'destination-admin');
      source.sqlite.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('56b9be59-dad7-42fc-84d7-8b69c070f47e', 'Synthetic category', timestamp, timestamp);
      const wallet = await source.inject({ method: 'POST', url: '/api/accounts', headers: sourceHeaders,
        payload: { name: 'Synthetic wallet', type: 'cash', currency: 'TRY', initialBalance: 100 } });
      expect(wallet.statusCode).toBe(201);
      const walletId = wallet.json().id;
      const expense = await source.inject({ method: 'POST', url: '/api/transactions', headers: sourceHeaders,
        payload: { type: 'expense', date: timestamp, amount: 24, currency: 'TRY', categoryId: '56b9be59-dad7-42fc-84d7-8b69c070f47e',
          title: 'Synthetic expense', paymentSource: 'company_account', accountFromId: walletId } });
      expect(expense.statusCode).toBe(201);
      const categoryId = '56b9be59-dad7-42fc-84d7-8b69c070f47e';
      destination.sqlite.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(categoryId, 'Synthetic category', timestamp, timestamp);
      const row = source.sqlite.prepare(`SELECT id, category_id, date, created_at, updated_at, amount_encrypted,
        base_amount_encrypted, title_encrypted, title_blind_index, created_by_id, account_from_id
        FROM transactions WHERE id = ?`).raw().get(expense.json().transaction.id) as string[];
      destination.sqlite.prepare(`INSERT INTO transactions (id, category_id, date, created_at, updated_at, amount_encrypted,
        base_amount_encrypted, title_encrypted, title_blind_index, created_by_id, account_from_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...row);
      const v2 = await destination.inject({ method: 'POST', url: '/api/backup/export-v2', headers: destinationHeaders,
        payload: { backupPassword: password } });
      expect(v2.statusCode).toBe(200);
      const restored = await restoreFullBackupV2({ vaultData: v2.json().vaultData, password,
        masterKey: deriveKey(config.masterKey), blindIndexPepper: config.blindIndexPepper });
      open.add(restored.database.sqlite);
      expect(restored.tableCounts).toMatchObject({ accounts: 0, transactions: 1, users: 1 });
      expect(restored.missingWalletReferences).toBe(1);
      expect(restored.database.sqlite.prepare('SELECT account_from_id, created_by_id FROM transactions').get())
        .toEqual({ account_from_id: walletId, created_by_id: 'source-admin' });
    } finally {
      await Promise.all([source.close(), destination.close()]);
    }
  });

  it('rejects an authenticated vault with the wrong source pepper', async () => {
    const source = fixture();
    const vaultData = await makeVault(source.sqlite, Buffer.alloc(32, 11));
    await expect(restoreFullBackupV2({ vaultData, password, masterKey: sourceMaster, blindIndexPepper: sourcePepper }))
      .rejects.toMatchObject({ code: 'RESTORE_BLIND_INDEX_INVALID' });
  });

  it('rejects an incorrect password before allocating a destination', async () => {
    const source = fixture();
    const vaultData = await makeVault(source.sqlite);
    vi.mocked(initDatabase).mockClear();
    await expect(restoreFullBackupV2({ vaultData, password: 'wrong synthetic password', masterKey: sourceMaster, blindIndexPepper: sourcePepper }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(initDatabase).not.toHaveBeenCalled();
  });

  it.each([
    ["UPDATE transactions SET attachments_json = '[{\"name\":\"example.pdf\"}]' WHERE id = 't'", 'RESTORE_ATTACHMENTS_UNAVAILABLE'],
    ["UPDATE transactions SET title_encrypted = 'plain text' WHERE id = 't'", 'RESTORE_CIPHERTEXT_INVALID'],
    ["UPDATE transactions SET oto_kasa_transaction_id = NULL WHERE id = 'oto-main'", 'RESTORE_RELATION_INVALID'],
    ["UPDATE transactions SET account_from_id = 'a' WHERE id = 'oto-main'", 'RESTORE_RELATION_INVALID'],
    ["UPDATE transactions SET account_to_id = 'a' WHERE id = 'oto-pair'", 'RESTORE_RELATION_INVALID'],
    ["UPDATE transactions SET account_to_id = 'a' WHERE id = 'transfer'", 'RESTORE_RELATION_INVALID'],
    ["UPDATE categories SET parent_id = 'c2' WHERE id = 'c'", 'RESTORE_RELATION_INVALID'],
    ["UPDATE categories SET custom_field_ids = '[1]' WHERE id = 'c2'", 'RESTORE_RELATION_INVALID'],
    ["UPDATE accounts SET is_active = 'wrong-storage-type' WHERE id = 'a'", 'RESTORE_ROW_INVALID'],
  ])('rejects invalid stored source data (%s)', async (mutation, code) => {
    const source = fixture();
    source.sqlite.exec(mutation);
    const vaultData = await makeVault(source.sqlite);
    const result = await restoreFullBackupV2({ vaultData, password, masterKey: sourceMaster, blindIndexPepper: sourcePepper }).then(
      ({ database }) => {
        database.sqlite.close();
        return 'unexpected restore success';
      },
      (error: unknown) => {
        if (error instanceof BackupV2Error) return error.code;
        throw error;
      },
    );
    expect(result).toBe(code);
  });

  it('rolls back every table and closes the staged database when the final audit check fails', async () => {
    const source = fixture();
    source.sqlite.prepare('UPDATE audit_logs SET hash = ? WHERE rowid = 2').run('a'.repeat(64));
    const vaultData = await makeVault(source.sqlite);
    const actual = await vi.importActual<typeof import('@cost-core/database')>('@cost-core/database');
    let rolledBackCounts: unknown[] | undefined;
    let failedTarget: typeof source.sqlite | undefined;
    vi.mocked(initDatabase).mockImplementationOnce((options) => {
      const target = actual.initDatabase(options);
      failedTarget = target.sqlite;
      open.add(target.sqlite);
      const close = target.sqlite.close.bind(target.sqlite);
      vi.spyOn(target.sqlite, 'close').mockImplementationOnce(() => {
        rolledBackCounts = tableCounts(target.sqlite);
        return close();
      });
      return target;
    });
    await expect(restoreFullBackupV2({ vaultData, password, masterKey: sourceMaster, blindIndexPepper: sourcePepper }))
      .rejects.toMatchObject({ code: 'RESTORE_AUDIT_INVALID' });
    expect(rolledBackCounts).toEqual(BACKUP_V2_TABLE_NAMES.map(() => 0));
    expect(failedTarget?.open).toBe(false);
    expect(tableCounts(source.sqlite)).toEqual([1, 1, 1, 1, 2, 2, 1, 4, 2, 1, 2]);
  });
});
