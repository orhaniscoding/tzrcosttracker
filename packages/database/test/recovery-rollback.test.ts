import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDatabaseLease } from '../src/lease.js';
import * as recovery from '../src/recovery-rollback.js';

const root = realpathSync.native(tmpdir());
const dirs: string[] = [];
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function writeDb(path: string, label: string) {
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE records (label TEXT NOT NULL)');
    db.prepare('INSERT INTO records VALUES (?)').run(label);
  } finally { db.close(); }
}

function fixture() {
  const directory = mkdtempSync(join(root, 'tzr-recovery-test-'));
  dirs.push(directory);
  const active = join(directory, 'active.sqlite');
  const rollbackDir = join(directory, 'tzr-rollback-Test01');
  mkdirSync(rollbackDir, { mode: 0o700 });
  const rollback = join(rollbackDir, 'rollback.sqlite');
  writeDb(active, 'new active');
  writeDb(rollback, 'previous verified copy');
  const marker = join(directory, '.recovery-pending');
  const content = {
    version: 1,
    active: { name: 'active.sqlite', sha256: '1'.repeat(64) },
    staged: { directory: 'tzr-restore-Test01', sha256: hash(active) },
    rollback: { directory: 'tzr-rollback-Test01', sha256: hash(rollback) },
  };
  const writeMarker = () => writeFileSync(marker, JSON.stringify(content), { mode: 0o600 });
  writeMarker();
  return { active, rollback, marker, content, writeMarker, options: { databasePath: active, maxDatabaseBytes: 1024 * 1024 } };
}

afterEach(() => {
  for (const path of dirs.splice(0)) {
    const resolved = realpathSync.native(path);
    if (resolved !== path || dirname(resolved) !== root) throw new Error('Unexpected test cleanup path');
    rmSync(resolved, { recursive: true });
  }
});

describe('rollback of an interrupted activation', () => {
  it.skipIf(process.platform === 'win32')('restores the verified previous bytes and can safely retry', async () => {
    const { active, rollback, marker, options } = fixture();
    const expected = hash(rollback);
    const result = await recovery.rollbackInterruptedActivation(options);
    expect(result.status).toBe('rolled-back');
    expect(hash(active)).toBe(expected);
    expect(hash(rollback)).toBe(expected);
    expect(existsSync(marker)).toBe(false);
    await expect(recovery.rollbackInterruptedActivation(options)).resolves.toMatchObject({ status: 'no-pending-recovery' });
    acquireDatabaseLease(active).release();
  });

  it.skipIf(process.platform === 'win32')('finishes an interrupted retry after the previous file is already active', async () => {
    const { active, rollback, marker, options } = fixture();
    copyFileSync(rollback, active);
    await expect(recovery.rollbackInterruptedActivation(options)).resolves.toMatchObject({
      status: 'rolled-back', markerRemovalSync: 'confirmed',
    });
    expect(hash(active)).toBe(hash(rollback));
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects a marker with a parent path and leaves both databases intact', async () => {
    const { active, rollback, marker, content, writeMarker, options } = fixture();
    content.rollback.directory = '../outside';
    writeMarker();
    await expect(recovery.rollbackInterruptedActivation(options)).rejects.toMatchObject({ code: 'RESTORE_MARKER_INVALID' });
    expect(hash(active)).toBe(content.staged.sha256);
    expect(hash(rollback)).toBe(content.rollback.sha256);
    expect(existsSync(marker)).toBe(true);
  });

  it('stops at an unknown active database state and keeps recovery available', async () => {
    const { active, rollback, marker, content, options } = fixture();
    const db = new Database(active);
    try { db.prepare('UPDATE records SET label = ?').run('unexpected update'); }
    finally { db.close(); }
    const unknown = hash(active);
    await expect(recovery.rollbackInterruptedActivation(options)).rejects.toMatchObject({ code: 'RESTORE_ACTIVE_UNKNOWN' });
    expect(hash(active)).toBe(unknown);
    expect(hash(rollback)).toBe(content.rollback.sha256);
    expect(existsSync(marker)).toBe(true);
  });
});
