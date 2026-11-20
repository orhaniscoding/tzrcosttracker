import { createDecipheriv } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBlindIndex, encryptField } from '@cost-core/crypto';
import { AuditLogRepository, initDatabase, openReadOnlyDatabase } from '@cost-core/database';
import { buildFullBackupV2 } from '../src/services/backup-v2-export.service.js';
import { stageFullBackupV2ToDisk } from '../src/services/backup-v2-disk-stage.service.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, open: vi.fn(real.open) };
});

async function mockDirectoryHandle(handle: Pick<FileHandle, 'sync' | 'close'>) {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementation((path, flags, mode) =>
    flags === 'r' ? Promise.resolve(handle as FileHandle) : real.open(path, flags, mode));
}

vi.mock('@cost-core/database', async (importOriginal) => {
  const real = await importOriginal<typeof import('@cost-core/database')>();
  return { ...real, openReadOnlyDatabase: vi.fn(real.openReadOnlyDatabase) };
});

const password = 'synthetic disk staging password';
const sourceKey = Buffer.alloc(32, 21);
const sourcePepper = Buffer.alloc(32, 31);
const masterKey = Buffer.alloc(32, 71);
const blindIndexPepper = Buffer.alloc(32, 81);
const timestamp = '2026-06-01T12:00:00.000Z';
const now = new Date('2026-06-02T12:00:00.000Z');
const temporaryParents: { path: string; base: string }[] = [];

