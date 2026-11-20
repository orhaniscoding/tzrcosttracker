import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits standard for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits standard for GCM
const PREFIX = 'enc:v1';

/**
 * Verilen anahtarı SHA-256 ile tam 32 bayt (256-bit) buffer'a çevirir.
 */
export function deriveKey(masterKey: string | Buffer): Buffer {
  if (Buffer.isBuffer(masterKey) && masterKey.length === 32) {
    return masterKey;
  }
  return createHash('sha256').update(masterKey).digest();
}

/**
 * Hassas veriyi AES-256-GCM ile şifreler.
 * Format: enc:v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>
 */
export function encryptField(value: string | number | object | null | undefined, masterKey: string | Buffer): string {
  if (value === null || value === undefined) {
    return '';
  }

  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const plaintext = typeof value === 'object' ? JSON.stringify(value) : String(value);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');
  const ivHex = iv.toString('hex');

  return `${PREFIX}:${ivHex}:${authTag}:${encrypted}`;
}

/**
 * AES-256-GCM formatındaki şifreli metni çözer.
 * Kurcalama veya yanlış anahtar durumunda Error fırlatır (Tamper-proof).
 */
export function decryptField<T = string>(cipherText: string, masterKey: string | Buffer): T {
  if (!cipherText || !isEncrypted(cipherText)) {
    return cipherText as unknown as T;
  }

  const parts = cipherText.split(':');
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Geçersiz şifreli metin formatı');
  }

  const [, , ivHex, authTagHex, encryptedHex] = parts;
  const key = deriveKey(masterKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  // JSON denemesi
  try {
    return JSON.parse(decrypted) as T;
  } catch {
    return decrypted as unknown as T;
  }
}

/**
 * Metnin şifreli formatta olup olmadığını kontrol eder.
 */
export function isEncrypted(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.startsWith(`${PREFIX}:`);
}
