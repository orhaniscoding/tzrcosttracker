import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlindIndex, decryptField, deriveKey } from '@cost-core/crypto';
import {
  AccountRepository,
  AuditLogRepository,
  TransactionRepository,
  projectMemberships,
  users,
} from '@cost-core/database';
import { buildApp } from '../src/app.js';
import { buildFullBackupV2 } from '../src/services/backup-v2-export.service.js';
import { restoreFullBackupV2 } from '../src/services/backup-v2-restore.service.js';

const password = 'synthetic v2 restore password';
const sourceConfig = {
  host: '127.0.0.1',
  port: 4000,
  jwtSecret: 'synthetic restore jwt signing value',
  masterKey: 'synthetic source master key material',
  blindIndexPepper: 'synthetic source blind index pepper',
  bootstrapToken: undefined,
};
const targetConfig = {
  ...sourceConfig,
  masterKey: 'synthetic target master key material',
  blindIndexPepper: 'synthetic target blind index pepper',
};
const sourceMasterKey = deriveKey(sourceConfig.masterKey);
const targetMasterKey = deriveKey(targetConfig.masterKey);
const targetBlindIndexPepper = Buffer.from(targetConfig.blindIndexPepper);
const idempotencyKey = '2a9a2c7f-f56f-46ed-9ae6-92aa6647c212';
const otoIdempotencyKey = '5a6f7c8d-9012-4b3c-8d7e-6f5a4b3c2d1e';
const restoreAt = new Date('2026-11-20T12:00:00.000Z');
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let targetApp: Awaited<ReturnType<typeof buildApp>> | undefined;
let restoredSqlite: any;
let targetRestoreDirectory: string | undefined;

afterEach(async () => {
  if (targetApp) await targetApp.close();
  targetApp = undefined;
  if (restoredSqlite?.open) restoredSqlite.close();
  restoredSqlite = undefined;
  if (targetRestoreDirectory) rmSync(targetRestoreDirectory, { recursive: true, force: true });
  targetRestoreDirectory = undefined;
  if (app) await app.close();
  app = undefined;
});

