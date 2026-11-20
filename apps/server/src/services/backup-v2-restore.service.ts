import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { createBlindIndex } from '@cost-core/crypto';
import {
  accounts, AuditLogRepository, auditLogs, authSessions, categories, customFields,
  initDatabase, parties, projectMemberships, projects, transactions, users, whiteLabelSettings,
  type DatabaseInstance,
} from '@cost-core/database';
import { sql } from 'drizzle-orm';
import { getTableConfig, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import {
  BACKUP_V2_TABLE_NAMES, BackupV2Error, readFullBackupV2,
  type BackupV2Limits, type BackupV2Payload, type BackupV2Table, type BackupV2TableName,
} from './backup-v2-export.service.js';

export interface RestoreFullBackupV2Input {
  vaultData: string;
  password: string;
  masterKey: Buffer;
  blindIndexPepper: Buffer | string;
  limits?: BackupV2Limits;
  now?: Date;
}

export interface RestoreFullBackupV2Result {
  /** A verified, fresh in-memory database. The caller owns and closes the handle. */
  database: DatabaseInstance;
  tableCounts: Record<BackupV2TableName, number>;
  revokedSessions: number;
  /** Non-null wallet references without an account row. Must be reconciled before activation. */
  missingWalletReferences: number;
}

type Row = BackupV2Table['rows'][number];
type Keys = { masterKey: Buffer; blindIndexPepper: Buffer };
const SCHEMA = {
  users, projects, project_memberships: projectMemberships, parties, accounts, categories,
  custom_fields: customFields, transactions, audit_logs: auditLogs,
  white_label_settings: whiteLabelSettings, auth_sessions: authSessions,
} satisfies Record<BackupV2TableName, Parameters<typeof getTableConfig>[0]>;
const dialect = new SQLiteSyncDialect();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const FIELD = /^enc:v1:([a-f0-9]{24}):([a-f0-9]{32}):((?:[a-f0-9]{2})*)$/;

function validateRow(name: BackupV2TableName, row: Row) {
  for (const column of getTableConfig(SCHEMA[name]).columns) {
    const value = row[column.name];
    const storageType = column.getSQLType();
    const supported = value === null ? !column.notNull && !column.primary :
      storageType === 'text' ? typeof value === 'string' :
      storageType === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) :
      storageType === 'real' && typeof value === 'number' && Number.isFinite(value);
    if (!supported || (column.dataType === 'boolean' && value !== 0 && value !== 1) ||
        (column.primary && value === '') ||
        (column.enumValues?.length && value !== null && !column.enumValues.includes(value))) {
      throw new BackupV2Error('RESTORE_ROW_INVALID', 'A stored value does not match the destination schema');
    }
  }
}

function relationError(): never {
  throw new BackupV2Error('RESTORE_RELATION_INVALID', 'A backup contains an invalid relationship');
}

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new BackupV2Error(code, 'A stored JSON field is invalid');
  }
}

function asId(value: Row[string]): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) relationError();
  return value;
}

function checkRef(value: Row[string], ids: ReadonlySet<string>) {
  const id = asId(value);
  if (id !== null && !ids.has(id)) relationError();
}

function checkCategories(rows: Map<string, Row>) {
  const checked = new Set<string>();
  for (const [id, category] of rows) {
    const fields = parseJson(category.custom_field_ids as string, 'RESTORE_RELATION_INVALID');
    if (!Array.isArray(fields) || fields.some((value) => typeof value !== 'string')) relationError();

    // Resolve each ancestry path once. Avoid recursion for backups with deep category trees.
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !checked.has(current)) {
      const row = rows.get(current);
      // Deleting a category can leave a child pointing to its former parent.
      if (!row) break;
      if (path.has(current)) relationError();
      path.add(current);
      current = asId(row.parent_id);
    }
    for (const visited of path) checked.add(visited);
  }
}

