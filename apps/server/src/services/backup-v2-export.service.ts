import { createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { encryptField } from '@cost-core/crypto';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { accounts, auditLogs, authSessions, categories, customFields, parties, projectMemberships, projects, transactions, users, whiteLabelSettings } from '@cost-core/database';

const VAULT_PREFIX = 'TZRVAULT:v2:';
const APPLICATION = 'TZRCoster';
const FORMAT = 'tzrvault';
const VERSION = '2.0';
const SCHEMA_VERSION = 3;
const MAX_HEADER_CHARACTERS = 2048;
const DEFAULT_MAX_TOTAL_ROWS = 500_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENVELOPE_BYTES = 140 * 1024 * 1024;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SALT_BYTES = 16;
const PASSWORD_MIN_BYTES = 12;
const PASSWORD_MAX_BYTES = 256;

export const BACKUP_V2_TABLE_NAMES = [
  'users',
  'projects',
  'project_memberships',
  'parties',
  'accounts',
  'categories',
  'custom_fields',
  'transactions',
  'audit_logs',
  'white_label_settings',
  'auth_sessions',
] as const;

export type BackupV2TableName = (typeof BACKUP_V2_TABLE_NAMES)[number];
const TABLE_COLUMNS: Record<BackupV2TableName, readonly string[]> = {
  users: getTableConfig(users).columns.map((column) => column.name),
  projects: getTableConfig(projects).columns.map((column) => column.name),
  project_memberships: getTableConfig(projectMemberships).columns.map((column) => column.name),
  parties: getTableConfig(parties).columns.map((column) => column.name),
  accounts: getTableConfig(accounts).columns.map((column) => column.name),
  categories: getTableConfig(categories).columns.map((column) => column.name),
  custom_fields: getTableConfig(customFields).columns.map((column) => column.name),
  transactions: getTableConfig(transactions).columns.map((column) => column.name),
  audit_logs: getTableConfig(auditLogs).columns.map((column) => column.name),
  white_label_settings: getTableConfig(whiteLabelSettings).columns.map((column) => column.name),
  auth_sessions: getTableConfig(authSessions).columns.map((column) => column.name),
};
const MIGRATION_IDENTITIES = [
  { version: 1, name: 'initial-schema', checksum: 'e74319f5516c71f568958eaa081e737dd671711e8823c1bbe8fea7e6d9dcf927' },
  { version: 2, name: 'project-memberships', checksum: 'a6e28ed95246964c3f7466a26e7ec3519e8b024559bbabb24152ad4c46337b33' },
  { version: 3, name: 'account-project-scope', checksum: 'ac8720f764789873b654d470e13fe513bd5d5d1e3dea922810c937efe40332f9' },
] as const;
type SqlValue = null | string | number | boolean;
type DatabaseRow = Record<string, SqlValue>;

export interface BackupV2Limits {
  maxTotalRows?: number;
  maxPayloadBytes?: number;
  maxEnvelopeBytes?: number;
}

export interface BackupV2Migration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface BackupV2Table {
  name: BackupV2TableName;
  rowCount: number;
  rowHashes: string[];
  rowsHash: string;
  rows: DatabaseRow[];
}

export interface BackupV2SourceKey {
  id: 'masterKey' | 'blindIndexPepper';
  encoding: 'base64';
  wrappedValue: string;
}

export interface BackupV2Payload {
  app: typeof APPLICATION;
  format: typeof FORMAT;
  version: typeof VERSION;
  exportedAt: string;
  schema: { version: typeof SCHEMA_VERSION; migrations: BackupV2Migration[] };
  tables: BackupV2Table[];
  documents: { present: false; count: 0 };
  sourceKeys: BackupV2SourceKey[];
  limits: { maxTotalRows: number; maxPayloadBytes: number };
  integrity: { algorithm: 'sha256'; manifestHash: string };
}

export interface BackupV2Manifest {
  app: typeof APPLICATION;
  format: typeof FORMAT;
  version: typeof VERSION;
  exportedAt: string;
  schemaVersion: typeof SCHEMA_VERSION;
  totalRows: number;
  tableCounts: Record<BackupV2TableName, number>;
  documentCount: 0;
}

export interface BuildFullBackupV2Input {
  sqlite: BetterSqliteDatabase;
  masterKey: Buffer;
  blindIndexPepper: Buffer | string;
  password: string;
  now?: string | Date;
  limits?: BackupV2Limits;
  beforeSnapshot?: () => void;
  validateSnapshot?: (tables: readonly BackupV2Table[]) => void;
}

export interface ReadFullBackupV2Result {
  payload: BackupV2Payload;
  keys: { masterKey: Buffer; blindIndexPepper: Buffer };
}

interface ResolvedLimits {
  maxTotalRows: number;
  maxPayloadBytes: number;
  maxEnvelopeBytes: number;
}

interface VaultHeader {
  algorithm: 'scrypt';
  N: typeof SCRYPT_N;
  r: typeof SCRYPT_R;
  p: typeof SCRYPT_P;
  keyLength: typeof SCRYPT_KEY_LENGTH;
  salt: string;
}

interface ParsedEnvelope {
  salt: Buffer;
  encryptedPayload: string;
  ciphertextBytes: number;
}

interface TableBudget {
  totalRows: number;
  approximateRowBytes: number;
  limits: ResolvedLimits;
}

export class BackupV2Error extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BackupV2Error';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new BackupV2Error(code, message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectRecord(value: unknown, code = 'INVALID_PAYLOAD'): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    fail(code, 'Expected a plain object');
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.enumerable && !('value' in descriptor)) {
      fail(code, 'Accessor properties are not supported');
    }
  }
  return value;
}

