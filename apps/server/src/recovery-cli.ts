import { constants } from 'node:fs';
import { lstat, open, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { deriveKey } from '@cost-core/crypto';
import { prepareAndActivateDatabase, rollbackInterruptedActivation } from '@cost-core/database';
import { loadConfig, type AppConfig } from './config.js';
import { stageFullBackupV2ToDisk } from './services/backup-v2-disk-stage.service.js';

const maxVaultBytes = 140 * 1024 * 1024;
const maxPasswordBytes = 256;
const usage = 'Usage: recovery-cli.js restore <absolute-database-path> <max-database-bytes> <absolute-vault-path> | rollback <absolute-database-path> <max-database-bytes>';
type RecoveryKeys = Pick<AppConfig, 'masterKey' | 'blindIndexPepper'>;

class RecoveryCommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

async function readPassword(input: Readable): Promise<string> {
  const reserved = Buffer.alloc(maxPasswordBytes);
  let filled = 0;
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (filled + bytes.length > reserved.length) {
        throw new RecoveryCommandError('RECOVERY_PASSWORD_INVALID', 'Read one backup password from stdin.');
      }
      bytes.copy(reserved, filled);
      filled += bytes.length;
    }
    const password = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(reserved.subarray(0, filled));
    if (filled < 12) {
      throw new RecoveryCommandError('RECOVERY_PASSWORD_INVALID', 'Read one backup password from stdin.');
    }
    return password;
  } catch (error) {
    if (error instanceof RecoveryCommandError) throw error;
    throw new RecoveryCommandError('RECOVERY_PASSWORD_INVALID', 'Read one UTF-8 backup password from stdin.');
  } finally { reserved.fill(0); }
}

async function readVault(path: string): Promise<string> {
  const invalid = () => new RecoveryCommandError('RECOVERY_VAULT_INVALID', 'Provide a regular V2 vault file within the size limit.');
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.size < 1n || before.size > BigInt(maxVaultBytes)) throw invalid();
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const file = await open(path, flags);
  try {
    const opened = await file.stat({ bigint: true });
    const same = (stat: typeof opened) => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino &&
      stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs;
    if (!same(opened)) throw invalid();
    const buffer = Buffer.alloc(Number(opened.size));
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await file.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) throw invalid();
      read += bytesRead;
    }
    if (!same(await file.stat({ bigint: true })) || !same(await lstat(path, { bigint: true }))) throw invalid();
    return buffer.toString('utf8');
  } finally { await file.close(); }
}

/** Offline command. The operator stops cooperating services and supplies the target's configured keys. */
export async function runRecoveryCommand(args: string[], stdin: Readable, readKeys: () => RecoveryKeys = loadConfig) {
  const [operation, databasePath, rawBudget, vaultPath] = args;
  const maxDatabaseBytes = Number(rawBudget);
  if (!((operation === 'restore' && args.length === 4 && isAbsolute(vaultPath)) ||
        (operation === 'rollback' && args.length === 3)) ||
      !isAbsolute(databasePath) || resolve(databasePath) !== databasePath ||
      !/^[1-9]\d*$/.test(rawBudget) || !Number.isSafeInteger(maxDatabaseBytes)) {
    throw new RecoveryCommandError('RECOVERY_USAGE', usage);
  }
  if (operation === 'rollback') return rollbackInterruptedActivation({ databasePath, maxDatabaseBytes });

  const password = await readPassword(stdin);
  const vaultData = await readVault(vaultPath);
  const { masterKey: configuredKey, blindIndexPepper } = readKeys();
  const masterKey = deriveKey(configuredKey);
  try {
    const result = await prepareAndActivateDatabase({ databasePath, maxDatabaseBytes }, async activePath => {
      const stage = await stageFullBackupV2ToDisk({
        vaultData, password, masterKey, blindIndexPepper, stagingDirectory: dirname(activePath),
      });
      return {
        path: stage.path,
        discard: async () => {
          await unlink(stage.path);
          await rmdir(stage.directory);
        },
      };
    });
    return { status: 'restored' as const, rollback: result.rollback.path, markerRemovalSync: result.markerRemovalSync };
  } finally { masterKey.fill(0); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runRecoveryCommand(process.argv.slice(2), process.stdin).then(result => {
    console.log(JSON.stringify(result));
  }).catch((error: unknown) => {
    const value = (error as { code?: unknown } | undefined)?.code;
    const code = typeof value === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value) ? value : 'RECOVERY_FAILED';
    console.error(code === 'RECOVERY_USAGE' ? usage : `Recovery command stopped (${code}).`);
    process.exitCode = 1;
  });
}
