import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initDatabase, initLeasedDatabase, rollbackInterruptedActivation } from '@cost-core/database';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux').each(['marker-write', 'after-marker', 'after-swap'] as const)('recovers from process interruption at %s', async phase => {
  const root = realpathSync.native(tmpdir());
  const directory = mkdtempSync(join(root, 'tzr-process-recovery-'));
  const active = join(directory, 'active.sqlite');
  try {
    const stageDirectory = mkdtempSync(join(directory, 'tzr-restore-'));
    const staged = join(stageDirectory, 'restored.sqlite');
    for (const [path, value] of [[active, 'before activation'], [staged, 'stage candidate']]) {
      const { sqlite } = initDatabase({ path });
      try {
        sqlite.exec('CREATE TABLE recovery_fixture(value TEXT NOT NULL)');
        sqlite.prepare('INSERT INTO recovery_fixture VALUES (?)').run(value);
        if (path === staged) sqlite.pragma('journal_mode = DELETE');
      } finally { sqlite.close(); }
    }
    const program = `
      import { promises as fs } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const phase = process.argv[1];
      const open = fs.open;
      fs.open = async (path, ...args) => {
        const file = await open(path, ...args);
        if (phase === 'marker-write' && (path.endsWith('/.recovery-pending') || (path.endsWith('.tmp') && path.includes('/.recovery-')))) {
          file.writeFile = async () => {
            await file.write('{');
            process.kill(process.pid, 'SIGKILL');
          };
        }
        return file;
      };
      const rename = fs.rename;
      fs.rename = async (source, target) => {
        await rename(source, target);
        if ((phase === 'after-marker' && target.endsWith('/.recovery-pending')) ||
            (phase === 'after-swap' && target === process.argv[2])) process.kill(process.pid, 'SIGKILL');
      };
      syncBuiltinESMExports();
      const { activateStagedDatabase } = await import('@cost-core/database');
      const [databasePath, stagedPath, stagedSha256] = process.argv.slice(2);
      await activateStagedDatabase({ databasePath, stagedPath, stagedSha256, maxDatabaseBytes: 1048576 });
    `;
    const stagedSha256 = createHash('sha256').update(readFileSync(staged)).digest('hex');
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program, '--', phase, active, staged, stagedSha256], {
      cwd: import.meta.dirname + '/..', env: {}, stdio: ['ignore', 'ignore', 'pipe'], timeout: 7000,
    });
    let childError = '';
    child.stderr?.on('data', chunk => { childError = (childError + String(chunk)).slice(-1024); });
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (_code, signal) => resolve(signal));
    });
    expect(signal, childError).toBe('SIGKILL');
    if (phase === 'marker-write') {
      expect(existsSync(staged)).toBe(true);
      expect(existsSync(join(directory, '.recovery-pending'))).toBe(false);
      const original = initLeasedDatabase(active);
      try { expect(original.sqlite.prepare('SELECT value FROM recovery_fixture').pluck().get()).toBe('before activation'); }
      finally { original.close(); }
      return;
    }
    expect(existsSync(staged)).toBe(phase === 'after-marker');
    expect(existsSync(join(directory, '.recovery-pending'))).toBe(true);
    expect(() => initLeasedDatabase(active)).toThrow(expect.objectContaining({ code: 'DATABASE_RECOVERY_PENDING' }));
    const marker = JSON.parse(readFileSync(join(directory, '.recovery-pending'), 'utf8'));
    const installed = createHash('sha256').update(readFileSync(active)).digest('hex');
    expect(installed).toBe(phase === 'after-swap' ? stagedSha256 : marker.active.sha256);

    await expect(rollbackInterruptedActivation({ databasePath: active, maxDatabaseBytes: 1024 * 1024 }))
      .resolves.toMatchObject({ status: 'rolled-back', markerRemovalSync: 'confirmed' });
    const restored = initLeasedDatabase(active);
    try { expect(restored.sqlite.prepare('SELECT value FROM recovery_fixture').pluck().get()).toBe('before activation'); }
    finally { restored.close(); }
  } finally {
    const resolved = realpathSync.native(directory);
    if (resolved !== directory || dirname(resolved) !== root) throw new Error('Unexpected process fixture path');
    rmSync(resolved, { recursive: true });
  }
}, 10000);
