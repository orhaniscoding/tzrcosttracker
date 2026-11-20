import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '@cost-core/database';
import {
  BACKUP_V2_TABLE_NAMES,
  BackupV2Error,
  assertBackupV2Payload,
  buildFullBackupV2,
  canonicalizeBackupValue,
  readFullBackupV2,
} from '../src/services/backup-v2-export.service.js';

const PASSWORD = 'synthetic backup password';
const FIXED_NOW = '2026-11-15T00:00:00.000Z';

function openDb() {
  return initDatabase({ path: ':memory:' });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function expectBackupError(promise: Promise<unknown>, code?: string) {
  return promise.then(
    () => {
      throw new Error('Expected BackupV2Error');
    },
    (error) => {
      expect(error).toBeInstanceOf(BackupV2Error);
      if (code) expect((error as BackupV2Error).code).toBe(code);
      return error as BackupV2Error;
    },
  );
}

async function expectBackupErrorSync(fn: () => unknown, code?: string) {
  try {
    await fn();
    throw new Error('Expected BackupV2Error');
  } catch (error) {
    expect(error).toBeInstanceOf(BackupV2Error);
    if (code) expect((error as BackupV2Error).code).toBe(code);
    return error as BackupV2Error;
  }
}

function insertPopulatedFixture(sqlite: ReturnType<typeof openDb>['sqlite']) {
  sqlite.prepare(
    `INSERT INTO users (id, username, email, full_name, password_hash, role, is_active, two_factor_enabled, two_factor_secret, two_factor_backup_codes, pin_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('u1', 'alice', 'alice@example.test', 'Alice A', 'hash-a', 'admin', 1, 0, null, null, null, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  sqlite.prepare(
    `INSERT INTO users (id, username, email, full_name, password_hash, role, is_active, two_factor_enabled, two_factor_secret, two_factor_backup_codes, pin_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('u2', 'bob', 'bob@example.test', 'Bob B', 'hash-b', 'viewer', 0, 1, 'enc:v1:000102030405060708090a0b:00112233445566778899aabbccddeeff:abcd', '["code1"]', 'pin-b', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z');

  sqlite.prepare(
    `INSERT INTO projects (id, name, code, description, budget, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('p1', 'Project One', 'P1', null, 1000.5, 'TRY', 'active', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z');
  sqlite.prepare(
    `INSERT INTO projects (id, name, code, description, budget, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('p2', 'Project Two', null, 'Desc', 0, 'USD', 'completed', '2026-02-03T00:00:00.000Z', '2026-02-04T00:00:00.000Z');

  sqlite.prepare(
    `INSERT INTO project_memberships (user_id, project_id, created_at) VALUES (?, ?, ?)`,
  ).run('u1', 'p1', '2026-02-10T00:00:00.000Z');
  sqlite.prepare(
    `INSERT INTO project_memberships (user_id, project_id, created_at) VALUES (?, ?, ?)`,
  ).run('u2', 'p2', '2026-02-11T00:00:00.000Z');

  sqlite.prepare(
    `INSERT INTO parties (id, name, name_blind_index, type, phone, email, iban, tax_no, tax_office, notes, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('pa1', 'Party A', 'bidx-a', 'supplier', null, null, null, null, null, null, 1, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z');
  sqlite.prepare(
    `INSERT INTO parties (id, name, name_blind_index, type, phone, email, iban, tax_no, tax_office, notes, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('pa2', 'Party B', 'bidx-b', 'client', '555', 'b@example.test', 'TR00', '123', 'Office', '{"note":true}', 0, '2026-03-03T00:00:00.000Z', '2026-03-04T00:00:00.000Z');

  sqlite.prepare(
    `INSERT INTO accounts (id, name, name_blind_index, type, currency, balance_encrypted, credit_limit_encrypted, statement_closing_day, payment_due_day, iban_encrypted, bank_name, project_id, description, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('a1', 'Cash', 'abidx-a', 'cash', 'TRY', 'enc:v1:aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccc', null, null, null, null, null, 'p1', null, 1, '2026-04-01T00:00:00.000Z', '2026-04-02T00:00:00.000Z');
  sqlite.prepare(
    `INSERT INTO accounts (id, name, name_blind_index, type, currency, balance_encrypted, credit_limit_encrypted, statement_closing_day, payment_due_day, iban_encrypted, bank_name, project_id, description, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('a2', 'Bank', 'abidx-b', 'bank', 'USD', 'enc:v1:111111111111111111111111:22222222222222222222222222222222:3333', 'enc:v1:444444444444444444444444:55555555555555555555555555555555:6666', 15, 25, 'enc:v1:777777777777777777777777:88888888888888888888888888888888:9999', 'BankCo', null, 'desc', 0, '2026-04-03T00:00:00.000Z', '2026-04-04T00:00:00.000Z');

  sqlite.prepare(
    `INSERT INTO categories (id, name, code, parent_id, description, budget, color, icon, order_index, custom_field_ids, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('c1', 'Root', 'R', null, null, 0, '#111111', 'folder', 0, '[]', 1, '2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z');
  sqlite.prepare(
    `INSERT INTO categories (id, name, code, parent_id, description, budget, color, icon, order_index, custom_field_ids, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('c2', 'Child', 'C', 'c1', 'child', 12.75, '#222222', 'tag', 1, '["cf1"]', 0, '2026-05-03T00:00:00.000Z', '2026-05-04T00:00:00.000Z');

  sqlite.prepare(
    `INSERT INTO custom_fields (id, name, label, type, options_json, unit, required, placeholder, default_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('cf1', 'plate_no', 'Plate No', 'text', null, null, 0, null, null, '2026-06-01T00:00:00.000Z');
  sqlite.prepare(
    `INSERT INTO custom_fields (id, name, label, type, options_json, unit, required, placeholder, default_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('cf2', 'count', 'Count', 'number', '["a","b"]', 'pcs', 1, '0', '1', '2026-06-02T00:00:00.000Z');

  sqlite.prepare(
    `INSERT INTO transactions (id, project_id, type, date, amount_encrypted, currency, exchange_rate, base_amount_encrypted, category_id, subcategory_id, title_encrypted, title_blind_index, description_encrypted, party_encrypted, party_blind_index, account_from_id, account_to_id, payment_source, payer_person_name, payment_method, oto_kasa_transaction_id, due_date, is_paid, custom_values_encrypted, attachments_json, status, deleted_at, created_by_id, approved_by_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('t1', 'p1', 'expense', '2026-07-01', 'enc:v1:aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccc', 'TRY', 1, 'enc:v1:dddddddddddddddddddddddd:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee:ffff', 'c1', null, 'enc:v1:101010101010101010101010:20202020202020202020202020202020:3030', 'tb1', null, null, null, 'a1', null, 'company_account', null, 'Nakit', null, null, 1, 'enc:v1:404040404040404040404040:50505050505050505050505050505050:6060', '[]', 'approved', null, 'u1', 'u1', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z');
  sqlite.prepare(
    `INSERT INTO transactions (id, project_id, type, date, amount_encrypted, currency, exchange_rate, base_amount_encrypted, category_id, subcategory_id, title_encrypted, title_blind_index, description_encrypted, party_encrypted, party_blind_index, account_from_id, account_to_id, payment_source, payer_person_name, payment_method, oto_kasa_transaction_id, due_date, is_paid, custom_values_encrypted, attachments_json, status, deleted_at, created_by_id, approved_by_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('t2', null, 'income', '2026-07-03', 'enc:v1:121212121212121212121212:34343434343434343434343434343434:5656', 'USD', 32.5, 'enc:v1:787878787878787878787878:90909090909090909090909090909090:abab', 'c2', 'c1', 'enc:v1:cdcdcdcdcdcdcdcdcdcdcdcd:efefefefefefefefefefefefefefefef:0101', 'tb2', 'enc:v1:232323232323232323232323:45454545454545454545454545454545:6767', 'enc:v1:898989898989898989898989:acacacacacacacacacacacacacacacac:adad', 'pb2', 'a2', 'a1', 'person_out_of_pocket', 'Payer', 'Banka', 't1', '2026-08-01', 0, 'enc:v1:bcbcbcbcbcbcbcbcbcbcbcbc:dededededededededededededededede:f0f0', '[{"name":"doc.pdf"}]', 'pending', null, 'u2', null, '2026-07-03T00:00:00.000Z', '2026-07-04T00:00:00.000Z');

  sqlite.prepare(
    `INSERT INTO audit_logs (id, user_id, action, entity, entity_id, timestamp, ip_address, user_agent, diff_encrypted, hash, previous_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('al1', 'u1', 'create', 'transaction', 't1', '2026-08-01T00:00:00.000Z', null, null, null, sha256('al1'), null);
  sqlite.prepare(
    `INSERT INTO audit_logs (id, user_id, action, entity, entity_id, timestamp, ip_address, user_agent, diff_encrypted, hash, previous_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('al2', null, 'update', 'transaction', 't2', '2026-08-02T00:00:00.000Z', '127.0.0.1', 'ua', 'enc:v1:aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccc', sha256('al2'), sha256('al1'));

  sqlite.prepare(
    `INSERT INTO white_label_settings (id, company_name, app_title, logo_url, favicon_url, background_url, primary_color, secondary_color, default_theme, base_currency, date_format, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('global', 'TZRCoster Finance', 'TZRCoster Maliyet & Finans', null, null, null, '#2563EB', '#1E40AF', 'dark', 'TRY', 'DD.MM.YYYY', '2026-09-01T00:00:00.000Z');

  sqlite.prepare(
    `INSERT INTO auth_sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('s1', 'u1', 1761955200, 1762041600, null);
  sqlite.prepare(
    `INSERT INTO auth_sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('s2', 'u2', 1761955201, 1762041601, 1761955300);
}

function snapshotTables(sqlite: ReturnType<typeof openDb>['sqlite']) {
  return BACKUP_V2_TABLE_NAMES.map((name) => ({
    name,
    rows: sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid ASC`).all(),
  }));
}

function tamperVault(vault: string): string {
  const parts = vault.split(':');
  const ciphertext = parts[parts.length - 1];
  const flip = ciphertext[0] === 'a' ? 'b' : 'a';
  parts[parts.length - 1] = `${flip}${ciphertext.slice(1)}`;
  return parts.join(':');
}

function authenticatePlaintext(vault: string, plaintext: string): string {
  const parts = vault.split(':');
  const header = JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8'));
  const key = scryptSync(PASSWORD, Buffer.from(header.salt, 'base64url'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  parts[3] = iv.toString('hex');
  parts[4] = cipher.getAuthTag().toString('hex');
  parts[5] = ciphertext.toString('hex');
  key.fill(0);
  return parts.join(':');
}

describe('backup v2 export', () => {
  const masterKey = Buffer.alloc(32, 11);
  const blindIndexPepper = Buffer.alloc(32, 22);

  afterEach(() => {
    // no real files/env/auth/HTTP/startup interactions in these tests
  });

  it('roundtrips an empty current-schema database with every table', async () => {
    const { sqlite } = openDb();
    try {
      const built = await buildFullBackupV2({
        sqlite,
        masterKey,
        blindIndexPepper,
        password: PASSWORD,
        now: FIXED_NOW,
      });

      expect(built.vault.startsWith('TZRVAULT:v2:')).toBe(true);
      expect(built.manifest).toEqual({
        app: 'TZRCoster',
        format: 'tzrvault',
        version: '2.0',
        exportedAt: FIXED_NOW,
        schemaVersion: 3,
        totalRows: 0,
        tableCounts: Object.fromEntries(BACKUP_V2_TABLE_NAMES.map((name) => [name, 0])),
        documentCount: 0,
      });

      const decoded = await readFullBackupV2(built.vault, PASSWORD);
      expect(decoded.payload.schema.version).toBe(3);
      expect(decoded.payload.schema.migrations.map((row) => row.version)).toEqual([1, 2, 3]);
      expect(decoded.payload.documents).toEqual({ present: false, count: 0 });
      expect(decoded.payload.tables.map((table) => [table.name, table.rowCount, table.rowsHash])).toEqual(
        BACKUP_V2_TABLE_NAMES.map((name) => [name, 0, sha256('[]')]),
      );
      expect(Object.values(decoded.payload.limits)).toEqual([500000, 64 * 1024 * 1024]);
      expect(decoded.payload.integrity.algorithm).toBe('sha256');
      expect(/^[a-f0-9]{64}$/.test(decoded.payload.integrity.manifestHash)).toBe(true);
      expect(decoded.keys.masterKey.equals(masterKey)).toBe(true);
      expect(decoded.keys.blindIndexPepper.equals(blindIndexPepper)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('exports a fully populated valid FK-linked 11-table fixture deterministically and preserves raw values', async () => {
    const { sqlite } = openDb();
    try {
      insertPopulatedFixture(sqlite);
      const before = snapshotTables(sqlite);

      const built = await buildFullBackupV2({
        sqlite,
        masterKey,
        blindIndexPepper,
        password: PASSWORD,
        now: FIXED_NOW,
      });
      const after = snapshotTables(sqlite);
      expect(after).toEqual(before);

      const decoded = await readFullBackupV2(built.vault, PASSWORD);
      expect(decoded.payload.exportedAt).toBe(FIXED_NOW);
      expect(decoded.payload.documents).toEqual({ present: false, count: 0 });
      expect(decoded.payload.tables.map((table) => table.name)).toEqual([...BACKUP_V2_TABLE_NAMES]);
      const expectedCounts = Object.fromEntries(BACKUP_V2_TABLE_NAMES.map((name) => [name, name === 'white_label_settings' ? 1 : 2]));
      for (const table of decoded.payload.tables) {
        expect(table.rowCount).toBe(expectedCounts[table.name]);
      }
      expect(built.manifest.totalRows).toBe(21);
      expect(built.manifest.tableCounts).toEqual(expectedCounts);
      expect(decoded.keys.masterKey.equals(masterKey)).toBe(true);
      expect(decoded.keys.blindIndexPepper.equals(blindIndexPepper)).toBe(true);

      const users = decoded.payload.tables.find((table) => table.name === 'users')!;
      expect(users.rows[0]).toMatchObject({ id: 'u1', is_active: 1, two_factor_enabled: 0, two_factor_secret: null });
      expect(users.rows[1]).toMatchObject({ id: 'u2', is_active: 0, two_factor_enabled: 1, two_factor_backup_codes: '["code1"]' });

      const transactions = decoded.payload.tables.find((table) => table.name === 'transactions')!;
      expect(transactions.rows[0]).toMatchObject({
        id: 't1',
        amount_encrypted: 'enc:v1:aaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:cccc',
        base_amount_encrypted: 'enc:v1:dddddddddddddddddddddddd:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee:ffff',
        exchange_rate: 1,
        is_paid: 1,
        attachments_json: '[]',
      });
      expect(transactions.rows[1]).toMatchObject({
        id: 't2',
        exchange_rate: 32.5,
        is_paid: 0,
        attachments_json: '[{"name":"doc.pdf"}]',
        payer_person_name: 'Payer',
      });

      const expectedTxHashes = transactions.rows.map((row) => sha256(canonicalizeBackupValue(row)));
      expect(transactions.rowHashes).toEqual(expectedTxHashes);
      expect(transactions.rowsHash).toBe(
        sha256(`[${transactions.rows.map((row) => canonicalizeBackupValue(row)).join(',')}]`),
      );

      const rebuilt = await buildFullBackupV2({
        sqlite,
        masterKey,
        blindIndexPepper,
        password: PASSWORD,
        now: FIXED_NOW,
      });
      expect(rebuilt.manifest).toEqual(built.manifest);
      const rebuiltDecoded = await readFullBackupV2(rebuilt.vault, PASSWORD);
      expect(rebuiltDecoded.payload.integrity.manifestHash).toBe(decoded.payload.integrity.manifestHash);
      expect(rebuiltDecoded.payload.tables.map((t) => [t.name, t.rowCount, t.rowsHash])).toEqual(
        decoded.payload.tables.map((t) => [t.name, t.rowCount, t.rowsHash]),
      );

      // validator-only read: source db remains unchanged
      expect(snapshotTables(sqlite)).toEqual(before);
    } finally {
      sqlite.close();
    }
  });

  it('rejects wrong password, tamper, malformed/truncated envelopes and oversized header', async () => {
    const { sqlite } = openDb();
    try {
      insertPopulatedFixture(sqlite);
      const built = await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW });

      await expectBackupError(readFullBackupV2(built.vault, 'wrong synthetic password'), 'AUTHENTICATION_FAILED');
      await expectBackupError(readFullBackupV2(tamperVault(built.vault), PASSWORD), 'AUTHENTICATION_FAILED');
      await expectBackupError(readFullBackupV2('TZRVAULT:v1:not-a-v2', PASSWORD), 'INVALID_ENVELOPE');
      // truncation/corruption of authenticated sections must fail closed before any restore-like operation
      await expectBackupError(readFullBackupV2(`${built.vault.slice(0, -2)}`, PASSWORD));
      await expectBackupError(readFullBackupV2(`TZRVAULT:v2:${'A'.repeat(2049)}:aa:bb:cc`, PASSWORD), 'INVALID_ENVELOPE');

      const parts = built.vault.split(':');
      parts[2] = `${parts[2]}extra`;
      await expectBackupError(readFullBackupV2(parts.join(':'), PASSWORD), 'INVALID_ENVELOPE');
    } finally {
      sqlite.close();
    }
  });

  it('rejects invalid or non-canonical KDF headers', async () => {
    const { sqlite } = openDb();
    try {
      const built = await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW });
      const [prefix, version, encodedHeader, iv, tag, ciphertext] = built.vault.split(':');
      const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as Record<string, unknown>;

      const withHeader = (value: unknown) =>
        `${prefix}:${version}:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}:${iv}:${tag}:${ciphertext}`;

      await expectBackupError(readFullBackupV2(withHeader({ ...header, N: 16384 }), PASSWORD), 'INVALID_KDF');
      await expectBackupError(readFullBackupV2(withHeader({ ...header, r: 4 }), PASSWORD), 'INVALID_KDF');
      await expectBackupError(readFullBackupV2(withHeader({ ...header, algorithm: 'pbkdf2' }), PASSWORD), 'INVALID_KDF');
      // malformed salt value must be rejected before KDF/auth
      await expectBackupError(readFullBackupV2(withHeader({ ...header, salt: 'A' }), PASSWORD), 'INVALID_KDF');
    } finally {
      sqlite.close();
    }
  });

  it('rejects payload schema/count/hash issues before restore-like operations', async () => {
    const { sqlite } = openDb();
    try {
      const built = await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW });
      const decoded = await readFullBackupV2(built.vault, PASSWORD);
      const payload = JSON.parse(JSON.stringify(decoded.payload));

      await expectBackupErrorSync(() => assertBackupV2Payload({ ...payload, extra: true }), 'INVALID_PAYLOAD');
      const missingField = JSON.parse(JSON.stringify(payload));
      delete missingField.documents;
      await expectBackupErrorSync(() => assertBackupV2Payload(missingField), 'INVALID_PAYLOAD');

      const duplicateTableName = JSON.parse(JSON.stringify(payload));
      duplicateTableName.tables[1].name = 'users';
      await expectBackupErrorSync(() => assertBackupV2Payload(duplicateTableName), 'INVALID_TABLE_SET');

      const missingTable = JSON.parse(JSON.stringify(payload));
      missingTable.tables.pop();
      await expectBackupErrorSync(() => assertBackupV2Payload(missingTable), 'INVALID_TABLE_SET');

      const countMismatch = JSON.parse(JSON.stringify(payload));
      countMismatch.tables[0].rowCount = 1;
      await expectBackupErrorSync(() => assertBackupV2Payload(countMismatch), 'INVALID_TABLE_SET');

      const hashMismatch = JSON.parse(JSON.stringify(payload));
      hashMismatch.tables[0].rowsHash = '0'.repeat(64);
      await expectBackupErrorSync(() => assertBackupV2Payload(hashMismatch), 'INTEGRITY_MISMATCH');

      const manifestMismatch = JSON.parse(JSON.stringify(payload));
      manifestMismatch.integrity.manifestHash = 'f'.repeat(64);
      await expectBackupErrorSync(() => assertBackupV2Payload(manifestMismatch), 'INTEGRITY_MISMATCH');
    } finally {
      sqlite.close();
    }
  });

  it('fails closed on limits and unexpected database tables without producing a partial vault', async () => {
    const { sqlite } = openDb();
    try {
      insertPopulatedFixture(sqlite);

      await expectBackupError(
        buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW, limits: { maxTotalRows: 1 } }),
        'LIMIT_EXCEEDED',
      );
      await expectBackupError(
        buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW, limits: { maxPayloadBytes: 200 } }),
        'LIMIT_EXCEEDED',
      );

      const big = openDb();
      try {
        big.sqlite.exec('CREATE TABLE extra_runtime_table (id TEXT PRIMARY KEY)');
        await expectBackupError(
          buildFullBackupV2({ sqlite: big.sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW }),
          'SCHEMA_UNSUPPORTED',
        );
      } finally {
        big.sqlite.close();
      }

      const dormant = openDb();
      try {
        dormant.sqlite.exec('CREATE TABLE money_account_balances (id TEXT PRIMARY KEY)');
        await expectBackupError(
          buildFullBackupV2({ sqlite: dormant.sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW }),
          'SCHEMA_UNSUPPORTED',
        );
      } finally {
        dormant.sqlite.close();
      }
    } finally {
      sqlite.close();
    }
  });

  it('rejects unsupported migration history', async () => {
    const extra = openDb();
    try {
      extra.sqlite.exec(`CREATE TABLE broken_extra (id TEXT PRIMARY KEY)`);
      await expectBackupError(
        buildFullBackupV2({ sqlite: extra.sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW }),
        'SCHEMA_UNSUPPORTED',
      );
    } finally {
      extra.sqlite.close();
    }

    const badHistory = openDb();
    try {
      badHistory.sqlite.prepare('DELETE FROM schema_migrations WHERE version = 3').run();
      await expectBackupError(
        buildFullBackupV2({ sqlite: badHistory.sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW }),
        'SCHEMA_UNSUPPORTED',
      );
    } finally {
      badHistory.sqlite.close();
    }
  });

  it('rejects altered migration identity and unexpected sqlite-prefixed application tables', async () => {
    const { sqlite } = openDb();
    try {
      sqlite.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 3").run('0'.repeat(64));
      await expectBackupError(
        buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW }),
        'SCHEMA_UNSUPPORTED',
      );
    } finally {
      sqlite.close();
    }

    const extra = openDb();
    try {
      extra.sqlite.exec('CREATE TABLE sqliteXfinancial (id TEXT PRIMARY KEY)');
      extra.sqlite.prepare('INSERT INTO sqliteXfinancial VALUES (?)').run('synthetic');
      await expectBackupError(
        buildFullBackupV2({ sqlite: extra.sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW }),
        'SCHEMA_UNSUPPORTED',
      );
    } finally {
      extra.sqlite.close();
    }
  });

  it('reads main schema tables despite temporary shadow tables and validates their columns', async () => {
    const { sqlite } = openDb();
    try {
      insertPopulatedFixture(sqlite);
      sqlite.exec('CREATE TEMP TABLE accounts (id TEXT PRIMARY KEY)');
      const built = await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW });
      const decoded = await readFullBackupV2(built.vault, PASSWORD);
      expect(decoded.payload.tables.find((table) => table.name === 'accounts')?.rowCount).toBe(2);
    } finally {
      sqlite.close();
    }

    const malformed = openDb();
    try {
      malformed.sqlite.exec('ALTER TABLE users RENAME COLUMN full_name TO legacy_full_name');
      await expectBackupError(
        buildFullBackupV2({ sqlite: malformed.sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW }),
        'SCHEMA_UNSUPPORTED',
      );
    } finally {
      malformed.sqlite.close();
    }
  });

  it('roundtrips key bytes whose base64 text is valid JSON', async () => {
    const { sqlite } = openDb();
    try {
      for (const pepper of [Buffer.from('true', 'base64'), Buffer.from('null', 'base64'), Buffer.from('1234', 'base64')]) {
        const built = await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper: pepper, password: PASSWORD, now: FIXED_NOW });
        const decoded = await readFullBackupV2(built.vault, PASSWORD);
        expect(decoded.keys.blindIndexPepper).toEqual(pepper);
      }
    } finally {
      sqlite.close();
    }
  });

  it('rejects authenticated non-canonical JSON and duplicate fields', async () => {
    const { sqlite } = openDb();
    try {
      const built = await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW });
      const decoded = await readFullBackupV2(built.vault, PASSWORD);
      const canonical = canonicalizeBackupValue(decoded.payload);
      await expectBackupError(
        readFullBackupV2(authenticatePlaintext(built.vault, ` ${canonical}`), PASSWORD),
        'INVALID_PAYLOAD',
      );
      await expectBackupError(
        readFullBackupV2(authenticatePlaintext(built.vault, canonical.replace('{"app":"TZRCoster",', '{"app":"wrong","app":"TZRCoster",')), PASSWORD),
        'INVALID_PAYLOAD',
      );
    } finally {
      sqlite.close();
    }
  });

  it('rejects generated columns before producing an undecodable vault', async () => {
    const { sqlite } = openDb();
    try {
      sqlite.exec("ALTER TABLE users ADD COLUMN surprise TEXT GENERATED ALWAYS AS ('x') VIRTUAL");
      await expectBackupError(
        buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW }),
        'SCHEMA_UNSUPPORTED',
      );
    } finally {
      sqlite.close();
    }
  });

  it('does not disclose decrypted malformed JSON in error causes', async () => {
    const { sqlite } = openDb();
    try {
      const built = await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW });
      const error = await expectBackupError(
        readFullBackupV2(authenticatePlaintext(built.vault, '{"private":"SYNTHETIC_PRIVATE_SENTINEL", invalid}'), PASSWORD),
        'INVALID_PAYLOAD',
      );
      const messages: string[] = [];
      for (let current: unknown = error; current instanceof Error; current = current.cause) messages.push(current.message);
      expect(messages).toEqual(['Backup plaintext is not valid JSON']);
    } finally {
      sqlite.close();
    }
  });

  it('returns a stable schema error for a null migration entry', async () => {
    const { sqlite } = openDb();
    try {
      const built = await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW });
      const decoded = await readFullBackupV2(built.vault, PASSWORD);
      const payload = JSON.parse(JSON.stringify(decoded.payload));
      payload.schema.migrations[0] = null;
      await expectBackupErrorSync(() => assertBackupV2Payload(payload), 'SCHEMA_UNSUPPORTED');
    } finally {
      sqlite.close();
    }
  });

  it('guards invalid values, keys and passwords', async () => {
    const { sqlite } = openDb();
    try {
      await expectBackupError(
        buildFullBackupV2({ sqlite, masterKey: Buffer.alloc(31, 1), blindIndexPepper, password: PASSWORD }),
        'INVALID_KEY',
      );
      await expectBackupError(
        buildFullBackupV2({ sqlite, masterKey, blindIndexPepper: Buffer.alloc(0), password: PASSWORD }),
        'INVALID_KEY',
      );
      await expectBackupError(
        buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: 'short-pw' }),
        'INVALID_PASSWORD',
      );

      await expectBackupErrorSync(() => canonicalizeBackupValue({ n: BigInt(1) }), 'INVALID_VALUE');
      await expectBackupErrorSync(() => canonicalizeBackupValue({ n: Number.POSITIVE_INFINITY }), 'INVALID_VALUE');
      await expectBackupErrorSync(() => canonicalizeBackupValue({ n: Number.MAX_SAFE_INTEGER + 1 }), 'INVALID_VALUE');
      await expectBackupErrorSync(() => canonicalizeBackupValue({ b: Buffer.from('x') }), 'INVALID_VALUE');

      // validator sees invalid row/object shapes as payload problems
      const decoded = await readFullBackupV2(
        (await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW })).vault,
        PASSWORD,
      );
      const bad = JSON.parse(JSON.stringify(decoded.payload));
      (bad.tables[0] as any).rows = [{ bad: { nested: true } }];
      (bad.tables[0] as any).rowCount = 1;
      (bad.tables[0] as any).rowHashes = [sha256(canonicalizeBackupValue({ bad: { nested: true } }))];
      (bad.tables[0] as any).rowsHash = sha256(`[${canonicalizeBackupValue({ bad: { nested: true } })}]`);
      await expectBackupErrorSync(() => assertBackupV2Payload(bad), 'INVALID_ROW');
    } finally {
      sqlite.close();
    }
  });

  it('preserves deterministic row ordering and does not mutate input data/database', async () => {
    const { sqlite } = openDb();
    try {
      insertPopulatedFixture(sqlite);
      const before = snapshotTables(sqlite);
      const masterCopy = Buffer.from(masterKey);
      const pepperCopy = Buffer.from(blindIndexPepper);

      const built1 = await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW });
      const built2 = await buildFullBackupV2({ sqlite, masterKey, blindIndexPepper, password: PASSWORD, now: FIXED_NOW });

      expect(built1.manifest).toEqual(built2.manifest);
      const decoded1 = await readFullBackupV2(built1.vault, PASSWORD);
      const decoded2 = await readFullBackupV2(built2.vault, PASSWORD);
      expect(decoded1.payload.tables.map((t) => ({ name: t.name, rowCount: t.rowCount, rowsHash: t.rowsHash, rowHashes: t.rowHashes })))
        .toEqual(decoded2.payload.tables.map((t) => ({ name: t.name, rowCount: t.rowCount, rowsHash: t.rowsHash, rowHashes: t.rowHashes })));
      expect(decoded1.payload.integrity.manifestHash).toBe(decoded2.payload.integrity.manifestHash);
      expect(snapshotTables(sqlite)).toEqual(before);
      expect(masterKey.equals(masterCopy)).toBe(true);
      expect(blindIndexPepper.equals(pepperCopy)).toBe(true);

      const decoded = decoded1;
      for (const table of decoded.payload.tables) {
        const expected = sqlite.prepare(`SELECT * FROM "${table.name}" ORDER BY rowid ASC`).all();
        expect(table.rows).toEqual(expected);
      }

      // caller-provided key material remains caller-owned; temporary derived key/salt are internal to build/read
      const freshMaster = Buffer.from(masterKey);
      const freshPepper = Buffer.from(blindIndexPepper);
      await buildFullBackupV2({ sqlite, masterKey: freshMaster, blindIndexPepper: freshPepper, password: PASSWORD, now: FIXED_NOW });
      expect(freshMaster.equals(masterKey)).toBe(true);
      expect(freshPepper.equals(blindIndexPepper)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  it('does not require real files, env/auth reads, or HTTP/startup behavior', async () => {
    const { sqlite } = openDb();
    try {
      // purely in-memory database handle and synthetic values only
      const built = await buildFullBackupV2({
        sqlite,
        masterKey: randomBytes(32),
        blindIndexPepper: randomBytes(32),
        password: PASSWORD,
        now: new Date(FIXED_NOW),
      });
      const decoded = await readFullBackupV2(built.vault, PASSWORD);
      expect(decoded.payload.app).toBe('TZRCoster');
      expect(decoded.payload.format).toBe('tzrvault');
    } finally {
      sqlite.close();
    }
  });
});


describe('backup v2 snapshot authorization seam', () => {
  it('rejects a non-callable authorization hook before starting a snapshot', async () => {
    const { sqlite } = openDb();
    try {
      await expectBackupError(buildFullBackupV2({
        sqlite,
        password: PASSWORD,
        masterKey: Buffer.alloc(32, 9),
        blindIndexPepper: 'synthetic-test-pepper',
        beforeSnapshot: 'not-a-function' as unknown as () => void,
      }), 'INVALID_INPUT');
      expect(sqlite.inTransaction).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it('runs the authorization callback inside the immediate SQLite snapshot transaction', async () => {
    const { sqlite } = openDb();
    let called = 0;
    let wasInTransaction = false;
    try {
      await buildFullBackupV2({
        sqlite,
        password: PASSWORD,
        masterKey: Buffer.alloc(32, 9),
        blindIndexPepper: 'synthetic-test-pepper',
        now: FIXED_NOW,
        beforeSnapshot: () => {
          called++;
          wasInTransaction = sqlite.inTransaction;
        },
      });

      expect(called).toBe(1);
      expect(wasInTransaction).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