function expectKeys(value: Record<string, unknown>, expected: readonly string[], code = 'INVALID_PAYLOAD'): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code, 'Object fields do not match the backup v2 schema');
  }
}

function assertInteger(value: unknown, minimum: number, maximum: number, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, 'Integer value is outside the supported range');
  }
  return value;
}

function resolveLimits(input?: BackupV2Limits): ResolvedLimits {
  const value = input === undefined ? {} : expectRecord(input, 'INVALID_LIMITS');
  expectKeys(value, Object.keys(value).filter((key) =>
    key === 'maxTotalRows' || key === 'maxPayloadBytes' || key === 'maxEnvelopeBytes'));
  const resolve = (candidate: unknown, fallback: number): number =>
    candidate === undefined
      ? fallback
      : assertInteger(candidate, 1, fallback, 'INVALID_LIMITS');
  return {
    maxTotalRows: resolve(value.maxTotalRows, DEFAULT_MAX_TOTAL_ROWS),
    maxPayloadBytes: resolve(value.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES),
    maxEnvelopeBytes: resolve(value.maxEnvelopeBytes, DEFAULT_MAX_ENVELOPE_BYTES),
  };
}

function validatePassword(password: unknown): string {
  if (typeof password !== 'string') {
    fail('INVALID_PASSWORD', 'Backup password must be a string');
  }
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < PASSWORD_MIN_BYTES || bytes > PASSWORD_MAX_BYTES) {
    fail('INVALID_PASSWORD', 'Backup password must contain 12 to 256 UTF-8 bytes');
  }
  return password;
}

function normalizeTimestamp(input: string | Date | undefined): string {
  const date = input === undefined ? new Date() : input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(date.getTime())) {
    fail('INVALID_TIMESTAMP', 'Backup timestamp is invalid');
  }
  return date.toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalizeBackupValue(value: unknown): string {
  const visit = (candidate: unknown): string => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate) || (Number.isInteger(candidate) && !Number.isSafeInteger(candidate))) {
        fail('INVALID_VALUE', 'Non-finite or unsafe numeric value');
      }
      return JSON.stringify(candidate);
    }
    if (typeof candidate === 'bigint') {
      fail('INVALID_VALUE', 'BigInt values are not supported by the current schema');
    }
    if (Array.isArray(candidate)) {
      return `[${candidate.map(visit).join(',')}]`;
    }
    const record = expectRecord(candidate, 'INVALID_VALUE');
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${visit(record[key])}`).join(',')}}`;
  };
  return visit(value);
}

function canonicalRow(row: unknown): { row: DatabaseRow; canonical: string } {
  const record = expectRecord(row, 'INVALID_ROW');
  for (const value of Object.values(record)) {
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      fail('INVALID_ROW', 'SQLite row contains an unsupported value');
    }
    if (typeof value === 'number' &&
      (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
      fail('INVALID_ROW', 'SQLite row contains a non-finite or unsafe number');
    }
  }
  const typed = record as DatabaseRow;
  return { row: typed, canonical: canonicalizeBackupValue(typed) };
}

