import { lstat, mkdtemp, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse } from 'node:path';
import Database from 'better-sqlite3';
import { acquireDatabaseLease, type DatabaseLease } from './lease.js';

const snapshotName = 'rollback.sqlite';
const sidecars = ['-journal', '-wal', '-shm'];

export interface RollbackSnapshot {
  path: string;
  directory: string;
  directorySync: 'synced' | 'unsupported';
}

class RollbackSnapshotError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RollbackSnapshotError';
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function invalidSource(): RollbackSnapshotError {
  return new RollbackSnapshotError('ROLLBACK_SOURCE_INVALID', 'Rollback requires an existing database in a private local directory.');
}

async function verifySource(path: string): Promise<void> {
  const stat = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') throw invalidSource();
    throw error;
  });
  if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0) throw invalidSource();
}

async function checkSourceBudget(path: string, maxBytes: number): Promise<void> {
  let bytes = 0n;
  for (const suffix of ['', '-wal', '-journal']) {
    const stat = await lstat(path + suffix, { bigint: true }).catch((error: unknown) => {
      if (suffix && errorCode(error) === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.nlink !== 1n) throw invalidSource();
    bytes += stat.size;
  }
  if (bytes > BigInt(maxBytes)) {
    throw new RollbackSnapshotError('ROLLBACK_SOURCE_TOO_LARGE', 'The active database and its journals exceed the rollback byte budget.');
  }
}

export async function syncDirectory(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(errorCode(error) ?? '')) return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function discardSnapshot(directory: string): Promise<void> {
  for (const suffix of ['', ...sidecars]) {
    await unlink(join(directory, snapshotName + suffix)).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }
  await rmdir(directory);
}

export function verifyStandaloneDatabase(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    if (db.pragma('journal_mode', { simple: true }) !== 'delete' ||
        db.pragma('integrity_check', { simple: true }) !== 'ok' ||
        db.prepare('PRAGMA main.foreign_key_check').get() !== undefined) {
      throw new RollbackSnapshotError('ROLLBACK_SNAPSHOT_INVALID', 'The rollback copy failed SQLite verification.');
    }
  } finally {
    db.close();
  }
}

/**
 * Prepare a snapshot under the per-directory lease and leave the active file in place.
 * The offline caller owns the private directory. On Windows it must enforce the ACL.
 * A later activation must prepare its own snapshot under the same lease as the swap.
 */
export function createRollbackSnapshot(
  databasePath: string,
  { maxSourceBytes }: { maxSourceBytes: number },
): Promise<RollbackSnapshot> {
  return withOfflineDatabaseLease(databasePath, maxSourceBytes, lease => {
    lease.assertRecoveryClear();
    return prepareRollbackSnapshot(lease, maxSourceBytes);
  });
}

export async function withOfflineDatabaseLease<T>(
  databasePath: string,
  maxSourceBytes: number,
  run: (lease: DatabaseLease) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0) {
    throw new RollbackSnapshotError('ROLLBACK_BUDGET_INVALID', 'Provide a positive byte budget for the database and its journals.');
  }
  if (!isAbsolute(databasePath)) throw invalidSource();
  await verifySource(databasePath);
  const parent = await realpath(dirname(databasePath));
  const parentStat = await lstat(parent);
  if (parent === parse(parent).root || (process.platform !== 'win32' &&
      ((parentStat.mode & 0o077) !== 0 || parentStat.uid !== process.getuid?.()))) throw invalidSource();

  const lease = acquireDatabaseLease(databasePath);
  try {
    return await run(lease);
  } finally {
    lease.release();
  }
}

/** The caller must keep the lease held until it finishes using this copy. */
export async function prepareRollbackSnapshot(lease: DatabaseLease, maxSourceBytes: number): Promise<RollbackSnapshot> {
  let directory: string | undefined;
  try {
    await verifySource(lease.databasePath);
    await checkSourceBudget(lease.databasePath, maxSourceBytes);
    const source = new Database(lease.databasePath, { fileMustExist: true, timeout: 0 });
    let path: string;
    try {
      const [checkpoint] = source.pragma('wal_checkpoint(TRUNCATE)') as { busy: number; log: number; checkpointed: number }[];
      if (checkpoint?.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
        throw new RollbackSnapshotError('ROLLBACK_CHECKPOINT_BUSY', 'Stop processes using the active database before taking a rollback copy.');
      }
      directory = await mkdtemp(join(dirname(lease.databasePath), 'tzr-rollback-'));
      path = join(directory, snapshotName);
      const reserved = await open(path, 'wx', 0o600);
      await reserved.close();
      let started = false;
      const backup = await source.backup(path, { progress: () => {
        if (started) throw new RollbackSnapshotError('ROLLBACK_BACKUP_BUSY', 'SQLite could not complete the rollback copy.');
        started = true;
        return 0x7fff_ffff;
      } });
      if (backup.totalPages <= 0) {
        throw new RollbackSnapshotError('ROLLBACK_SNAPSHOT_INVALID', 'The rollback copy contained no database pages.');
      }
    } finally {
      source.close();
    }

    const copy = new Database(path, { fileMustExist: true, timeout: 0 });
    try {
      if (copy.pragma('journal_mode = DELETE', { simple: true }) !== 'delete') {
        throw new RollbackSnapshotError('ROLLBACK_SNAPSHOT_INVALID', 'The rollback copy requires a standalone SQLite file.');
      }
    } finally {
      copy.close();
    }
    verifyStandaloneDatabase(path);
    const entries = await readdir(directory);
    if (entries.length !== 1 || entries[0] !== snapshotName) {
      throw new RollbackSnapshotError('ROLLBACK_SNAPSHOT_INVALID', 'The rollback directory contains unexpected files.');
    }
    const file = await open(path, 'r+');
    try { await file.sync(); } finally { await file.close(); }
    const synced = await syncDirectory(directory) && await syncDirectory(dirname(lease.databasePath));
    return { directory, path, directorySync: synced ? 'synced' : 'unsupported' };
  } catch (error) {
    if (directory) {
      try { await discardSnapshot(directory); }
      catch (cleanupError) {
        throw new RollbackSnapshotError('ROLLBACK_CLEANUP_FAILED', 'The incomplete rollback copy could not be cleaned up.',
          { cause: new AggregateError([error, cleanupError]) });
      }
    }
    throw error;
  }
}
