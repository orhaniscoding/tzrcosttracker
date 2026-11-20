import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SALT_LENGTH = 16;
const KEY_LENGTH = 64;
const PREFIX = 'scrypt:v1';

/**
 * Parolayı güçlü scrypt algoritması ve benzersiz tuz ile hashler.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = (await scryptAsync(password, salt, KEY_LENGTH)) as Buffer;

  return `${PREFIX}:${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

/**
 * Parolanın kaydedilen hash ile eşleştiğini sabit süreli (timing-safe) karşılaştırma ile doğrular.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith(`${PREFIX}:`)) {
    return false;
  }

  const parts = storedHash.split(':');
  if (parts.length !== 4) {
    return false;
  }

  const [, , saltHex, keyHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expectedKey = Buffer.from(keyHex, 'hex');

  const derivedKey = (await scryptAsync(password, salt, expectedKey.length)) as Buffer;

  return timingSafeEqual(derivedKey, expectedKey);
}