describe('V2 restore preserves keyed transaction receipts', () => {
  it('keeps the expense ID, accounting, encrypted receipt, and audit chain after rekeyed restore', async () => {
    app = await buildApp({ config: sourceConfig, dbPath: ':memory:' });
    await app.ready();

    const project = await app.projectRepo.createProject({ name: 'Synthetic restore project' });
    const category = await app.categoryRepo.createCategory({ name: 'Synthetic restore category' });
    const now = '2026-11-20T09:00:00.000Z';
    app.db.insert(users).values({
      id: 'restore-manager',
      username: 'restore-manager',
      email: 'restore-manager@example.test',
      fullName: 'Synthetic restore manager',
      passwordHash: 'synthetic-password-hash',
      role: 'manager',
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }).run();
    const session = app.sessionRepo.createSession('restore-manager');
    app.db.insert(projectMemberships).values({
      userId: 'restore-manager',
      projectId: project.id,
      createdAt: now,
    }).run();
    const wallet = app.accountRepo.createAccount({
      name: 'Synthetic restore wallet',
      type: 'cash',
      currency: 'TRY',
      initialBalance: 1000,
      projectId: project.id,
    }, sourceConfig.masterKey, sourceConfig.blindIndexPepper);

    const token = app.jwt.sign({
      id: 'restore-manager',
      username: 'restore-manager',
      role: 'manager',
      sid: session.id,
      exp: session.expiresAt,
    });
    const payload = {
      projectId: project.id,
      type: 'expense',
      date: '2026-11-20T09:00:00.000Z',
      amount: 125,
      currency: 'TRY',
      categoryId: category.id,
      title: 'Synthetic keyed restore expense',
      accountFromId: wallet.id,
      isPaid: true,
    };
    const submit = () => app!.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: {
        authorization: 'Bearer ' + token,
        'idempotency-key': idempotencyKey,
      },
      payload,
    });

    const first = await submit();
    expect(first.statusCode).toBe(201);
    const transactionId = first.json().transaction.id as string;

    const sourceAccounting = {
      account: new AccountRepository(app.db).getAccountById(wallet.id, sourceConfig.masterKey),
      transaction: new TransactionRepository(app.db).getTransactionById(transactionId, sourceConfig.masterKey),
    };
    const sourceAuditBeforeOto = new AuditLogRepository(app.db).listAuditLogs(100, sourceConfig.masterKey);
    expect(sourceAccounting.account?.balance).toBe(875);
    expect(sourceAccounting.transaction?.id).toBe(transactionId);
    expect(sourceAuditBeforeOto).toHaveLength(1);
    expect(new AuditLogRepository(app.db).verifyChainIntegrity(sourceConfig.masterKey))
      .toEqual({ valid: true, count: sourceAuditBeforeOto.length });

    const retry = await submit();
    expect(retry.statusCode).toBe(201);
    expect(retry.json().transaction.id).toBe(transactionId);
    expect(new AccountRepository(app.db).getAccountById(wallet.id, sourceConfig.masterKey)).toEqual(sourceAccounting.account);
    expect(new AuditLogRepository(app.db).listAuditLogs(100, sourceConfig.masterKey)).toEqual(sourceAuditBeforeOto);

    const sourceDiff = decryptField<{ previousState: unknown; newState: Record<string, unknown> }>(
      app.sqlite.prepare('SELECT diff_encrypted FROM audit_logs WHERE entity_id = ?').pluck().get(transactionId) as string,
      sourceConfig.masterKey,
    );
    expect(sourceDiff.newState._creationReceipt).toMatchObject({ version: 1, projectId: project.id });

    const otoPayload = {
      ...payload,
      paymentSource: 'person_out_of_pocket',
      payerPersonName: 'Synthetic restore payer',
    };
    const submitOto = () => app!.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: {
        authorization: 'Bearer ' + token,
        'idempotency-key': otoIdempotencyKey,
      },
      payload: otoPayload,
    });
    const otoFirst = await submitOto();
    expect(otoFirst.statusCode).toBe(201);
    const otoResponse = otoFirst.json();
    expect(otoResponse.transaction.otoKasaTransactionId).toBe(otoResponse.otoKasaTransaction.id);
    expect(otoResponse.transaction.paymentSource).toBe('person_out_of_pocket');
    expect(new AccountRepository(app.db).getAccountById(wallet.id, sourceConfig.masterKey)?.balance).toBe(875);
    const sourceAudit = new AuditLogRepository(app.db).listAuditLogs(100, sourceConfig.masterKey);
    expect(sourceAudit).toHaveLength(2);
    expect(new AuditLogRepository(app.db).verifyChainIntegrity(sourceConfig.masterKey))
      .toEqual({ valid: true, count: sourceAudit.length });
    const otoSourceDiff = decryptField<{ previousState: unknown; newState: Record<string, unknown> }>(
      app.sqlite.prepare('SELECT diff_encrypted FROM audit_logs WHERE entity_id = ?').pluck().get(otoResponse.transaction.id) as string,
      sourceConfig.masterKey,
    );
    expect(otoSourceDiff.newState._creationReceipt).toMatchObject({ version: 1, projectId: project.id });

    const { vault } = await buildFullBackupV2({
      sqlite: app.sqlite,
      password,
      masterKey: Buffer.from(sourceMasterKey),
      blindIndexPepper: sourceConfig.blindIndexPepper,
      now: '2026-11-20T10:00:00.000Z',
    });
    const restored = await restoreFullBackupV2({
      vaultData: vault,
      password,
      masterKey: targetMasterKey,
      blindIndexPepper: targetBlindIndexPepper,
      now: restoreAt,
    });
    restoredSqlite = restored.database.sqlite;
    targetRestoreDirectory = mkdtempSync(join(tmpdir(), 'cost-tracker-r38-'));
    const targetDbPath = join(targetRestoreDirectory, 'restored.sqlite');
    await restoredSqlite.backup(targetDbPath);
    targetApp = await buildApp({ config: targetConfig, dbPath: targetDbPath });
    await targetApp.ready();
    const targetSession = targetApp.sessionRepo.createSession('restore-manager');
    const targetToken = targetApp.jwt.sign({
      id: 'restore-manager',
      username: 'restore-manager',
      role: 'manager',
      sid: targetSession.id,
      exp: targetSession.expiresAt,
    });

    const targetAccounting = {
      account: new AccountRepository(restored.database.db).getAccountById(wallet.id, targetMasterKey),
      transaction: new TransactionRepository(restored.database.db).getTransactionById(transactionId, targetMasterKey),
    };
    expect(targetAccounting).toEqual(sourceAccounting);
    const targetTitleIndex = restoredSqlite.prepare('SELECT title_blind_index FROM transactions WHERE id = ?').pluck().get(transactionId) as string;
    expect(targetTitleIndex).toBe(createBlindIndex(payload.title, targetBlindIndexPepper));
    expect(targetTitleIndex).not.toBe(app.sqlite.prepare('SELECT title_blind_index FROM transactions WHERE id = ?').pluck().get(transactionId));
    expect(restoredSqlite.prepare('SELECT id FROM transactions WHERE id = ?').pluck().get(transactionId))
      .toBe(transactionId);

    const targetAuditRepo = new AuditLogRepository(restored.database.db);
    expect(targetAuditRepo.listAuditLogs(100, targetMasterKey)).toEqual(sourceAudit);
    expect(targetAuditRepo.verifyChainIntegrity(targetMasterKey))
      .toEqual({ valid: true, count: sourceAudit.length });

    const targetDiff = decryptField<{ previousState: unknown; newState: Record<string, unknown> }>(
      restoredSqlite.prepare('SELECT diff_encrypted FROM audit_logs WHERE entity_id = ?').pluck().get(transactionId) as string,
      targetMasterKey,
    );
    expect(targetDiff.newState._creationReceipt).toEqual(sourceDiff.newState._creationReceipt);
    expect(restoredSqlite.prepare('SELECT diff_encrypted FROM audit_logs WHERE entity_id = ?').pluck().get(transactionId))
      .not.toBe(app.sqlite.prepare('SELECT diff_encrypted FROM audit_logs WHERE entity_id = ?').pluck().get(transactionId));

    const targetBeforeReplay = {
      account: new AccountRepository(targetApp.db).getAccountById(wallet.id, targetConfig.masterKey),
      transactionCount: Number(targetApp.sqlite.prepare('SELECT count(*) FROM transactions').pluck().get()),
      auditCount: Number(targetApp.sqlite.prepare('SELECT count(*) FROM audit_logs').pluck().get()),
    };
    expect(targetBeforeReplay.account).toEqual(targetAccounting.account);
    expect(targetBeforeReplay.transactionCount).toBe(3);
    expect(targetBeforeReplay.auditCount).toBe(sourceAudit.length);
    const targetSubmit = (requestPayload: object, key: string) => targetApp!.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: {
        authorization: 'Bearer ' + targetToken,
        'idempotency-key': key,
      },
      payload: requestPayload,
    });

    const ordinaryReplay = await targetSubmit(payload, idempotencyKey);
    expect(ordinaryReplay.statusCode).toBe(201);
    expect(ordinaryReplay.json().transaction).toEqual(first.json().transaction);
    expect(new AccountRepository(targetApp.db).getAccountById(wallet.id, targetConfig.masterKey)).toEqual(targetBeforeReplay.account);
    expect(Number(targetApp.sqlite.prepare('SELECT count(*) FROM transactions').pluck().get())).toBe(targetBeforeReplay.transactionCount);
    expect(Number(targetApp.sqlite.prepare('SELECT count(*) FROM audit_logs').pluck().get())).toBe(targetBeforeReplay.auditCount);

    const otoReplay = await targetSubmit(otoPayload, otoIdempotencyKey);
    expect(otoReplay.statusCode).toBe(201);
    expect(otoReplay.json()).toEqual(otoResponse);
    expect(new AccountRepository(targetApp.db).getAccountById(wallet.id, targetConfig.masterKey)).toEqual(targetBeforeReplay.account);
    expect(Number(targetApp.sqlite.prepare('SELECT count(*) FROM transactions').pluck().get())).toBe(targetBeforeReplay.transactionCount);
    expect(Number(targetApp.sqlite.prepare('SELECT count(*) FROM audit_logs').pluck().get())).toBe(targetBeforeReplay.auditCount);

    const targetReplayDiff = decryptField<{ previousState: unknown; newState: Record<string, unknown> }>(
      targetApp.sqlite.prepare('SELECT diff_encrypted FROM audit_logs WHERE entity_id = ?').pluck().get(transactionId) as string,
      targetMasterKey,
    );
    expect(targetReplayDiff.newState._creationReceipt).toEqual(sourceDiff.newState._creationReceipt);
    const targetOtoReplayDiff = decryptField<{ previousState: unknown; newState: Record<string, unknown> }>(
      targetApp.sqlite.prepare('SELECT diff_encrypted FROM audit_logs WHERE entity_id = ?').pluck().get(otoResponse.transaction.id) as string,
      targetMasterKey,
    );
    expect(targetOtoReplayDiff.newState._creationReceipt).toEqual(otoSourceDiff.newState._creationReceipt);
    expect(new AuditLogRepository(targetApp.db).verifyChainIntegrity(targetMasterKey))
      .toEqual({ valid: true, count: sourceAudit.length });
  });
});
