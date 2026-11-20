import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveKey } from '@cost-core/crypto';
import { acquireDatabaseLease, initDatabase, openReadOnlyDatabase } from '@cost-core/database';
import { buildFullBackupV2 } from '../src/services/backup-v2-export.service.js';
import * as recovery from '../src/recovery-cli.js';

const masterKey = 'synthetic-destination-key-32-bytes';
const pepper = 'synthetic-index-pepper-32-bytes-min';
const backupPassword = '  synthetic backup password\n  \r\n';
const roots: { base: string; folder: string }[] = [];

async function fixture() {
  const base = await realpath(tmpdir());
  const folder = await mkdtemp(join(base, 'tzr-cli-recovery-'));
  roots.push({ base, folder });
  const active = join(folder, 'active.sqlite');
  const file = join(folder, 'sample.vault');
  const { sqlite } = initDatabase({ path: active });
  sqlite.close();
  const source = initDatabase();
  try {
    source.sqlite.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('restored-category', 'Restored category', '2026-11-19', '2026-11-19');
    const { vault } = await buildFullBackupV2({ sqlite: source.sqlite, password: backupPassword,
      masterKey: deriveKey(masterKey), blindIndexPepper: pepper });
    await writeFile(file, vault, { mode: 0o600 });
  } finally { source.sqlite.close(); }
  const args = ['restore', active, '1048576', file];
  return { folder, active, args, readKeys: () => ({ masterKey, blindIndexPepper: pepper }) };
}

afterEach(async () => {
  for (const { base, folder } of roots.splice(0)) {
    const absolute = await realpath(folder);
    if (absolute !== folder || dirname(absolute) !== base) throw new Error('Unexpected test directory');
    await rm(absolute, { recursive: true });
  }
});

describe('offline backup command', () => {
  it('rejects a malformed argument list before reading setup or keys', async () => {
    await expect(recovery.runRecoveryCommand(['restore'], Readable.from([]), () => { throw new Error('keys accessed'); }))
      .rejects.toMatchObject({ code: 'RECOVERY_USAGE' });
  });

  it('rejects an oversized password before staging a database', async () => {
    const { args, folder, readKeys } = await fixture();
    const before = await readdir(folder);
    await expect(recovery.runRecoveryCommand(args, Readable.from([Buffer.alloc(259, 97)]), readKeys))
      .rejects.toMatchObject({ code: 'RECOVERY_PASSWORD_INVALID' });
    expect(await readdir(folder)).toEqual(before);
  });

  it('leaves no prepared copy if the active database is leased', async () => {
    const { args, active, folder, readKeys } = await fixture();
    const lease = acquireDatabaseLease(active);
    try {
      const before = await readdir(folder);
      await expect(recovery.runRecoveryCommand(args, Readable.from([Buffer.from(backupPassword)]), readKeys))
        .rejects.toMatchObject({ code: 'DATABASE_IN_USE' });
      expect(await readdir(folder)).toEqual(before);
    } finally { lease.release(); }
  });

  it('removes its own prepared copy when it exceeds the size budget', async () => {
    const { args, folder, readKeys } = await fixture();
    const before = await readdir(folder);
    args[2] = '1';
    await expect(recovery.runRecoveryCommand(args, Readable.from([Buffer.from(backupPassword)]), readKeys))
      .rejects.toMatchObject({ code: 'RESTORE_FILE_INVALID' });
    const after = await readdir(folder);
    expect(after.filter(name => name !== '.costcore-lease.sqlite')).toEqual(before);
  });

  it.runIf(process.platform === 'linux')('runs the compiled CLI with an exact stdin password and reports the rollback copy', async () => {
    const { args, active } = await fixture();
    const child = spawn(process.execPath, ['dist/recovery-cli.js', ...args], {
      cwd: import.meta.dirname + '/..',
      env: { MASTER_KEY: masterKey, BLIND_INDEX_PEPPER: pepper, JWT_SECRET: 'synthetic-jwt-secret-for-offline-cli-test' },
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.stdin?.once('error', reject);
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdin?.end(Buffer.from(backupPassword));
    await expect(done, stderr).resolves.toEqual({ code: 0, signal: null });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ status: 'restored', markerRemovalSync: 'confirmed' });
    const previous = openReadOnlyDatabase(result.rollback);
    try { expect(previous.sqlite.prepare('SELECT name FROM categories WHERE id = ?').get('restored-category')).toBeUndefined(); }
    finally { previous.sqlite.close(); }
    const current = openReadOnlyDatabase(active);
    try { expect(current.sqlite.prepare('SELECT name FROM categories WHERE id = ?').pluck().get('restored-category')).toBe('Restored category'); }
    finally { current.sqlite.close(); }
  }, 10000);
});
