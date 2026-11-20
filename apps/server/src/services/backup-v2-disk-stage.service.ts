import { lstat, mkdtemp, open, readdir, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { AuditLogRepository, openReadOnlyDatabase } from '@cost-core/database';
import { BACKUP_V2_TABLE_NAMES, BackupV2Error } from './backup-v2-export.service.js';
import { restoreFullBackupV2, type RestoreFullBackupV2Input, type RestoreFullBackupV2Result } from './backup-v2-restore.service.js';

export interface StageFullBackupV2Input extends RestoreFullBackupV2Input {
  /** Existing private parent controlled by the offline caller. On Windows it must have a private ACL. */
  stagingDirectory: string;
}

export interface StageFullBackupV2Result extends Omit<RestoreFullBackupV2Result, 'database'> {
  path: string;
  directory: string;
  directorySync: 'synced' | 'unsupported';
}

const filename = 'restored.sqlite';
const dialect = new SQLiteSyncDialect();
const schemaQuery = 'SELECT type, name, tbl_name, sql FROM main.sqlite_schema ORDER BY type, name';
const migrationQuery = 'SELECT version, name, checksum, applied_at FROM main.schema_migrations ORDER BY version';
const auditOrderQuery = 'SELECT rowid, id FROM main.audit_logs ORDER BY rowid';
const sessionQuery = 'SELECT id, revoked_at FROM main.auth_sessions ORDER BY id';

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function getPrivateParent(path: string): Promise<string> {
  const invalid = () => new BackupV2Error('RESTORE_STAGE_PATH_INVALID', 'Restore staging requires an existing private directory');
  if (typeof path !== 'string' || !isAbsolute(path)) throw invalid();
  const normalized = resolve(path);
  if (normalized === parse(normalized).root) throw invalid();
  try {
    const stat = await lstat(normalized);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
      throw invalid();
    }
    const canonical = await realpath(normalized);
    const samePath = process.platform === 'win32' ? canonical.toLowerCase() === normalized.toLowerCase() : canonical === normalized;
    if (!samePath) throw invalid();
    return canonical;
  } catch {
    throw invalid();
  }
}

function invalidStage(): BackupV2Error {
  return new BackupV2Error('RESTORE_STAGE_INVALID', 'The staged database failed verification');
}

function verifyFile(stagePath: string, memory: RestoreFullBackupV2Result, key: Buffer): void {
  try {
    const { sqlite, db } = openReadOnlyDatabase(stagePath);
    try {
      if (sqlite.pragma('journal_mode', { simple: true }) !== 'delete' ||
          sqlite.prepare('PRAGMA main.foreign_key_check').all().length !== 0 ||
          !isDeepStrictEqual(sqlite.pragma('integrity_check'), [{ integrity_check: 'ok' }])) {
        throw invalidStage();
      }
      for (const query of [schemaQuery, migrationQuery, auditOrderQuery, sessionQuery]) {
        if (!isDeepStrictEqual(sqlite.prepare(query).all(), memory.database.sqlite.prepare(query).all())) {
          throw invalidStage();
        }
      }
      for (const name of BACKUP_V2_TABLE_NAMES) {
        const table = sql`main.${sql.identifier(name)}`;
        const query = dialect.sqlToQuery(sql`SELECT count(*) FROM ${table}`);
        if (sqlite.prepare(query.sql).pluck().get() !== memory.tableCounts[name]) throw invalidStage();
      }
      const activeSessions = sqlite.prepare('SELECT count(*) FROM main.auth_sessions WHERE revoked_at IS NULL').pluck().get();
      if (activeSessions !== 0 || !new AuditLogRepository(db).verifyChainIntegrity(key).valid) throw invalidStage();
    } finally {
      sqlite.close();
    }
  } catch {
    throw invalidStage();
  }
}

async function verifySingleFile(directory: string, path: string): Promise<void> {
  const entries = await readdir(directory);
  const stat = await lstat(path);
  if (entries.length !== 1 || entries[0] !== filename || !stat.isFile() ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw invalidStage();
}

async function syncDirectory(directory: string): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(codeOf(error) ?? '')) {
      return false;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function discardStage(directory: string): Promise<void> {
  // This directory belongs to the current invocation. Only touch expected SQLite filenames.
  let failed = false;
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { await unlink(join(directory, filename + suffix)); }
    catch (error) { if (codeOf(error) !== 'ENOENT') failed = true; }
  }
  try { await rmdir(directory); }
  catch (error) { if (codeOf(error) !== 'ENOENT') failed = true; }
  if (failed) throw new BackupV2Error('RESTORE_STAGE_CLEANUP_FAILED', 'The restore staging directory could not be cleaned up');
}

/** Create a verified SQLite file in a new private directory for offline activation. */
export async function stageFullBackupV2ToDisk(input: StageFullBackupV2Input): Promise<StageFullBackupV2Result> {
  if (!Buffer.isBuffer(input.masterKey) || input.masterKey.length !== 32) {
    throw new BackupV2Error('INVALID_KEY', 'Destination master key must be exactly 32 bytes');
  }
  const { stagingDirectory, ...restoreInput } = input;
  const key = Buffer.from(input.masterKey);
  let directory: string | undefined;
  try {
    const { database, ...metadata } = await restoreFullBackupV2({ ...restoreInput, masterKey: key });
    try {
      if (metadata.missingWalletReferences !== 0) {
        throw new BackupV2Error('RESTORE_WALLET_RECONCILIATION_REQUIRED',
          'Reconcile missing wallet references before staging the restore for activation');
      }
      const parent = await getPrivateParent(stagingDirectory);
      directory = await mkdtemp(join(parent, 'tzr-restore-'));
      const path = join(directory, filename);
      const reserved = await open(path, 'wx', 0o600);
      await reserved.close();
      await database.sqlite.backup(path);
      await verifySingleFile(directory, path);
      verifyFile(path, { database, ...metadata }, key);
      await verifySingleFile(directory, path);
      const file = await open(path, 'r+');
      try { await file.sync(); } finally { await file.close(); }
      const synced = await syncDirectory(directory) && await syncDirectory(parent);
      return { ...metadata, path, directory, directorySync: synced ? 'synced' : 'unsupported' };
    } finally {
      database.sqlite.close();
    }
  } catch (error) {
    if (directory) await discardStage(directory);
    if (error instanceof BackupV2Error) throw error;
    throw new BackupV2Error('RESTORE_STAGE_FAILED', 'The restore file could not be staged');
  } finally {
    key.fill(0);
  }
}
