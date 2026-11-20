import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseLease } from './lease.js';
import { discardSnapshot, prepareRollbackSnapshot, syncDirectory, verifyStandaloneDatabase, withOfflineDatabaseLease } from './rollback-snapshot.js';

export interface ActivateStagedDatabaseOptions {
  databasePath: string;
  stagedPath: string;
  stagedSha256: string;
  maxDatabaseBytes: number;
}

export class ActivationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ActivationError';
  }
}

export async function fingerprint(path: string, maxBytes: number): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size === 0 || before.size > maxBytes) {
    throw new ActivationError('RESTORE_FILE_INVALID', 'The database must be one regular file within the byte limit.');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { end: before.size - 1 })) hash.update(chunk);
  const after = await lstat(path);
  if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new ActivationError('RESTORE_FILE_INVALID', 'The database changed during verification.');
  }
  return hash.digest('hex');
}

export async function requireNoSidecars(path: string): Promise<void> {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = await lstat(path + suffix).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    if (sidecar) {
      throw new ActivationError('RESTORE_SIDECAR_PRESENT', 'Close other SQLite connections before replacing the database.');
    }
  }
}

export async function requireDirectorySync(path: string): Promise<void> {
  if (!(await syncDirectory(path))) {
    throw new ActivationError('RESTORE_SYNC_UNAVAILABLE', 'Activation requires durable directory updates on the local filesystem.');
  }
}

/** Use only a file verified by V2 staging. The private data directory is offline throughout activation. */
export function activateStagedDatabase({ databasePath, maxDatabaseBytes, stagedPath, stagedSha256 }: ActivateStagedDatabaseOptions) {
  return withOfflineDatabaseLease(databasePath, maxDatabaseBytes, lease =>
    activateUnderLease(lease, maxDatabaseBytes, stagedPath, stagedSha256, () => {}));
}

/** Prepare and activate a new V2 stage under one lease. The callback owns its temporary files until it returns. */
export function prepareAndActivateDatabase({ databasePath, maxDatabaseBytes }: Pick<ActivateStagedDatabaseOptions, 'databasePath' | 'maxDatabaseBytes'>,
  prepare: (canonicalActivePath: string) => Promise<{ path: string; discard: () => Promise<void> }>,
) {
  return withOfflineDatabaseLease(databasePath, maxDatabaseBytes, async lease => {
    lease.assertRecoveryClear();
    const stage = await prepare(lease.databasePath);
    let published = false;
    try {
      const sha256 = await fingerprint(stage.path, maxDatabaseBytes);
      return await activateUnderLease(lease, maxDatabaseBytes, stage.path, sha256, () => { published = true; });
    } catch (error) {
      if (!published) {
        try { await stage.discard(); }
        catch (cleanupError) {
          throw Object.assign(new AggregateError([error, cleanupError], 'The unused restore stage could not be removed.'), {
            code: 'RESTORE_STAGE_CLEANUP_FAILED',
          });
        }
      }
      throw error;
    }
  });
}

async function activateUnderLease(lease: DatabaseLease, maxDatabaseBytes: number, stagedPath: string,
  stagedSha256: string, onPublished: () => void,
) {
  lease.assertRecoveryClear();
  const active = lease.databasePath;
  const directory = dirname(active);
  const stageDirectory = dirname(stagedPath);
  const stageName = basename(stageDirectory);
  const invalidStage = () => new ActivationError('RESTORE_STAGE_INVALID', 'Use a prepared database in a private staging directory on the same filesystem.');
  if (resolve(stagedPath) !== stagedPath || dirname(stageDirectory) !== directory ||
      !/^tzr-restore-[A-Za-z0-9]+$/.test(stageName) || basename(stagedPath) !== 'restored.sqlite') {
    throw invalidStage();
  }
  const stage = await lstat(stageDirectory);
  if (!stage.isDirectory() || await realpath(stageDirectory) !== stageDirectory ||
      stage.dev !== (await lstat(directory)).dev || (await lstat(stagedPath)).dev !== stage.dev ||
      (process.platform !== 'win32' && ((stage.mode & 0o077) !== 0 || stage.uid !== process.getuid?.()))) {
    throw invalidStage();
  }
  await requireNoSidecars(stagedPath);
  if (await fingerprint(stagedPath, maxDatabaseBytes) !== stagedSha256) {
    throw new ActivationError('RESTORE_STAGE_CHANGED', 'The prepared file no longer matches its verification digest.');
  }
  verifyStandaloneDatabase(stagedPath);
  const staged = await open(stagedPath, 'r+');
  try { await staged.sync(); }
  finally { await staged.close(); }
  await requireDirectorySync(stageDirectory);
  await requireDirectorySync(directory);

  const rollback = await prepareRollbackSnapshot(lease, maxDatabaseBytes);
  let markerCreated = false;
  try {
    if (rollback.directorySync !== 'synced') {
      throw new ActivationError('RESTORE_SYNC_UNAVAILABLE', 'The rollback directory could not be synchronized.');
    }
    await requireNoSidecars(active);
    const activeSha256 = await fingerprint(active, maxDatabaseBytes);
    const rollbackSha256 = await fingerprint(rollback.path, maxDatabaseBytes);
    if (await fingerprint(stagedPath, maxDatabaseBytes) !== stagedSha256) {
      throw new ActivationError('RESTORE_STAGE_CHANGED', 'The prepared file changed before activation.');
    }

    const pending = join(directory, `.recovery-${randomUUID()}.tmp`);
    const marker = await open(pending, 'wx', 0o600);
    try {
      try {
        await marker.writeFile(JSON.stringify({
          version: 1,
          active: { name: basename(active), sha256: activeSha256 },
          staged: { directory: stageName, sha256: stagedSha256 },
          rollback: { directory: basename(rollback.directory), sha256: rollbackSha256 },
        }) + '\n', 'utf8');
        await marker.sync();
      } finally { await marker.close(); }
      // All cooperating writers hold the lease. Publish only a complete record.
      lease.assertRecoveryClear();
      await rename(pending, lease.recoveryMarkerPath);
      markerCreated = true;
      onPublished();
    } finally {
      if (!markerCreated) await unlink(pending);
    }
    await requireDirectorySync(directory);
  } catch (error) {
    if (!markerCreated) {
      try { await discardSnapshot(rollback.directory); }
      catch (cleanupError) {
        throw Object.assign(new AggregateError([error, cleanupError], 'The unused rollback copy could not be removed.'), {
          code: 'RESTORE_ROLLBACK_CLEANUP_FAILED', rollback,
        });
      }
    }
    throw error;
  }

  await rename(stagedPath, active);
  await requireNoSidecars(active);
  if (await fingerprint(active, maxDatabaseBytes) !== stagedSha256) {
    throw new ActivationError('RESTORE_ACTIVATION_INVALID', 'The active file does not match the prepared database.');
  }
  verifyStandaloneDatabase(active);
  await requireDirectorySync(stageDirectory);
  await requireDirectorySync(directory);
  return { rollback, markerRemovalSync: await clearRecoveryMarker(lease.recoveryMarkerPath) };

}

/** Call only after syncing a verified active file and its directory. */
export async function clearRecoveryMarker(markerPath: string): Promise<'confirmed' | 'unconfirmed'> {
  await unlink(markerPath);
  try {
    await requireDirectorySync(dirname(markerPath));
  } catch {
    // The verified swap is durable. The marker may reappear after a power failure.
    return 'unconfirmed';
  }
  return 'confirmed';
}
