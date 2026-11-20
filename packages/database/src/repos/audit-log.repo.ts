import { desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CostCoreDatabase } from '../client.js';
import { auditLogs } from '../schema.js';
import { computeAuditHash, verifyAuditHash, encryptField, decryptField } from '@cost-core/crypto';
import type { AuditLog, AuditAction } from '@cost-core/types';

export interface LogActionInput {
  userId?: string | null;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  previousState?: any;
  newState?: any;
}

export class AuditLogRepository {
  constructor(private db: CostCoreDatabase) {}

  /**
   * Yeni bir denetim günlüğü kaydeder.
   * Önceki kaydın hash'ini alarak SHA-256 zinciri oluşturur ve diff'i AES-256 ile şifreler.
   */
  logAction(input: LogActionInput, masterKey: string | Buffer, id = randomUUID()): AuditLog { return this.db.transaction(() => {
    const timestamp = new Date().toISOString();

    // En son denetim günlüğü kaydının hash'ini bul
    const latest = this.db.select().from(auditLogs).orderBy(desc(sql`rowid`)).limit(1).get();
    const previousHash = latest ? latest.hash : 'GENESIS';

    const hash = computeAuditHash({
      previousHash,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      userId: input.userId,
      timestamp,
      previousState: input.previousState,
      newState: input.newState,
    });

    const diffPayload = {
      previousState: input.previousState || null,
      newState: input.newState || null,
    };
    const diffEncrypted = encryptField(diffPayload, masterKey);

    const row = {
      id,
      userId: input.userId || null,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId || null,
      timestamp,
      ipAddress: input.ipAddress || null,
      userAgent: input.userAgent || null,
      diffEncrypted,
      hash,
      previousHash,
    };

    this.db.insert(auditLogs).values(row).run();

    return {
      id,
      userId: row.userId,
      action: row.action as any,
      entity: row.entity,
      entityId: row.entityId,
      timestamp: row.timestamp,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      previousState: input.previousState,
      newState: input.newState,
      hash,
      previousHash,
    }; }, { behavior: 'immediate' });
  }

  /**
   * Tüm denetim günlüğünü baştan sona tarar ve zincir hash bütünlüğünü doğrular.
   * Herhangi bir satır kurcalanmışsa `valid: false` ve bozulan satır ID'sini döner.
   */
  verifyChainIntegrity(masterKey: string | Buffer): { valid: boolean; corruptedAtId?: string; count: number } {
    const logs = this.db.select().from(auditLogs).orderBy(sql`rowid`).all();

    let expectedPrevHash = 'GENESIS';

    for (const log of logs) {
      if (log.previousHash !== expectedPrevHash) {
        return { valid: false, corruptedAtId: log.id, count: logs.length };
      }

      let diff: { previousState: any; newState: any } = { previousState: null, newState: null };
      if (log.diffEncrypted) {
        try {
          diff = decryptField<{ previousState: any; newState: any }>(log.diffEncrypted, masterKey);
        } catch {
          return { valid: false, corruptedAtId: log.id, count: logs.length };
        }
      }

      const isValid = verifyAuditHash(
        {
          previousHash: log.previousHash,
          action: log.action,
          entity: log.entity,
          entityId: log.entityId,
          userId: log.userId,
          timestamp: log.timestamp,
          previousState: diff.previousState,
          newState: diff.newState,
        },
        log.hash
      );

      if (!isValid) {
        return { valid: false, corruptedAtId: log.id, count: logs.length };
      }

      expectedPrevHash = log.hash;
    }

    return { valid: true, count: logs.length };
  }

  /**
   * En son denetim kayıtlarını çözerek listeler.
   */
  listAuditLogs(limit = 100, masterKey: string | Buffer): AuditLog[] {
    const rows = this.db.select().from(auditLogs).orderBy(desc(sql`rowid`)).limit(limit).all();

    return rows.map((r) => {
      let diff: { previousState: any; newState: any } = { previousState: null, newState: null };
      if (r.diffEncrypted) {
        try {
          diff = decryptField<{ previousState: any; newState: any }>(r.diffEncrypted, masterKey);
        } catch {
          // Decryption fallback
        }
      }

      if (r.entity === "transaction" && r.action === "CREATE" && diff.newState && typeof diff.newState === "object") {
        const { _creationReceipt: _ignored, ...publicState } = diff.newState;
        diff.newState = publicState;
      }

      return {
        id: r.id,
        userId: r.userId,
        action: r.action as any,
        entity: r.entity,
        entityId: r.entityId,
        timestamp: r.timestamp,
        ipAddress: r.ipAddress,
        userAgent: r.userAgent,
        previousState: diff.previousState,
        newState: diff.newState,
        hash: r.hash,
        previousHash: r.previousHash,
      };
    });
  }
}