function makeTable(name: BackupV2TableName, rows: Iterable<unknown>, budget: TableBudget): BackupV2Table {
  const canonicalRows: string[] = [];
  const typedRows: DatabaseRow[] = [];
  const rowHashes: string[] = [];
  for (const input of rows) {
    budget.totalRows += 1;
    if (budget.totalRows > budget.limits.maxTotalRows) {
      fail('LIMIT_EXCEEDED', 'Backup row limit exceeded');
    }
    const { row, canonical } = canonicalRow(input);
    budget.approximateRowBytes += Buffer.byteLength(canonical, 'utf8');
    if (budget.approximateRowBytes > budget.limits.maxPayloadBytes) {
      fail('LIMIT_EXCEEDED', 'Backup payload byte limit exceeded');
    }
    typedRows.push(row);
    canonicalRows.push(canonical);
    rowHashes.push(sha256(canonical));
  }
  return {
    name,
    rowCount: typedRows.length,
    rowHashes,
    rowsHash: sha256(`[${canonicalRows.join(',')}]`),
    rows: typedRows,
  };
}

function migrationProjection(rows: BackupV2Migration[]): BackupV2Migration[] {
  if (rows.length !== SCHEMA_VERSION) {
    fail('SCHEMA_UNSUPPORTED', 'Backup migration history is incomplete or unsupported');
  }
  return rows.map((row, index) => {
    const record = expectRecord(row, 'SCHEMA_UNSUPPORTED');
    expectKeys(record, ['version', 'name', 'checksum', 'appliedAt'], 'SCHEMA_UNSUPPORTED');
    const expected = MIGRATION_IDENTITIES[index];
    if (row.version !== expected.version || row.name !== expected.name || row.checksum !== expected.checksum ||
      typeof row.appliedAt !== 'string' || row.appliedAt.length === 0) {
      fail('SCHEMA_UNSUPPORTED', 'Backup migration history is invalid');
    }
    return { version: row.version, name: row.name, checksum: row.checksum, appliedAt: row.appliedAt };
  });
}

function manifestProjection(payload: Omit<BackupV2Payload, 'integrity'>): unknown {
  return {
    app: payload.app,
    format: payload.format,
    version: payload.version,
    exportedAt: payload.exportedAt,
    schema: payload.schema,
    tables: payload.tables.map((table) => ({
      name: table.name,
      rowCount: table.rowCount,
      rowHashes: table.rowHashes,
      rowsHash: table.rowsHash,
    })),
    documents: payload.documents,
  };
}

function expectedManifestHash(payload: BackupV2Payload): string {
  return sha256(canonicalizeBackupValue(manifestProjection(payload)));
}

