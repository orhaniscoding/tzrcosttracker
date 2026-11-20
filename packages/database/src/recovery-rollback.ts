import { constants } from 'node:fs';
import { copyFile, lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ActivationError, clearRecoveryMarker, fingerprint, requireDirectorySync, requireNoSidecars } from './recovery-activation.js';
import { verifyStandaloneDatabase, withOfflineDatabaseLease } from './rollback-snapshot.js';

const markerLimit = 2048;
const digestPattern = /^[0-9a-f]{64}$/;
const stageDirectoryPattern = /^tzr-restore-[A-Za-z0-9]+$/;
const rollbackDirectoryPattern = /^tzr-rollback-[A-Za-z0-9]+$/;

type Entry = { directory: string; sha256: string };
type RecoveryMarker = { active: { name: string; sha256: string }; staged: Entry; rollback: Entry };

function invalidMarker() {
  return new ActivationError('RESTORE_MARKER_INVALID', 'The recovery marker does not describe a recognized database replacement.');
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseEntry(value: unknown, pattern: RegExp): Entry {
  const entry = record(value);
  if (typeof entry?.directory !== 'string' || !pattern.test(entry.directory) ||
      typeof entry.sha256 !== 'string' || !digestPattern.test(entry.sha256)) throw invalidMarker();
  return { directory: entry.directory, sha256: entry.sha256 };
}

async function readMarker(path: string, activeName: string): Promise<RecoveryMarker | undefined> {
  const stat = await lstat(path).catch(error => {
    if (!missing(error)) throw error;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > markerLimit) throw invalidMarker();
  const file = await open(path, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(markerLimit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw invalidMarker();
    text = buffer.toString('utf8', 0, bytesRead);
  } finally { await file.close(); }
  let parsed: Record<string, unknown> | undefined;
  try { parsed = record(JSON.parse(text)); }
  catch { throw invalidMarker(); }
  const active = record(parsed?.active);
  if (parsed?.version !== 1 || active?.name !== activeName ||
      typeof active.sha256 !== 'string' || !digestPattern.test(active.sha256)) throw invalidMarker();
  return {
    active: { name: activeName, sha256: active.sha256 },
    staged: parseEntry(parsed.staged, stageDirectoryPattern),
    rollback: parseEntry(parsed.rollback, rollbackDirectoryPattern),
  };
}

async function requireVerifiedCopy(path: string, digest: string, maxBytes: number) {
  await requireNoSidecars(path);
  if (await fingerprint(path, maxBytes) !== digest) {
    throw new ActivationError('RESTORE_ROLLBACK_CHANGED', 'The rollback copy does not match the recovery marker.');
  }
  verifyStandaloneDatabase(path);
}

async function installRollbackCopy(directory: string, active: string, archived: string, digest: string, maxBytes: number) {
  const temp = await mkdtemp(join(directory, 'tzr-recovery-copy-'));
  const next = join(temp, 'rollback.sqlite');
  try {
    await copyFile(archived, next, constants.COPYFILE_EXCL);
    await requireVerifiedCopy(next, digest, maxBytes);
    const file = await open(next, 'r+');
    try { await file.sync(); }
    finally { await file.close(); }
    await requireDirectorySync(temp);
    await rename(next, active);
    await requireVerifiedCopy(active, digest, maxBytes);
    await requireDirectorySync(temp);
    await requireDirectorySync(directory);
  } finally {
    await unlink(next).catch(error => { if (!missing(error)) throw error; });
    await rmdir(temp);
  }
}

/** Restore the preserved, verified database while the pending marker keeps servers closed. */
export async function rollbackInterruptedActivation({ databasePath, maxDatabaseBytes }: {
  databasePath: string;
  maxDatabaseBytes: number;
}) {
  return withOfflineDatabaseLease(databasePath, maxDatabaseBytes, async lease => {
    const active = lease.databasePath;
    const directory = dirname(active);
    const marker = await readMarker(lease.recoveryMarkerPath, basename(active));
    if (!marker) return { status: 'no-pending-recovery' as const };

    await requireNoSidecars(active);
    const current = await fingerprint(active, maxDatabaseBytes);
    if (![marker.active.sha256, marker.staged.sha256, marker.rollback.sha256].includes(current)) {
      throw new ActivationError('RESTORE_ACTIVE_UNKNOWN', 'The active database matches neither the previous database nor the interrupted restore.');
    }
    const archiveDirectory = join(directory, marker.rollback.directory);
    const archiveStat = await lstat(archiveDirectory);
    if (!archiveStat.isDirectory() || await realpath(archiveDirectory) !== archiveDirectory ||
        archiveStat.dev !== (await lstat(directory)).dev ||
        (process.platform !== 'win32' && ((archiveStat.mode & 0o077) !== 0 || archiveStat.uid !== process.getuid?.()))) {
      throw invalidMarker();
    }
    const archived = join(archiveDirectory, 'rollback.sqlite');
    await requireVerifiedCopy(archived, marker.rollback.sha256, maxDatabaseBytes);
    await requireDirectorySync(directory);
    if (current !== marker.rollback.sha256) {
      await installRollbackCopy(directory, active, archived, marker.rollback.sha256, maxDatabaseBytes);
    } else {
      await requireVerifiedCopy(active, marker.rollback.sha256, maxDatabaseBytes);
    }
    return { status: 'rolled-back' as const, markerRemovalSync: await clearRecoveryMarker(lease.recoveryMarkerPath) };
  });
}
