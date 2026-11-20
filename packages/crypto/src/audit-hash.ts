import { createHash } from 'node:crypto';

export interface AuditHashPayload {
  previousHash?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  userId?: string | null;
  timestamp: string;
  previousState?: any;
  newState?: any;
}

/**
 * Denetim kaydı için kriptografik SHA-256 zincir hash'i üretir.
 * Önceki kaydın hash'ini dahil ederek değiştirilemez (tamper-evident) bir denetim zinciri oluşturur.
 */
export function computeAuditHash(payload: AuditHashPayload): string {
  const hash = createHash('sha256');

  const normalized = {
    previousHash: payload.previousHash || 'GENESIS',
    action: payload.action,
    entity: payload.entity,
    entityId: payload.entityId || '',
    userId: payload.userId || '',
    timestamp: payload.timestamp,
    previousState: payload.previousState || null,
    newState: payload.newState || null,
  };

  hash.update(JSON.stringify(normalized));
  return hash.digest('hex');
}

/**
 * Denetim kaydının hash bütünlüğünü doğrular.
 */
export function verifyAuditHash(payload: AuditHashPayload, expectedHash: string): boolean {
  const computed = computeAuditHash(payload);
  return computed === expectedHash;
}