function equalHash(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function assertBackupV2Payload(value: unknown, inputLimits?: BackupV2Limits): BackupV2Payload {
  const payload = expectRecord(value);
  expectKeys(payload, [
    'app', 'format', 'version', 'exportedAt', 'schema', 'tables', 'documents',
    'sourceKeys', 'limits', 'integrity',
  ]);
  if (payload.app !== APPLICATION || payload.format !== FORMAT || payload.version !== VERSION) {
    fail('INVALID_PAYLOAD', 'Backup application, format or version is unsupported');
  }
  if (typeof payload.exportedAt !== 'string' || normalizeTimestamp(payload.exportedAt) !== payload.exportedAt) {
    fail('INVALID_PAYLOAD', 'Backup timestamp is not canonical ISO UTC');
  }
  const schema = expectRecord(payload.schema);
  expectKeys(schema, ['version', 'migrations']);
  if (schema.version !== SCHEMA_VERSION || !Array.isArray(schema.migrations)) {
    fail('SCHEMA_UNSUPPORTED', 'Backup schema version is unsupported');
  }
  const migrations = migrationProjection(schema.migrations as BackupV2Migration[]);
  if (!Array.isArray(payload.tables) || payload.tables.length !== BACKUP_V2_TABLE_NAMES.length) {
    fail('INVALID_TABLE_SET', 'Backup must contain every current application table exactly once');
  }
  const limits = resolveLimits({
    ...expectRecord(payload.limits),
    ...(inputLimits ?? {}),
  });
  const budget: TableBudget = { totalRows: 0, approximateRowBytes: 0, limits };
  const tables = payload.tables.map((candidate, index) => {
    const table = expectRecord(candidate);
    expectKeys(table, ['name', 'rowCount', 'rowHashes', 'rowsHash', 'rows']);
    if (table.name !== BACKUP_V2_TABLE_NAMES[index] ||
      !Array.isArray(table.rows) || !Array.isArray(table.rowHashes) ||
      table.rowCount !== table.rows.length || table.rowHashes.length !== table.rows.length ||
      typeof table.rowsHash !== 'string') {
      fail('INVALID_TABLE_SET', 'Backup table registry or row count is invalid');
    }
    for (const row of table.rows) {
      expectKeys(expectRecord(row, 'INVALID_ROW'), TABLE_COLUMNS[BACKUP_V2_TABLE_NAMES[index]], 'INVALID_ROW');
    }
    const rowHashes = table.rowHashes;
    const rebuilt = makeTable(BACKUP_V2_TABLE_NAMES[index], table.rows, budget);
    if (rebuilt.rowsHash !== table.rowsHash || rebuilt.rowHashes.some((hash, rowIndex) => hash !== rowHashes[rowIndex])) {
      fail('INTEGRITY_MISMATCH', 'Backup table hash validation failed');
    }
    return rebuilt;
  });
  const documents = expectRecord(payload.documents);
  expectKeys(documents, ['present', 'count']);
  if (documents.present !== false || documents.count !== 0) {
    fail('INVALID_PAYLOAD', 'Document storage is not supported by backup v2');
  }
  if (!Array.isArray(payload.sourceKeys) || payload.sourceKeys.length !== 2) {
    fail('INVALID_PAYLOAD', 'Backup source key registry is invalid');
  }
  const sourceKeys = payload.sourceKeys.map((candidate, index) => {
    const key = expectRecord(candidate);
    expectKeys(key, ['id', 'encoding', 'wrappedValue']);
    const expectedId = index === 0 ? 'masterKey' : 'blindIndexPepper';
    if (key.id !== expectedId || key.encoding !== 'base64' || typeof key.wrappedValue !== 'string' ||
      !/^enc:v1:[a-f0-9]{24}:[a-f0-9]{32}:[a-f0-9]+$/.test(key.wrappedValue) ||
      key.wrappedValue.split(':')[4].length % 2 !== 0) {
      fail('INVALID_PAYLOAD', 'Backup wrapped key entry is invalid');
    }
    return key as unknown as BackupV2SourceKey;
  });
  const integrity = expectRecord(payload.integrity);
  expectKeys(integrity, ['algorithm', 'manifestHash']);
  if (integrity.algorithm !== 'sha256' || typeof integrity.manifestHash !== 'string') {
    fail('INVALID_PAYLOAD', 'Backup integrity metadata is invalid');
  }
  const typed = {
    app: APPLICATION,
    format: FORMAT,
    version: VERSION,
    exportedAt: payload.exportedAt,
    schema: { version: SCHEMA_VERSION, migrations },
    tables,
    documents: { present: false as const, count: 0 as const },
    sourceKeys,
    limits: { maxTotalRows: limits.maxTotalRows, maxPayloadBytes: limits.maxPayloadBytes },
    integrity: { algorithm: 'sha256' as const, manifestHash: integrity.manifestHash },
  } satisfies BackupV2Payload;
  if (!equalHash(integrity.manifestHash, expectedManifestHash(typed))) {
    fail('INTEGRITY_MISMATCH', 'Backup manifest hash validation failed');
  }
  return typed;
}

function readSchemaAndTables(sqlite: BetterSqliteDatabase, limits: ResolvedLimits, beforeSnapshot?: () => void): {
  schema: BackupV2Payload['schema'];
  tables: BackupV2Table[];
} {
  if (!sqlite || typeof sqlite.prepare !== 'function' || typeof sqlite.transaction !== 'function') {
    fail('INVALID_INPUT', 'A better-sqlite3 database handle is required');
  }
  return sqlite.transaction(() => {
    beforeSnapshot?.();
    const names = sqlite.prepare(
      "SELECT name FROM main.sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map((row) => (row as { name: unknown }).name);
    const applicationNames = names.filter((name): name is string => typeof name === 'string' && !name.startsWith('sqlite_'));
    const expectedNames = new Set<string>([...BACKUP_V2_TABLE_NAMES, 'schema_migrations']);
    if (applicationNames.length !== expectedNames.size || applicationNames.some((name) => !expectedNames.has(name))) {
      fail('SCHEMA_UNSUPPORTED', 'Database tables do not match the supported backup v2 schema');
    }
    const migrationColumns = (sqlite.prepare('PRAGMA main.table_xinfo("schema_migrations")').all() as Array<{ name: string }>)
      .map((column) => column.name).sort();
    if (migrationColumns.join(',') !== ['applied_at', 'checksum', 'name', 'version'].join(',')) {
      fail('SCHEMA_UNSUPPORTED', 'Migration history table columns are unsupported');
    }
    const migrationRows = sqlite.prepare(
      'SELECT version, name, checksum, applied_at FROM main.schema_migrations ORDER BY version ASC',
    ).all().map((row) => {
      const value = row as Record<string, unknown>;
      return {
        version: value.version,
        name: value.name,
        checksum: value.checksum,
        appliedAt: value.applied_at,
      } as BackupV2Migration;
    });
    const schema: BackupV2Payload['schema'] = { version: SCHEMA_VERSION, migrations: migrationProjection(migrationRows) };
    const budget: TableBudget = { totalRows: 0, approximateRowBytes: 0, limits };
    const tables = BACKUP_V2_TABLE_NAMES.map((name) => {
      const actualColumns = (sqlite.prepare(`PRAGMA main.table_xinfo("${name}")`).all() as Array<{ name: string }>).map((column) => column.name).sort();
      if (actualColumns.length !== TABLE_COLUMNS[name].length || actualColumns.some((column, index) => column !== [...TABLE_COLUMNS[name]].sort()[index])) {
        fail('SCHEMA_UNSUPPORTED', `Database columns do not match the supported schema for ${name}`);
      }
      const rows = sqlite.prepare(`SELECT * FROM main."${name}" ORDER BY rowid ASC`).iterate();
      return makeTable(name, rows as Iterable<unknown>, budget);
    });
    return { schema, tables };
  }).immediate();
}

function validateSourceKeys(masterKey: Buffer, blindIndexPepper: Buffer | string): {
  masterKey: Buffer;
  blindIndexPepper: Buffer;
} {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
    fail('INVALID_KEY', 'Source master key must be exactly 32 bytes');
  }
  const pepper = Buffer.isBuffer(blindIndexPepper)
    ? Buffer.from(blindIndexPepper)
    : typeof blindIndexPepper === 'string'
      ? Buffer.from(blindIndexPepper, 'utf8')
      : Buffer.alloc(0);
  if (pepper.length === 0 || pepper.length > 4096) {
    fail('INVALID_KEY', 'Blind-index pepper must contain 1 to 4096 bytes');
  }
  return { masterKey: Buffer.from(masterKey), blindIndexPepper: pepper };
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, derived) => {
      if (error) {
        reject(new BackupV2Error('KDF_FAILED', 'Backup key derivation failed', { cause: error }));
      } else {
        resolve(derived);
      }
    });
  });
}

