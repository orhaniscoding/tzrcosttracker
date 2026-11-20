import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import Database from 'better-sqlite3';

const leaseFile = '.costcore-lease.sqlite';
const recoveryMarker = '.recovery-pending';

type LeaseErrorCode = 'DATABASE_PATH_INVALID' | 'DATABASE_IN_USE' | 'DATABASE_RECOVERY_PENDING';

class DatabaseLeaseError extends Error {
  constructor(readonly code: LeaseErrorCode, message: string) {
    super(message);
    this.name = 'DatabaseLeaseError';
  }
}

export interface DatabaseLease {
  readonly databasePath: string;
  readonly recoveryMarkerPath: string;
  assertRecoveryClear(): void;
  release(): void;
}

function invalidPath(): never {
  throw new DatabaseLeaseError('DATABASE_PATH_INVALID', 'Use a regular database file in a dedicated local data directory.');
}

function validateDatabaseName(name: string): void {
  const lower = name.toLowerCase();
  if (!name || name !== name.trim() || lower === recoveryMarker || lower === leaseFile || /-(journal|shm|wal)$/.test(lower)) {
    invalidPath();
  }
  if (process.platform === 'win32' && (
    /[<>:"|?*\u0000-\u001f]|\.$/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
  )) {
    invalidPath();
  }
}

function databasePathIn(directory: string, name: string): string {
  validateDatabaseName(name);
  const file = join(directory, name);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return file;
  if (!stat.isFile() || stat.nlink !== 1) invalidPath();

  const canonical = realpathSync.native(file);
  if (dirname(canonical) !== directory) invalidPath();
  validateDatabaseName(basename(canonical));
  return canonical;
}

/** Cooperating servers and offline recovery tools share one lease per local data directory. */
export function acquireDatabaseLease(path: string): DatabaseLease {
  if (!path || path !== path.trim() || path.includes('\0') || /^file:/i.test(path)) invalidPath();
  // resolve() collapses parent components before the filesystem can resolve directory aliases.
  const components = path.slice(parse(path).root.length).split(process.platform === 'win32' ? /[\\/]/ : '/');
  if (components.includes('..')) invalidPath();
  const absolute = resolve(path);
  if (process.platform === 'win32' && !/^[a-z]:\\/i.test(absolute)) invalidPath();
  const directory = realpathSync.native(dirname(absolute));
  const name = basename(absolute);
  const before = databasePathIn(directory, name);

  const lockPath = join(directory, leaseFile);
  const markerPath = join(directory, recoveryMarker);
  const lockStat = lstatSync(lockPath, { throwIfNoEntry: false });
  if (lockStat && (!lockStat.isFile() || lockStat.nlink !== 1 || lockStat.size !== 0)) invalidPath();
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (lstatSync(lockPath + suffix, { throwIfNoEntry: false })) invalidPath();
  }

  // SQLite owns the lock descriptor. Opening the same inode separately can drop POSIX locks.
  // Keep this empty file in place across restarts and replacements of the application database.
  const lock = new Database(lockPath, { timeout: 0 });
  try {
    // The lease has no rows or writes to recover. Keep its rollback journal in memory.
    if (lock.pragma('journal_mode = MEMORY', { simple: true }) !== 'memory') invalidPath();
    lock.exec('BEGIN EXCLUSIVE');
    const databasePath = databasePathIn(directory, name);
    if (databasePath !== before) invalidPath();
    return {
      databasePath,
      recoveryMarkerPath: markerPath,
      assertRecoveryClear() {
        if (lstatSync(markerPath, { throwIfNoEntry: false })) {
          throw new DatabaseLeaseError('DATABASE_RECOVERY_PENDING', 'Complete the pending database recovery before starting the server.');
        }
      },
      release() {
        if (lock.open) lock.close();
      },
    };
  } catch (error) {
    try {
      lock.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Could not close the database lease.');
    }
    const code = (error as { code?: string }).code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      throw new DatabaseLeaseError('DATABASE_IN_USE', 'The data directory is already in use.');
    }
    throw error;
  }
}
