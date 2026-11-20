import { createHmac, randomBytes, createHash } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Buffer'ı Base32 string'e dönüştürür.
 */
export function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Base32 string'i Buffer'a dönüştürür.
 */
export function fromBase32(base32: string): Buffer {
  const cleaned = base32.toUpperCase().replace(/=+$/, '').replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) {
      throw new Error(`Geçersiz Base32 karakteri: ${cleaned[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Belirli bir zaman sayacı için 6 haneli HOTP/TOTP kodunu hesaplar.
 */
export function generateHotp(secret: string, counter: number): string {
  const key = fromBase32(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter), 0);

  const hmac = createHmac('sha1', key);
  hmac.update(counterBuffer);
  const digest = hmac.digest();

  // Dynamic truncation (RFC 4226)
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
}

/**
 * Mevcut an için geçerli TOTP kodunu üretir.
 */
export function getTotpCode(secret: string, timestampMs = Date.now(), stepSeconds = 30): string {
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  return generateHotp(secret, counter);
}

/**
 * Yeni bir 2FA gizli anahtarı ve Authenticator bağlantısı üretir.
 */
export function generateTotpSecret(accountName: string, issuer = 'TZRCoster'): { secret: string; uri: string } {
  const rawBytes = randomBytes(20); // 160 bits (RFC standardı)
  const secret = toBase32(rawBytes);

  const encodedIssuer = encodeURIComponent(issuer);
  const encodedAccount = encodeURIComponent(accountName);
  const uri = `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;

  return { secret, uri };
}

/**
 * Kullanıcının girdiği 6 haneli 2FA kodunu doğrular (±1 zaman penceresi toleransı ile).
 */
export function verifyTotp(token: string, secret: string, window = 1, timestampMs = Date.now(), stepSeconds = 30): boolean {
  if (!token || token.length !== 6 || !/^\d{6}$/.test(token)) {
    return false;
  }

  const currentCounter = Math.floor(timestampMs / 1000 / stepSeconds);

  for (let error = -window; error <= window; error++) {
    const calculatedOtp = generateHotp(secret, currentCounter + error);
    if (calculatedOtp === token) {
      return true;
    }
  }

  return false;
}

/**
 * 2FA acil durum yedek kodları üretir (Örn: "A1B2-C3D4").
 */
export function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const part1 = randomBytes(2).toString('hex').toUpperCase();
    const part2 = randomBytes(2).toString('hex').toUpperCase();
    codes.push(`${part1}-${part2}`);
  }
  return codes;
}

/**
 * Yedek kodu veritabanında güvenli saklamak için hashler.
 */
export function hashBackupCode(code: string): string {
  const cleaned = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return createHash('sha256').update(cleaned).digest('hex');
}