function encodeHeader(salt: Buffer): string {
  const header: VaultHeader = {
    algorithm: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keyLength: SCRYPT_KEY_LENGTH,
    salt: salt.toString('base64url'),
  };
  return Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
}

function parseEnvelope(vault: string, limits: ResolvedLimits): ParsedEnvelope {
  if (typeof vault !== 'string' || vault.length > limits.maxEnvelopeBytes || !vault.startsWith(VAULT_PREFIX)) {
    fail('INVALID_ENVELOPE', 'Backup envelope is invalid or exceeds its byte limit');
  }
  const parts = vault.slice(VAULT_PREFIX.length).split(':');
  if (parts.length !== 4 || parts[0].length > MAX_HEADER_CHARACTERS ||
    !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[a-f0-9]{24}$/.test(parts[1]) ||
    !/^[a-f0-9]{32}$/.test(parts[2]) || !/^(?:[a-f0-9]{2})+$/.test(parts[3])) {
    fail('INVALID_ENVELOPE', 'Backup envelope sections are malformed');
  }
  const [encodedHeader, iv, tag, ciphertext] = parts;
  const headerBytes = Buffer.from(encodedHeader, 'base64url');
  if (headerBytes.toString('base64url') !== encodedHeader || headerBytes.length > 1024) {
    fail('INVALID_ENVELOPE', 'Backup key-derivation header is invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerBytes.toString('utf8'));
  } catch (error) {
    throw new BackupV2Error('INVALID_KDF', 'Backup key-derivation header is not valid JSON', { cause: error });
  }
  const header = expectRecord(parsed, 'INVALID_KDF');
  expectKeys(header, ['algorithm', 'N', 'r', 'p', 'keyLength', 'salt']);
  if (JSON.stringify(header) !== headerBytes.toString('utf8') ||
    header.algorithm !== 'scrypt' || header.N !== SCRYPT_N || header.r !== SCRYPT_R ||
    header.p !== SCRYPT_P || header.keyLength !== SCRYPT_KEY_LENGTH ||
    typeof header.salt !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(header.salt)) {
    fail('INVALID_KDF', 'Backup key-derivation parameters are unsupported or non-canonical');
  }
  const salt = Buffer.from(header.salt, 'base64url');
  if (salt.length !== SALT_BYTES || salt.toString('base64url') !== header.salt) {
    fail('INVALID_KDF', 'Backup salt is invalid');
  }
  const ciphertextBytes = ciphertext.length / 2;
  if (ciphertextBytes > limits.maxPayloadBytes) {
    fail('LIMIT_EXCEEDED', 'Encrypted backup payload exceeds its byte limit');
  }
  return { salt, encryptedPayload: `enc:v1:${iv}:${tag}:${ciphertext}`, ciphertextBytes };
}

function decryptRawField(cipherText: string, key: Buffer): string {
  const match = /^enc:v1:([a-f0-9]{24}):([a-f0-9]{32}):((?:[a-f0-9]{2})*)$/.exec(cipherText);
  if (!match) throw new Error('Encrypted field format is invalid');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(match[1], 'hex'), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(match[2], 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(match[3], 'hex')), decipher.final()]).toString('utf8');
}

