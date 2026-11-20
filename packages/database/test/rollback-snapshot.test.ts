import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDatabaseLease } from '../src/lease.js';
import * as rollback from '../src/rollback-snapshot.js';

const root = realpathSync.native(tmpdir());
const dirs: string[] = [];
const handles: Database.Database[] = [];
const options = { maxSourceBytes: 1024 * 1024 };

function fixture() {
  const dir = mkdtempSync(join(root, 'tzr-rollback-test-'));
  dirs.push(dir);
  return { dir, databasePath: join(dir, 'active.sqlite') };
}

function open(path: string, options: Database.Options = {}): Database.Database {
  const sqlite = new Database(path, { timeout: 0, ...options });
  handles.push(sqlite);
  return sqlite;
}

function openWal(path: string): Database.Database {
  const sqlite = open(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('wal_autocheckpoint = 0');
  sqlite.exec('CREATE TABLE entries (value TEXT NOT NULL)');
  sqlite.prepare('INSERT INTO entries VALUES (?)').run('before-reader');
  return sqlite;
}

afterEach(() => {
  for (const handle of handles.splice(0).reverse()) if (handle.open) handle.close();
  for (const dir of dirs.splice(0)) {
    const canonical = realpathSync.native(dir);
    if (canonical !== dir || dirname(canonical) !== root) throw new Error('Unexpected temporary cleanup path');
    rmSync(canonical, { recursive: true });
  }
});

describe('offline rollback snapshot', () => {
  it('preserves committed WAL rows and original rowids in a standalone copy', async () => {
    const { dir, databasePath } = fixture();
    const writer = openWal(databasePath);
    writer.prepare('INSERT INTO entries (rowid, value) VALUES (?, ?)').run(7, 'latest-commit');
    writer.exec('BEGIN');
    writer.prepare('INSERT INTO entries VALUES (?)').run('uncommitted');
    writer.exec('ROLLBACK');
    expect(lstatSync(databasePath + '-wal').size).toBeGreaterThan(0);

    const result = await rollback.createRollbackSnapshot(databasePath, options);
    expect(dirname(result.directory)).toBe(dir);
    expect(dirname(result.path)).toBe(result.directory);
    expect(readdirSync(result.directory)).toEqual(['rollback.sqlite']);
    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(join(dir, '.recovery-pending'))).toBe(false);
    const copy = open(result.path, { readonly: true, fileMustExist: true });
    expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(copy.prepare('SELECT rowid, value FROM entries ORDER BY rowid').all()).toEqual([
      { rowid: 1, value: 'before-reader' }, { rowid: 7, value: 'latest-commit' },
    ]);
    if (process.platform !== 'win32') {
      expect(result.directorySync).toBe('synced');
      expect(lstatSync(result.path).mode & 0o077).toBe(0);
    }
    const lease = acquireDatabaseLease(databasePath);
    lease.release();
  });

  it('fails closed on a busy checkpoint and keeps the committed source intact', async () => {
    const { dir, databasePath } = fixture();
    const writer = openWal(databasePath);
    const reader = open(databasePath, { readonly: true, fileMustExist: true });
    reader.exec('BEGIN');
    expect(reader.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(1);
    writer.prepare('INSERT INTO entries VALUES (?)').run('committed-behind-reader');

    await expect(rollback.createRollbackSnapshot(databasePath, options)).rejects.toMatchObject({ code: 'ROLLBACK_CHECKPOINT_BUSY' });
    expect(readdirSync(dir).filter(name => name.startsWith('tzr-rollback-'))).toEqual([]);
    expect(writer.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(2);
    expect(reader.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(1);
    reader.close();
    const copy = await rollback.createRollbackSnapshot(databasePath, options);
    expect(existsSync(copy.path)).toBe(true);
  });

  it('refuses a cooperating server lease without creating a rollback directory', async () => {
    const { dir, databasePath } = fixture();
    const writer = openWal(databasePath);
    writer.close();
    const lease = acquireDatabaseLease(databasePath);
    try {
      const before = readdirSync(dir);
      await expect(rollback.createRollbackSnapshot(databasePath, options)).rejects.toMatchObject({ code: 'DATABASE_IN_USE' });
      expect(readdirSync(dir)).toEqual(before);
    } finally { lease.release(); }
  });

  it('enforces the byte budget for both the database and the committed WAL', async () => {
    const { dir, databasePath } = fixture();
    const writer = openWal(databasePath);
    const databaseBytes = lstatSync(databasePath).size;
    const walBytes = lstatSync(databasePath + '-wal').size;
    expect(walBytes).toBeGreaterThan(0);
    await expect(rollback.createRollbackSnapshot(databasePath, { maxSourceBytes: databaseBytes }))
      .rejects.toMatchObject({ code: 'ROLLBACK_SOURCE_TOO_LARGE' });
    expect(lstatSync(databasePath + '-wal').size).toBe(walBytes);
    expect(readdirSync(dir).filter(name => name.startsWith('tzr-rollback-'))).toEqual([]);
    expect(writer.prepare('SELECT count(*) FROM entries').pluck().get()).toBe(1);
  });

  it('keeps a pending recovery marker and creates no snapshot', async () => {
    const { dir, databasePath } = fixture();
    openWal(databasePath).close();
    const marker = join(dir, '.recovery-pending');
    writeFileSync(marker, 'synthetic pending recovery');
    await expect(rollback.createRollbackSnapshot(databasePath, options)).rejects.toMatchObject({ code: 'DATABASE_RECOVERY_PENDING' });
    expect(existsSync(marker)).toBe(true);
    expect(readdirSync(dir).filter(name => name.startsWith('tzr-rollback-'))).toEqual([]);
  });

  it('discards the incomplete snapshot after finding a foreign key violation', async () => {
    const { dir, databasePath } = fixture();
    const writer = openWal(databasePath);
    writer.pragma('foreign_keys = OFF');
    writer.exec('CREATE TABLE parents (id INTEGER PRIMARY KEY); CREATE TABLE children (parent_id INTEGER REFERENCES parents(id));');
    writer.prepare('INSERT INTO children VALUES (?)').run(123);
    await expect(rollback.createRollbackSnapshot(databasePath, options)).rejects.toMatchObject({ code: 'ROLLBACK_SNAPSHOT_INVALID' });
    expect(readdirSync(dir).filter(name => name.startsWith('tzr-rollback-'))).toEqual([]);
    expect(writer.prepare('SELECT parent_id FROM children').pluck().get()).toBe(123);
    const lease = acquireDatabaseLease(databasePath);
    lease.release();
  });

  it('requires an existing source and does not create one', async () => {
    const { dir, databasePath } = fixture();
    await expect(rollback.createRollbackSnapshot(databasePath, options)).rejects.toMatchObject({ code: 'ROLLBACK_SOURCE_INVALID' });
    expect(readdirSync(dir)).toEqual([]);
  });
});