async function fixture(missingWallet = false) {
  const base = await realpath(tmpdir());
  const stagingDirectory = await mkdtemp(join(base, 'tzr-disk-stage-test-'));
  temporaryParents.push({ path: stagingDirectory, base });
  const { sqlite, db } = initDatabase({ path: ':memory:' });
  try {
    sqlite.prepare(`INSERT INTO users (id, username, email, full_name, password_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('u', 'test', 'test@example.test', 'Synthetic User', 'synthetic', 'admin', timestamp, timestamp);
    sqlite.prepare(`INSERT INTO accounts (id, name, name_blind_index, balance_encrypted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('w', 'Synthetic Wallet', createBlindIndex('Synthetic Wallet', sourcePepper),
      encryptField('147.50', sourceKey), timestamp, timestamp);
    if (missingWallet) {
      sqlite.prepare('INSERT INTO categories (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('c', 'Synthetic Category', timestamp, timestamp);
      sqlite.prepare(`INSERT INTO transactions (id, type, date, amount_encrypted, base_amount_encrypted, category_id,
        title_encrypted, title_blind_index, account_from_id, created_by_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        't', 'expense', timestamp, encryptField('11', sourceKey), encryptField('11', sourceKey), 'c',
        encryptField('Synthetic Expense', sourceKey), createBlindIndex('Synthetic Expense', sourcePepper),
        'missing-wallet', 'u', timestamp, timestamp);
    }
    const sessions = sqlite.prepare('INSERT INTO auth_sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?)');
    sessions.run('active', 'u', 100, 10_000, null);
    sessions.run('revoked', 'u', 100, 10_000, 5000);
    const audit = new AuditLogRepository(db);
    audit.logAction({ userId: 'u', action: 'CREATE', entity: 'wallet', entityId: 'w' }, sourceKey);
    audit.logAction({ userId: 'u', action: 'UPDATE', entity: 'wallet', entityId: 'w', newState: { status: 'synthetic' } }, sourceKey);
    const auditOrder = sqlite.prepare('SELECT id FROM audit_logs ORDER BY rowid').pluck().all();
    const { vault } = await buildFullBackupV2({ sqlite, password, masterKey: sourceKey, blindIndexPepper: sourcePepper });
    return { input: { vaultData: vault, password, masterKey, blindIndexPepper, now, stagingDirectory }, auditOrder };
  } finally {
    sqlite.close();
  }
}

afterEach(async () => {
  vi.mocked(open).mockReset();
  vi.mocked(openReadOnlyDatabase).mockClear();
  for (const { path, base } of temporaryParents.splice(0)) {
    const resolved = await realpath(path);
    if (resolved !== path || dirname(resolved) !== base) throw new Error('Unexpected test cleanup path');
    await rm(path, { recursive: true });
  }
});

describe('private V2 SQLite file staging', () => {
  it('refuses to stage a backup with unresolved wallet references', async () => {
    const { input } = await fixture(true);
    await expect(stageFullBackupV2ToDisk(input)).rejects.toMatchObject({ code: 'RESTORE_WALLET_RECONCILIATION_REQUIRED' });
    expect(await readdir(input.stagingDirectory)).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });


  it('persists a verified V2 restore in one file and leaves an existing file intact', async () => {
    const { input, auditOrder } = await fixture();
    const existing = join(input.stagingDirectory, 'restored.sqlite');
    await writeFile(existing, 'synthetic existing file');

    const result = await stageFullBackupV2ToDisk(input);
    expect(dirname(result.directory)).toBe(input.stagingDirectory);
    expect(dirname(result.path)).toBe(result.directory);
    expect(await readFile(existing, 'utf8')).toBe('synthetic existing file');
    expect(await readdir(result.directory)).toEqual(['restored.sqlite']);
    expect(result.tableCounts).toMatchObject({ accounts: 1, users: 1, audit_logs: 2, auth_sessions: 2 });
    expect(result.revokedSessions).toBe(1);
    expect(result.missingWalletReferences).toBe(0);
    if (process.platform !== 'win32') {
      expect((await lstat(result.directory)).mode & 0o077).toBe(0);
      expect((await lstat(result.path)).mode & 0o077).toBe(0);
      expect(result.directorySync).toBe('synced');
    } else {
      expect(['synced', 'unsupported']).toContain(result.directorySync);
    }

    const { sqlite, db } = openReadOnlyDatabase(result.path);
    try {
      expect(sqlite.readonly).toBe(true);
      expect(sqlite.pragma('journal_mode', { simple: true })).toBe('delete');
      expect(sqlite.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(sqlite.prepare('SELECT id FROM audit_logs ORDER BY rowid').pluck().all()).toEqual(auditOrder);
      expect(new AuditLogRepository(db).verifyChainIntegrity(masterKey)).toEqual({ valid: true, count: 2 });
      expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions ORDER BY id').pluck().all())
        .toEqual([now.getTime() / 1000, 5000]);
      const wallet = sqlite.prepare('SELECT balance_encrypted, name_blind_index FROM accounts WHERE id = ?').get('w') as
        { balance_encrypted: string; name_blind_index: string };
      const [, , nonce, tag, ciphertext] = wallet.balance_encrypted.split(':');
      const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(nonce, 'hex'));
      decipher.setAuthTag(Buffer.from(tag, 'hex'));
      const raw = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]);
      expect(raw.toString('utf8')).toBe('147.50');
      expect(wallet.name_blind_index).toBe(createBlindIndex('Synthetic Wallet', blindIndexPepper));
    } finally {
      sqlite.close();
    }
  });

  it('does not leave a stage after password verification fails', async () => {
    const { input } = await fixture();
    await expect(stageFullBackupV2ToDisk({ ...input, password: 'different synthetic password' })).rejects.toBeInstanceOf(Error);
    expect(await readdir(input.stagingDirectory)).toEqual([]);
  });

  it('discards a file that fails reopened SQLite verification', async () => {
    const { input } = await fixture();
    const originalOpen = (await vi.importActual<typeof import('@cost-core/database')>('@cost-core/database')).openReadOnlyDatabase;
    vi.mocked(openReadOnlyDatabase).mockImplementationOnce((path) => {
      writeFileSync(path, 'synthetic damaged SQLite file');
      return originalOpen(path);
    });
    await expect(stageFullBackupV2ToDisk(input)).rejects.toMatchObject({ code: 'RESTORE_STAGE_INVALID' });
    expect(await readdir(input.stagingDirectory)).toEqual([]);
  });

  it('keeps a staged file after an unsupported directory sync only on Windows', async () => {
    const { input } = await fixture();
    const close = vi.fn().mockResolvedValue(undefined);
    const syncError = Object.assign(new Error('synthetic directory sync error'), { code: 'EINVAL' });
    await mockDirectoryHandle({ sync: vi.fn().mockRejectedValue(syncError), close });

    if (process.platform === 'win32') {
      const result = await stageFullBackupV2ToDisk(input);
      expect(result.directorySync).toBe('unsupported');
      expect(await readdir(result.directory)).toEqual(['restored.sqlite']);
    } else {
      await expect(stageFullBackupV2ToDisk(input)).rejects.toMatchObject({ code: 'RESTORE_STAGE_FAILED' });
      expect(await readdir(input.stagingDirectory)).toEqual([]);
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('discards the stage when closing a synced directory fails', async () => {
    const { input } = await fixture();
    const closeError = Object.assign(new Error('synthetic directory close error'), { code: 'EPERM' });
    await mockDirectoryHandle({ sync: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockRejectedValue(closeError) });

    await expect(stageFullBackupV2ToDisk(input)).rejects.toMatchObject({ code: 'RESTORE_STAGE_FAILED' });
    expect(await readdir(input.stagingDirectory)).toEqual([]);
  });

  it('rejects and cleans up unexpected SQLite sidecars', async () => {
    const { input } = await fixture();
    const originalOpen = (await vi.importActual<typeof import('@cost-core/database')>('@cost-core/database')).openReadOnlyDatabase;
    vi.mocked(openReadOnlyDatabase).mockImplementationOnce((path) => {
      const database = originalOpen(path);
      writeFileSync(`${path}-shm`, 'synthetic sidecar');
      return database;
    });

    await expect(stageFullBackupV2ToDisk(input)).rejects.toMatchObject({ code: 'RESTORE_STAGE_INVALID' });
    expect(await readdir(input.stagingDirectory)).toEqual([]);
  });

  it('does not create a database when its read-only target is missing', async () => {
    const { input } = await fixture();
    expect(() => openReadOnlyDatabase(join(input.stagingDirectory, 'missing.sqlite'))).toThrow();
    expect(await readdir(input.stagingDirectory)).toEqual([]);
  });

  it('rejects a directory redirect before creating a file', async () => {
    const { input } = await fixture();
    const alias = join(input.stagingDirectory, 'alias');
    await symlink(input.stagingDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(stageFullBackupV2ToDisk({ ...input, stagingDirectory: alias })).rejects.toMatchObject({ code: 'RESTORE_STAGE_PATH_INVALID' });
    expect(await readdir(input.stagingDirectory)).toEqual(['alias']);
  });

  it.skipIf(process.platform === 'win32')('rejects a directory with access for other Unix users', async () => {
    const { input } = await fixture();
    await chmod(input.stagingDirectory, 0o755);
    await expect(stageFullBackupV2ToDisk(input)).rejects.toMatchObject({ code: 'RESTORE_STAGE_PATH_INVALID' });
    expect(await readdir(input.stagingDirectory)).toEqual([]);
  });
});
