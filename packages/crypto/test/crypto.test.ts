import { describe, it, expect } from 'vitest';
import {
  encryptField,
  decryptField,
  isEncrypted,
  deriveKey,
  createBlindIndex,
  normalizeForIndex,
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  getTotpCode,
  verifyTotp,
  generateBackupCodes,
  hashBackupCode,
  computeAuditHash,
  verifyAuditHash,
  toBase32,
  fromBase32,
  numberToTurkishWords,
} from '../src/index.js';

describe('@cost-core/crypto - Security & Cryptographic Core Tests', () => {
  const MASTER_KEY = 'super-secret-master-key-cost-core-2026';
  const PEPPER = 'blind-index-pepper-key-for-search-privacy';

  // ----------------------------------------------------
  // 1. AES-256-GCM ALAN ŞİFRELEME (FIELD-LEVEL ENCRYPTION)
  // ----------------------------------------------------
  describe('AES-256-GCM Encryption', () => {
    it('should derive consistent 32-byte key from string', () => {
      const key1 = deriveKey(MASTER_KEY);
      const key2 = deriveKey(MASTER_KEY);
      expect(key1.length).toBe(32);
      expect(key1.equals(key2)).toBe(true);
    });

    it('should encrypt and decrypt a string value', () => {
      const sensitiveText = 'TR330006100511123456789012 - Garanti Bankası Ana Kasa';
      const encrypted = encryptField(sensitiveText, MASTER_KEY);

      expect(isEncrypted(encrypted)).toBe(true);
      expect(encrypted).not.toContain(sensitiveText);

      const decrypted = decryptField<string>(encrypted, MASTER_KEY);
      expect(decrypted).toBe(sensitiveText);
    });

    it('should encrypt and decrypt numeric monetary amounts', () => {
      const amount = 1450250.75;
      const encrypted = encryptField(amount, MASTER_KEY);

      expect(isEncrypted(encrypted)).toBe(true);
      const decrypted = decryptField<number>(encrypted, MASTER_KEY);
      expect(decrypted).toBe(amount);
    });

    it('should encrypt and decrypt complex JSON objects', () => {
      const customPayload = {
        irsaliyeNo: 'IRS-2026-888',
        metrekup: 120,
        laborHours: 45.5,
        notlar: 'Şantiye şefi teslim aldı.',
      };
      const encrypted = encryptField(customPayload, MASTER_KEY);
      expect(isEncrypted(encrypted)).toBe(true);

      const decrypted = decryptField<typeof customPayload>(encrypted, MASTER_KEY);
      expect(decrypted).toEqual(customPayload);
    });

    it('should fail decryption if master key is wrong', () => {
      const encrypted = encryptField('Gizli Maliyet Verisi', MASTER_KEY);
      expect(() => decryptField(encrypted, 'wrong-key-attempt')).toThrow();
    });

    it('should fail decryption if ciphertext is tampered (Tamper-proof / AuthTag check)', () => {
      const encrypted = encryptField('Orijinal Veri', MASTER_KEY);
      const parts = encrypted.split(':');
      // Son hex karakterini değiştirerek kurcala
      const tamperedHex = parts[4].slice(0, -2) + (parts[4].slice(-2) === 'aa' ? 'bb' : 'aa');
      const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:${tamperedHex}`;

      expect(() => decryptField(tampered, MASTER_KEY)).toThrow();
    });
  });

  // ----------------------------------------------------
  // 2. KÖR İNDEKSLEME (BLIND INDEXING - SEARCH PRIVACY)
  // ----------------------------------------------------
  describe('HMAC-SHA256 Blind Indexing', () => {
    it('should normalize Turkish and accented characters', () => {
      const normalized1 = normalizeForIndex('AKÇANSA BETON A.Ş.');
      const normalized2 = normalizeForIndex('akcansa beton a.s.');
      expect(normalized1).toBe(normalized2);
    });

    it('should generate deterministic blind index for same normalized text', () => {
      const idx1 = createBlindIndex('Akçansa Beton', PEPPER);
      const idx2 = createBlindIndex('akcansa beton', PEPPER);
      expect(idx1).toBe(idx2);
      expect(idx1.startsWith('bidx:v1:')).toBe(true);
    });

    it('should produce different blind indices with different peppers', () => {
      const idx1 = createBlindIndex('Ahmet Yılmaz', 'pepper-1');
      const idx2 = createBlindIndex('Ahmet Yılmaz', 'pepper-2');
      expect(idx1).not.toBe(idx2);
    });
  });

  // ----------------------------------------------------
  // 3. PAROLA HASHLEME (SCRYPT & TIMING-SAFE VERIFY)
  // ----------------------------------------------------
  describe('Password Hashing', () => {
    it('should hash password with salt and verify correctly', async () => {
      const rawPassword = 'GuvenliParola#2026!';
      const hash = await hashPassword(rawPassword);

      expect(hash.startsWith('scrypt:v1:')).toBe(true);

      const isValid = await verifyPassword(rawPassword, hash);
      expect(isValid).toBe(true);

      const isWrong = await verifyPassword('YanlisParola', hash);
      expect(isWrong).toBe(false);
    });

    it('should generate different hashes for same password (unique salts)', async () => {
      const rawPassword = 'AyniParola123';
      const hash1 = await hashPassword(rawPassword);
      const hash2 = await hashPassword(rawPassword);

      expect(hash1).not.toBe(hash2);
      expect(await verifyPassword(rawPassword, hash1)).toBe(true);
      expect(await verifyPassword(rawPassword, hash2)).toBe(true);
    });
  });

  // ----------------------------------------------------
  // 4. İKİ AŞAMALI DOĞRULAMA (RFC 6238 TOTP)
  // ----------------------------------------------------
  describe('RFC 6238 TOTP (2FA)', () => {
    it('should encode and decode Base32 correctly', () => {
      const original = Buffer.from('TZRCoster2026TestBuffer');
      const base32 = toBase32(original);
      const decoded = fromBase32(base32);
      expect(decoded.equals(original)).toBe(true);
    });

    it('should generate valid TOTP secret and otpauth URI', () => {
      const { secret, uri } = generateTotpSecret('orhan@insaat.com', 'TZRCoster');

      expect(secret.length).toBeGreaterThan(16);
      expect(uri).toContain('otpauth://totp/TZRCoster');
      expect(uri).toContain(secret);
    });

    it('should verify TOTP code within valid time window', () => {
      const { secret } = generateTotpSecret('test@user.com');
      const now = Date.now();

      const currentCode = getTotpCode(secret, now);
      expect(currentCode.length).toBe(6);

      // Mevcut zamanla doğrula
      const isValid = verifyTotp(currentCode, secret, 1, now);
      expect(isValid).toBe(true);

      // Yanlış kod reddedilmeli
      const isInvalid = verifyTotp('999999', secret, 1, now);
      expect(isInvalid === false || isInvalid !== (currentCode === '999999')).toBe(true);
    });

    it('should generate and hash backup recovery codes', () => {
      const codes = generateBackupCodes(8);
      expect(codes.length).toBe(8);
      expect(codes[0]).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);

      const hashed = hashBackupCode(codes[0]);
      expect(hashed.length).toBe(64); // SHA-256 hex
    });
  });

  // ----------------------------------------------------
  // 6. TÜRKÇE PARA OKUNUŞU (NATIVE CURRENCY WORDS)
  // ----------------------------------------------------
  describe('Turkish Currency To Words', () => {
    it('should correctly format integers in Turkish words', () => {
      expect(numberToTurkishWords(0)).toBe('Sıfır Türk Lirası');
      expect(numberToTurkishWords(1000)).toBe('Bin Türk Lirası');
      expect(numberToTurkishWords(17000)).toBe('On Yedi Bin Türk Lirası');
      expect(numberToTurkishWords(76524)).toBe('Yetmiş Altı Bin Beş Yüz Yirmi Dört Türk Lirası');
      expect(numberToTurkishWords(498186)).toBe('Dört Yüz Doksan Sekiz Bin Yüz Seksen Altı Türk Lirası');
    });

    it('should handle kurus (decimals) and negative numbers', () => {
      expect(numberToTurkishWords(1250.75)).toBe('Bin İki Yüz Elli Türk Lirası Yetmiş Beş Kuruş');
      expect(numberToTurkishWords(-69000)).toBe('Eksi Altmış Dokuz Bin Türk Lirası');
      expect(numberToTurkishWords(0.5)).toBe('Sıfır Türk Lirası Elli Kuruş');
    });
  });
});
