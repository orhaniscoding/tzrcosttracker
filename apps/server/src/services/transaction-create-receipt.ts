import { createHash, randomBytes } from 'node:crypto';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{32}$/;

export interface TransactionCreateReceipt {
  version: 1;
  scope: string;
  nonce: string;
  fingerprint: string;
  projectId: string | null;
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('invalid request');
  return encoded;
}

export function transactionCreateKey(value: unknown, actorId: string, body: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new Error('INVALID_IDEMPOTENCY_KEY');
  const scope = sha256(JSON.stringify(['transaction.create.v1', actorId, value.toLowerCase()]));
  const auditId = `${scope.slice(0, 8)}-${scope.slice(8, 12)}-8${scope.slice(13, 16)}-8${scope.slice(17, 20)}-${scope.slice(20, 32)}`;
  const bodyHash = canonical(body);
  return {
    auditId: auditId as `${string}-${string}-${string}-${string}-${string}`,
    scope,
    fingerprint: (nonce: string) => sha256(nonce + bodyHash),
    receipt(projectId: string | null): TransactionCreateReceipt {
      const nonce = randomBytes(16).toString('hex');
      return { version: 1, scope, nonce, fingerprint: sha256(nonce + bodyHash), projectId };
    },
  };
}

export function parseTransactionCreateReceipt(value: unknown): TransactionCreateReceipt {
  const receipt = value as Partial<TransactionCreateReceipt> | null;
  if (!receipt || receipt.version !== 1 || typeof receipt.scope !== 'string' || !SHA256.test(receipt.scope) ||
      typeof receipt.nonce !== 'string' || !HEX128.test(receipt.nonce) ||
      typeof receipt.fingerprint !== 'string' || !SHA256.test(receipt.fingerprint) ||
      !(receipt.projectId === null || typeof receipt.projectId === 'string')) throw new Error('INVALID_RECEIPT');
  return receipt as TransactionCreateReceipt;
}