function decodeJsonPayload(plaintext: string, limits: ResolvedLimits): BackupV2Payload {
  if (Buffer.byteLength(plaintext, 'utf8') > limits.maxPayloadBytes) {
    fail('LIMIT_EXCEEDED', 'Backup payload exceeds its byte limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    throw new BackupV2Error('INVALID_PAYLOAD', 'Backup plaintext is not valid JSON');
  }
  if (canonicalizeBackupValue(value) !== plaintext) {
    fail('INVALID_PAYLOAD', 'Backup plaintext is not canonical JSON or contains duplicate fields');
  }
  return assertBackupV2Payload(value, limits);
}

function unwrapSourceKeys(payload: BackupV2Payload, derivedKey: Buffer): ReadFullBackupV2Result['keys'] {
  let masterKey: Buffer | undefined;
  let blindIndexPepper: Buffer | undefined;
  try {
    const masterEncoded = decryptRawField(payload.sourceKeys[0].wrappedValue, derivedKey);
    const pepperEncoded = decryptRawField(payload.sourceKeys[1].wrappedValue, derivedKey);
    masterKey = Buffer.from(masterEncoded, 'base64');
    blindIndexPepper = Buffer.from(pepperEncoded, 'base64');
    if (masterKey.toString('base64') !== masterEncoded || blindIndexPepper.toString('base64') !== pepperEncoded) {
      fail('KEY_UNWRAP_FAILED', 'Unwrapped source key material is invalid');
    }
    if (masterKey.length !== 32 || blindIndexPepper.length === 0 || blindIndexPepper.length > 4096) {
      fail('KEY_UNWRAP_FAILED', 'Unwrapped source key material is invalid');
    }
    return { masterKey, blindIndexPepper };
  } catch (error) {
    masterKey?.fill(0);
    blindIndexPepper?.fill(0);
    if (error instanceof BackupV2Error) {
      throw error;
    }
    throw new BackupV2Error('KEY_UNWRAP_FAILED', 'Backup source keys could not be authenticated', { cause: error });
  }
}

export async function buildFullBackupV2(input: BuildFullBackupV2Input): Promise<{
  vault: string;
  manifest: BackupV2Manifest;
}> {
  const options = expectRecord(input, 'INVALID_INPUT');
  const beforeSnapshot = options.beforeSnapshot;
  if (beforeSnapshot !== undefined && typeof beforeSnapshot !== 'function') {
    fail('INVALID_INPUT', 'Snapshot authorization hook must be a function');
  }
  const validateSnapshot = options.validateSnapshot as BuildFullBackupV2Input['validateSnapshot'];
  if (validateSnapshot !== undefined && typeof validateSnapshot !== 'function') {
    fail('INVALID_INPUT', 'Snapshot validation hook must be a function');
  }
  const password = validatePassword(options.password);
  const limits = resolveLimits(options.limits as BackupV2Limits | undefined);
  const exportedAt = normalizeTimestamp(options.now as string | Date | undefined);
  const keys = validateSourceKeys(options.masterKey as Buffer, options.blindIndexPepper as Buffer | string);
  try {
    const { schema, tables } = readSchemaAndTables(options.sqlite as BetterSqliteDatabase, limits, beforeSnapshot as BuildFullBackupV2Input["beforeSnapshot"]);
    validateSnapshot?.(tables);
    const salt = randomBytes(SALT_BYTES);
    const derivedKey = await deriveKey(password, salt);
    try {
      const sourceKeys: BackupV2SourceKey[] = [
        { id: 'masterKey', encoding: 'base64', wrappedValue: encryptField(keys.masterKey.toString('base64'), derivedKey) },
        { id: 'blindIndexPepper', encoding: 'base64', wrappedValue: encryptField(keys.blindIndexPepper.toString('base64'), derivedKey) },
      ];
      const withoutIntegrity: Omit<BackupV2Payload, 'integrity'> = {
        app: APPLICATION,
        format: FORMAT,
        version: VERSION,
        exportedAt,
        schema,
        tables,
        documents: { present: false as const, count: 0 as const },
        sourceKeys,
        limits: { maxTotalRows: limits.maxTotalRows, maxPayloadBytes: limits.maxPayloadBytes },
      };
      const manifestHash = sha256(canonicalizeBackupValue(manifestProjection(withoutIntegrity)));
      const payload: BackupV2Payload = {
        ...withoutIntegrity,
        integrity: { algorithm: 'sha256', manifestHash },
      };
      const plaintext = canonicalizeBackupValue(payload);
      if (Buffer.byteLength(plaintext, 'utf8') > limits.maxPayloadBytes) {
        fail('LIMIT_EXCEEDED', 'Backup payload byte limit exceeded');
      }
      const encrypted = encryptField(plaintext, derivedKey);
      const [, , iv, tag, ciphertext] = encrypted.split(':');
      const vault = `${VAULT_PREFIX}${encodeHeader(salt)}:${iv}:${tag}:${ciphertext}`;
      if (Buffer.byteLength(vault, 'utf8') > limits.maxEnvelopeBytes) {
        fail('LIMIT_EXCEEDED', 'Backup envelope byte limit exceeded');
      }
      const tableCounts = Object.fromEntries(tables.map((table) => [table.name, table.rowCount])) as Record<BackupV2TableName, number>;
      const totalRows = tables.reduce((total, table) => total + table.rowCount, 0);
      return {
        vault,
        manifest: {
          app: APPLICATION,
          format: FORMAT,
          version: VERSION,
          exportedAt,
          schemaVersion: SCHEMA_VERSION,
          totalRows,
          tableCounts,
          documentCount: 0,
        },
      };
    } finally {
      derivedKey.fill(0);
      salt.fill(0);
    }
  } finally {
    keys.masterKey.fill(0);
    keys.blindIndexPepper.fill(0);
  }
}

export async function readFullBackupV2(
  vault: string,
  password: string,
  inputLimits?: BackupV2Limits,
): Promise<ReadFullBackupV2Result> {
  const validPassword = validatePassword(password);
  const limits = resolveLimits(inputLimits);
  const envelope = parseEnvelope(vault, limits);
  const derivedKey = await deriveKey(validPassword, envelope.salt);
  try {
    let decryptedPayload: string;
    try {
      decryptedPayload = decryptRawField(envelope.encryptedPayload, derivedKey);
    } catch (error) {
      throw new BackupV2Error('AUTHENTICATION_FAILED', 'Backup password or envelope authentication failed', { cause: error });
    }
    const payload = decodeJsonPayload(decryptedPayload, limits);
    const keys = unwrapSourceKeys(payload, derivedKey);
    return { payload, keys };
  } finally {
    derivedKey.fill(0);
    envelope.salt.fill(0);
  }
}