/** Validate the relationships shared by V2 export and restore. */
export function checkRestoreRelationships(snapshot: readonly BackupV2Table[]): number {
  const tables = new Map(snapshot.map(({ name, rows }) => [name, rows]));
  const table = (name: BackupV2TableName) => tables.get(name)!;
  const ids = (name: BackupV2TableName) => new Set(table(name).map((row) => row.id as string));
  const index = (name: BackupV2TableName) => new Map(table(name).map((row) => [row.id as string, row]));
  const projectIds = ids('projects');
  const accountIds = ids('accounts');
  const categoryRows = index('categories');
  const transactionRows = index('transactions');
  checkCategories(categoryRows);
  let missingWalletReferences = 0;
  for (const row of table('transactions')) {
    checkRef(row.project_id, projectIds);
    // Category labels and their hierarchy can change after a transaction is recorded.
    asId(row.category_id);
    asId(row.subcategory_id);
    // V1 partial import preserves transaction wallet IDs but does not import accounts.
    const fromId = asId(row.account_from_id);
    const toId = asId(row.account_to_id);
    if (fromId !== null && !accountIds.has(fromId)) missingWalletReferences++;
    if (toId !== null && !accountIds.has(toId)) missingWalletReferences++;
    // The V1 partial importer preserved actor IDs without importing users.
    asId(row.created_by_id);
    asId(row.approved_by_id);

    if (row.type === 'transfer' && (fromId === null || toId === null || fromId === toId)) relationError();

    const linkedId = asId(row.oto_kasa_transaction_id);
    if (row.payment_source === 'person_out_of_pocket' && (linkedId === null || fromId !== null || toId !== null)) {
      relationError();
    }
    if (linkedId !== null) {
      const other = transactionRows.get(linkedId);
      const expectedType = row.type === 'expense' ? 'income' : row.type === 'income' ? 'expense' : null;
      if (!other || linkedId === row.id || other.oto_kasa_transaction_id !== row.id || other.type !== expectedType ||
          other.project_id !== row.project_id || (other.deleted_at === null) !== (row.deleted_at === null) ||
          row.payment_source !== 'person_out_of_pocket' || other.payment_source !== 'person_out_of_pocket') relationError();
    }
    const attachments = parseJson(row.attachments_json as string, 'RESTORE_ATTACHMENTS_UNAVAILABLE');
    if (!Array.isArray(attachments) || attachments.length !== 0) {
      throw new BackupV2Error('RESTORE_ATTACHMENTS_UNAVAILABLE', 'The backup cannot restore referenced attachment contents');
    }
  }
  // SQLite also checks the declared membership, account and session foreign keys at insertion.
  return missingWalletReferences;
}

function authenticatedBytes(ciphertext: string, key: Buffer): Buffer {
  const match = FIELD.exec(ciphertext);
  if (!match || match[0].length !== ciphertext.length) {
    throw new BackupV2Error('RESTORE_CIPHERTEXT_INVALID', 'A stored encrypted field has an invalid format');
  }
  let pending: Buffer | undefined;
  let final: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(match[1], 'hex'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(match[2], 'hex'));
    pending = decipher.update(Buffer.from(match[3], 'hex'));
    final = decipher.final();
    return Buffer.concat([pending, final]);
  } catch {
    throw new BackupV2Error('RESTORE_CIPHERTEXT_INVALID', 'A stored encrypted field failed authentication');
  } finally {
    pending?.fill(0);
    final?.fill(0);
  }
}

