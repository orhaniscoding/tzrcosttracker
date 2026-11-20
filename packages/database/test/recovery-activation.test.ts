import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireDatabaseLease } from '../src/lease.js';
import * as recovery from '../src/recovery-activation.js';
import { syncDirectory } from '../src/rollback-snapshot.js';

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, rename: vi.fn(fs.rename), unlink: vi.fn(fs.unlink) };
});

vi.mock('../src/rollback-snapshot.js', async importOriginal => {
  const snapshot = await importOriginal<typeof import('../src/rollback-snapshot.js')>();
  return { ...snapshot, syncDirectory: vi.fn(snapshot.syncDirectory) };
});

const root = realpathSync.native(tmpdir());
const dirs: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(root, 'tzr-activation-test-'));
  dirs.push(directory);
  const active = join(directory, 'active.sqlite');
  const stageDirectory = mkdtempSync(join(directory, 'tzr-restore-'));
  const staged = join(stageDirectory, 'restored.sqlite');
  for (const [path, value] of [[active, 'old'], [staged, 'restored']]) {
    const sqlite = new Database(path);
    try {
      sqlite.exec('CREATE TABLE items (name TEXT NOT NULL)');
      sqlite.prepare('INSERT INTO items VALUES (?)').run(value);
    } finally { sqlite.close(); }
  }
  return {
    directory, active, staged,
    options: { databasePath: active, stagedPath: staged, stagedSha256: digest(staged), maxDatabaseBytes: 1024 * 1024 },
  };
}

function digest(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function read(path: string) {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try { return sqlite.prepare('SELECT name FROM items').pluck().get(); }
  finally { sqlite.close(); }
}

afterEach(() => {
  vi.mocked(rename).mockReset();
  vi.mocked(unlink).mockReset();
  vi.mocked(syncDirectory).mockReset();
  for (const path of dirs.splice(0)) {
    const resolved = realpathSync.native(path);
    if (resolved !== path || dirname(resolved) !== root) throw new Error('Unexpected test cleanup path');
    rmSync(resolved, { recursive: true });
  }
});

describe('offline database activation', () => {
  it.skipIf(process.platform === 'win32')('installs the prepared database and retains the verified previous copy', async () => {
    const { active, staged, directory, options } = fixture();
    const result = await recovery.activateStagedDatabase(options);
    expect(read(active)).toBe('restored');
    expect(read(result.rollback.path)).toBe('old');
    expect(digest(active)).toBe(options.stagedSha256);
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(join(directory, '.recovery-pending'))).toBe(false);
    expect(basename(result.rollback.path)).toBe('rollback.sqlite');
    acquireDatabaseLease(active).release();
  });

  it.skipIf(process.platform === 'win32')('retains recovery evidence and blocks startup when the swap fails', async () => {
    const { active, staged, directory, options } = fixture();
    const failure = new Error('simulated rename failure');
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(rename).mockImplementation(async (from, to) => {
      if (to !== active) return fs.rename(from, to);
      expect(() => acquireDatabaseLease(active)).toThrow(expect.objectContaining({ code: 'DATABASE_IN_USE' }));
      const marker = JSON.parse(readFileSync(join(directory, '.recovery-pending'), 'utf8'));
      expect(marker.version).toBe(1);
      expect(marker.active).toEqual({ name: 'active.sqlite', sha256: digest(active) });
      expect(marker.staged).toEqual({ directory: basename(dirname(staged)), sha256: options.stagedSha256 });
      const rollbackPath = join(directory, marker.rollback.directory, 'rollback.sqlite');
      expect(marker.rollback.sha256).toBe(digest(rollbackPath));
      expect(read(rollbackPath)).toBe('old');
      throw failure;
    });
    await expect(recovery.activateStagedDatabase(options)).rejects.toBe(failure);
    expect(read(active)).toBe('old');
    expect(read(staged)).toBe('restored');
    const lease = acquireDatabaseLease(active);
    try { expect(() => lease.assertRecoveryClear()).toThrow(expect.objectContaining({ code: 'DATABASE_RECOVERY_PENDING' })); }
    finally { lease.release(); }
  });

  it('stops before changing either file when durable directory updates are unavailable', async () => {
    const { active, staged, directory, options } = fixture();
    vi.mocked(syncDirectory).mockResolvedValueOnce(false);
    await expect(recovery.activateStagedDatabase(options)).rejects.toMatchObject({ code: 'RESTORE_SYNC_UNAVAILABLE' });
    expect(read(active)).toBe('old');
    expect(read(staged)).toBe('restored');
    expect(readdirSync(directory).some(name => name.startsWith('tzr-rollback-'))).toBe(false);
    expect(existsSync(join(directory, '.recovery-pending'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('cleans its unused rollback copy if the stage changes before writing the marker', async () => {
    const { active, staged, directory, options } = fixture();
    vi.mocked(syncDirectory).mockImplementationOnce(async () => true).mockImplementationOnce(async () => {
      const sqlite = new Database(staged);
      try { sqlite.prepare('UPDATE items SET name = ?').run('changed since verification'); }
      finally { sqlite.close(); }
      return true;
    });
    await expect(recovery.activateStagedDatabase(options)).rejects.toMatchObject({ code: 'RESTORE_STAGE_CHANGED' });
    expect(read(active)).toBe('old');
    expect(read(staged)).toBe('changed since verification');
    expect(readdirSync(directory).some(name => name.startsWith('tzr-rollback-'))).toBe(false);
    expect(existsSync(join(directory, '.recovery-pending'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('reports the committed swap and previous copy when marker removal cannot be synced', async () => {
    const { active, directory, options } = fixture();
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(unlink).mockImplementationOnce(async path => {
      await fs.unlink(path);
      vi.mocked(syncDirectory).mockRejectedValueOnce(new Error('simulated directory sync failure'));
    });
    const result = await recovery.activateStagedDatabase(options);
    expect(result.markerRemovalSync).toBe('unconfirmed');
    expect(read(result.rollback.path)).toBe('old');
    expect(read(active)).toBe('restored');
    expect(existsSync(join(directory, '.recovery-pending'))).toBe(false);
  });

  it('rejects a changed staged file before making a rollback copy', async () => {
    const { active, staged, directory, options } = fixture();
    const sqlite = new Database(staged);
    try { sqlite.prepare('UPDATE items SET name = ?').run('different'); }
    finally { sqlite.close(); }
    await expect(recovery.activateStagedDatabase(options)).rejects.toMatchObject({ code: 'RESTORE_STAGE_CHANGED' });
    expect(read(active)).toBe('old');
    expect(readdirSync(directory).some(name => name.startsWith('tzr-rollback-'))).toBe(false);
    expect(existsSync(join(directory, '.recovery-pending'))).toBe(false);
  });

  it('refuses activation while the server holds the shared lease', async () => {
    const { active, directory, options } = fixture();
    const lease = acquireDatabaseLease(active);
    try {
      const before = readdirSync(directory);
      await expect(recovery.activateStagedDatabase(options)).rejects.toMatchObject({ code: 'DATABASE_IN_USE' });
      expect(readdirSync(directory)).toEqual(before);
    } finally { lease.release(); }
  });
});
