import { createHmac } from 'node:crypto';

const PREFIX = 'bidx:v1';

/**
 * Arama ve filtreleme için metni normalize eder (küçük harf, boşluk temizleme).
 */
export function normalizeForIndex(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, ''); // Türkçe ve aksanlı karakterleri yumuşatarak arama uyumu sağlar
}

/**
 * Şifreli veriler üzerinde doğrudan veritabanı araması yapabilmek için
 * deterministik ve tuzlu (peppered) HMAC-SHA256 kör indeksi üretir.
 */
export function createBlindIndex(value: string | number | null | undefined, pepperKey: string | Buffer): string {
  const normalized = normalizeForIndex(value);
  if (!normalized) return '';

  const hmac = createHmac('sha256', pepperKey);
  hmac.update(normalized);
  const hash = hmac.digest('hex');

  return `${PREFIX}:${hash}`;
}