function encryptBytes(plaintext: Buffer, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  const encrypted = cipher.update(plaintext).toString('hex') + cipher.final().toString('hex');
  return `enc:v1:${nonce.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

function updateIndex(row: Row, column: string, value: string, source: Keys, target: Keys) {
  const expected = createBlindIndex(value, source.blindIndexPepper);
  const existing = row[column];
  if (typeof existing !== 'string' || existing.length !== expected.length ||
      Buffer.byteLength(existing, 'utf8') !== expected.length ||
      !timingSafeEqual(Buffer.from(existing), Buffer.from(expected))) {
    throw new BackupV2Error('RESTORE_BLIND_INDEX_INVALID', 'A stored search index does not match the source key');
  }
  row[column] = createBlindIndex(value, target.blindIndexPepper);
}

function rekeyRow(name: BackupV2TableName, sourceRow: Row, source: Keys, target: Keys): Row {
  const row = { ...sourceRow };
  const rekey = (column: string, check?: (text: string) => void) => {
    if (row[column] === null) return;
    const original = authenticatedBytes(row[column] as string, source.masterKey);
    try {
      if (check) {
        let text: string;
        try { text = utf8.decode(original); } catch {
          throw new BackupV2Error('RESTORE_CIPHERTEXT_INVALID', 'A stored encrypted field contains invalid text');
        }
        check(text);
      }
      row[column] = encryptBytes(original, target.masterKey);
    } finally {
      original.fill(0);
    }
  };
  const nameIndex = () => updateIndex(row, 'name_blind_index', row.name as string, source, target);
  switch (name) {
    case 'users':
      rekey('two_factor_secret');
      break;
    case 'parties':
      nameIndex();
      break;
    case 'accounts':
      nameIndex();
      rekey('balance_encrypted');
      rekey('credit_limit_encrypted');
      rekey('iban_encrypted');
      break;
    case 'transactions':
      rekey('amount_encrypted');
      rekey('base_amount_encrypted');
      rekey('title_encrypted', (value) => updateIndex(row, 'title_blind_index', value, source, target));
      rekey('description_encrypted');
      if (row.party_encrypted === null) {
        if (row.party_blind_index !== null && row.party_blind_index !== '') {
          throw new BackupV2Error('RESTORE_BLIND_INDEX_INVALID', 'A missing party carries a search index');
        }
      } else {
        rekey('party_encrypted', (value) => updateIndex(row, 'party_blind_index', value, source, target));
      }
      if (row.custom_values_encrypted !== '') {
        rekey('custom_values_encrypted', (text) => {
          const value = parseJson(text, 'RESTORE_RELATION_INVALID');
          if (!value || typeof value !== 'object' || Array.isArray(value)) relationError();
        });
      }
      break;
    case 'audit_logs':
      rekey('diff_encrypted', (text) => {
        const diff = parseJson(text, 'RESTORE_AUDIT_INVALID');
        if (!diff || typeof diff !== 'object' || Array.isArray(diff) ||
            !Object.hasOwn(diff, 'previousState') || !Object.hasOwn(diff, 'newState')) {
          throw new BackupV2Error('RESTORE_AUDIT_INVALID', 'A stored audit diff is invalid');
        }
      });
      break;
  }
  return row;
}

function populate(database: DatabaseInstance, payload: BackupV2Payload, source: Keys, target: Keys, revokedAt: number) {
  const { sqlite, db } = database;
  return sqlite.transaction(() => {
    const migrations = sqlite.prepare('SELECT version, name, checksum FROM main.schema_migrations ORDER BY version').all() as
      Array<{ version: number; name: string; checksum: string }>;
    if (migrations.length !== payload.schema.migrations.length || migrations.some((entry, i) => {
      const expected = payload.schema.migrations[i];
      return entry.version !== expected.version || entry.name !== expected.name || entry.checksum !== expected.checksum;
    })) throw new BackupV2Error('RESTORE_SCHEMA_INVALID', 'The destination schema does not match the backup');

    for (const { name, rows } of payload.tables) {
      for (const row of rows) validateRow(name, row);
    }
    const missingWalletReferences = checkRestoreRelationships(payload.tables);
    const tables = new Map(payload.tables.map(({ name, rows }) => [name, rows]));
    const counts = {} as Record<BackupV2TableName, number>;
    for (const name of BACKUP_V2_TABLE_NAMES) {
      const columns = getTableConfig(SCHEMA[name]).columns.map((column) => column.name);
      const table = sql`main.${sql.identifier(name)}`;
      const count = sqlite.prepare(dialect.sqlToQuery(sql`SELECT count(*) FROM ${table}`).sql).pluck();
      if (count.get() !== 0) {
        throw new BackupV2Error('RESTORE_DESTINATION_NOT_EMPTY', 'The restore destination must be empty');
      }
      const insert = sqlite.prepare(dialect.sqlToQuery(sql`INSERT INTO ${table}
        (${sql.join(columns.map((column) => sql.identifier(column)), sql`, `)})
        VALUES (${sql.join(columns.map(() => sql`?`), sql`, `)})`).sql);
      const rows = tables.get(name)!;
      // Preserve the source order, including the rowid order of the audit chain.
      for (const sourceRow of rows) {
        const row = rekeyRow(name, sourceRow, source, target);
        insert.run(columns.map((column) => row[column]));
      }
      if (count.get() !== rows.length) {
        throw new BackupV2Error('RESTORE_COUNT_INVALID', 'Restored row counts differ from the backup');
      }
      counts[name] = rows.length;
    }
    const revoked = sqlite.prepare('UPDATE main.auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL').run(revokedAt);
    if (sqlite.prepare('PRAGMA main.foreign_key_check').all().length !== 0 || sqlite.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new BackupV2Error('RESTORE_INTEGRITY_INVALID', 'Database integrity verification failed');
    }
    if (!new AuditLogRepository(db).verifyChainIntegrity(target.masterKey).valid) {
      throw new BackupV2Error('RESTORE_AUDIT_INVALID', 'The restored audit chain is invalid');
    }
    return { database, tableCounts: counts, revokedSessions: revoked.changes, missingWalletReferences };
  }).immediate();
}

/** Stage and verify a V2 restore before handing a new memory database to the caller. */
export async function restoreFullBackupV2(input: RestoreFullBackupV2Input): Promise<RestoreFullBackupV2Result> {
  if (!Buffer.isBuffer(input.masterKey) || input.masterKey.length !== 32) {
    throw new BackupV2Error('INVALID_KEY', 'Destination master key must be exactly 32 bytes');
  }
  const pepper = input.blindIndexPepper;
  const pepperBytes = Buffer.isBuffer(pepper) ? pepper.length : typeof pepper === 'string' ? Buffer.byteLength(pepper) : 0;
  if (pepperBytes === 0 || pepperBytes > 4096) {
    throw new BackupV2Error('INVALID_KEY', 'Destination blind-index pepper must contain 1 to 4096 bytes');
  }
  const revokedAt = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(revokedAt) || revokedAt <= 0) {
    throw new BackupV2Error('INVALID_INPUT', 'Restore time is invalid');
  }
  const target = { masterKey: Buffer.from(input.masterKey), blindIndexPepper: Buffer.isBuffer(pepper) ? Buffer.from(pepper) : Buffer.from(pepper, 'utf8') };
  let source: Keys | undefined;
  let staged: DatabaseInstance | undefined;
  try {
    const { payload, keys } = await readFullBackupV2(input.vaultData, input.password, input.limits);
    source = keys;
    staged = initDatabase({ path: ':memory:' });
    const restored = populate(staged, payload, source, target, revokedAt);
    staged = undefined;
    return restored;
  } catch (error) {
    if (error instanceof BackupV2Error) throw new BackupV2Error(error.code, error.message);
    throw new BackupV2Error('RESTORE_FAILED', 'Backup restore failed');
  } finally {
    target.masterKey.fill(0);
    target.blindIndexPepper.fill(0);
    source?.masterKey.fill(0);
    source?.blindIndexPepper.fill(0);
    if (staged) staged.sqlite.close();
  }
}
