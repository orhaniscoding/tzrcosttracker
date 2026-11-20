import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { systemRoutes } from '../src/routes/system.routes.js';

vi.mock('../src/routes/system.routes.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/routes/system.routes.js')>();
  return { systemRoutes: vi.fn(original.systemRoutes) };
});

function childStarted(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Lease child did not start')), 5000);
    child.once('message', (message) => {
      clearTimeout(deadline);
      if (message === 'LEASE_HELD') resolve();
      else reject(new Error('Unexpected lease child response'));
    });
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('exit', (code) => { clearTimeout(deadline); reject(new Error(`Lease child exited before readiness (${code})`)); });
  });
}

const config = {
  jwtSecret: 'synthetic-lifecycle-test-jwt-secret',
  masterKey: 'synthetic-lifecycle-test-master-key',
  blindIndexPepper: 'synthetic-lifecycle-test-index-pepper',
};

let folder: string;
let databasePath: string;
let apps: FastifyInstance[];

async function openApp(path = databasePath) {
  const app = await buildApp({ config, dbPath: path });
  apps.push(app);
  return app;
}

async function openOutcome(path = databasePath) {
  try {
    await openApp(path);
    return 'OPENED';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
}

beforeEach(() => {
  folder = mkdtempSync(join(realpathSync.native(tmpdir()), 'tzr-database-lifecycle-'));
  databasePath = join(folder, 'active.sqlite');
  apps = [];
});

afterEach(async () => {
  for (const app of apps.reverse()) await app.close();
  // Only remove the fresh, synthetic fixture created in beforeEach.
  const resolved = realpathSync.native(folder);
  if (dirname(resolved) !== realpathSync.native(tmpdir()) || !basename(resolved).startsWith('tzr-database-lifecycle-')) {
    throw new Error('Unexpected synthetic fixture path');
  }
  rmSync(resolved, { recursive: true, force: true });
});

describe('on-disk database lifecycle', () => {
  it('blocks a second app until the first closes, then opens the same data', async () => {
    const first = await openApp();
    first.sqlite.exec('CREATE TABLE lifecycle_fixture(value TEXT NOT NULL)');
    first.sqlite.prepare('INSERT INTO lifecycle_fixture(value) VALUES (?)').run('committed');

    expect(await openOutcome()).toBe('DATABASE_IN_USE');
    expect(first.sqlite.open).toBe(true);
    await first.close();
    expect(first.sqlite.open).toBe(false);

    const second = await openApp();
    expect(second.sqlite.prepare('SELECT value FROM lifecycle_fixture').get()).toEqual({ value: 'committed' });
  });

  it('refuses to create a missing database while a recovery marker exists', async () => {
    const marker = join(folder, '.recovery-pending');
    writeFileSync(marker, 'interrupted synthetic restore', { flag: 'wx' });

    expect(await openOutcome()).toBe('DATABASE_RECOVERY_PENDING');
    expect(await openOutcome(join(folder, 'other.sqlite'))).toBe('DATABASE_RECOVERY_PENDING');
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(join(folder, 'other.sqlite'))).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe('interrupted synthetic restore');
  });

  it('releases the lease after failed initialization so an operator can retry', async () => {
    writeFileSync(databasePath, 'not a sqlite database', { flag: 'wx' });
    await expect(openApp()).rejects.toMatchObject({ code: 'SQLITE_NOTADB' });
    writeFileSync(databasePath, '');

    const app = await openApp();
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('rejects a hard-linked data file instead of creating a second lease for the same file', async () => {
    const first = await openApp();
    const alias = join(folder, 'alias.sqlite');
    linkSync(databasePath, alias);
    expect(await openOutcome(alias)).toBe('DATABASE_PATH_INVALID');
    expect(first.sqlite.open).toBe(true);
  });

  it('serializes different paths into the same data directory and allows a separate directory', async () => {
    const dataDirectory = join(folder, 'data');
    const alias = join(folder, 'mount');
    const separate = join(folder, 'separate');
    mkdirSync(dataDirectory);
    mkdirSync(separate);
    symlinkSync(dataDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');

    await openApp(join(dataDirectory, 'active.sqlite'));
    expect(await openOutcome(join(alias, 'active.sqlite'))).toBe('DATABASE_IN_USE');
    expect(await openOutcome(join(dataDirectory, 'other.sqlite'))).toBe('DATABASE_IN_USE');
    expect(await openOutcome(join(separate, 'active.sqlite'))).toBe('OPENED');
  });

  it('rejects parent traversal through a directory alias before touching either data directory', async () => {
    const tenant = join(folder, 'tenant');
    const child = join(tenant, 'child');
    const alias = join(folder, 'alias');
    mkdirSync(child, { recursive: true });
    symlinkSync(child, alias, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(tenant, '.recovery-pending'), '', { flag: 'wx' });

    // Preserve the raw components; path.join would normalize the parent traversal.
    expect(await openOutcome(`${alias}${sep}..${sep}active.sqlite`)).toBe('DATABASE_PATH_INVALID');
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(join(tenant, 'active.sqlite'))).toBe(false);
    expect(existsSync(join(folder, '.costcore-lease.sqlite'))).toBe(false);
    expect(existsSync(join(tenant, '.costcore-lease.sqlite'))).toBe(false);
  });

  it('rejects names that the driver would trim and protects its coordination file', async () => {
    expect(await openOutcome(databasePath + ' ')).toBe('DATABASE_PATH_INVALID');
    expect(existsSync(databasePath)).toBe(false);

    expect(await openOutcome(join(folder, '.costcore-lease.sqlite'))).toBe('DATABASE_PATH_INVALID');
    expect(existsSync(join(folder, '.costcore-lease.sqlite'))).toBe(false);
  });

  it('releases the lease if route registration fails after SQLite initializes', async () => {
    vi.mocked(systemRoutes).mockImplementationOnce(async () => {
      throw Object.assign(new Error('Synthetic route registration failure'), { code: 'TEST_STARTUP_FAILED' });
    });

    expect(await openOutcome()).toBe('TEST_STARTUP_FAILED');
    expect(await openOutcome()).toBe('OPENED');
  });

  it.each([false, true])('releases the process lock after abrupt exit (pending recovery: %s)', async (pendingRecovery) => {
    const program = `
      import { initLeasedDatabase } from '@cost-core/database';
      const database = initLeasedDatabase(process.argv[1]);
      database.sqlite.exec('CREATE TABLE child_fixture(value TEXT NOT NULL)');
      database.sqlite.prepare('INSERT INTO child_fixture(value) VALUES (?)').run('committed in WAL');
      process.send('LEASE_HELD');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program, '--', databasePath], {
      cwd: import.meta.dirname + '/..',
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const childClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    try {
      await childStarted(child);
      expect(await openOutcome()).toBe('DATABASE_IN_USE');
      if (pendingRecovery) writeFileSync(join(folder, '.recovery-pending'), '', { flag: 'wx' });
    } finally {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await childClosed;
    }

    if (pendingRecovery) {
      expect(await openOutcome()).toBe('DATABASE_RECOVERY_PENDING');
    } else {
      const app = await openApp();
      expect(app.sqlite.prepare('SELECT value FROM child_fixture').get()).toEqual({ value: 'committed in WAL' });
    }
  }, 10000);
});
