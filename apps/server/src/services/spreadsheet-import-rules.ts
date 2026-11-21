import * as XLSX from 'xlsx';

export class SpreadsheetImportValueError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SpreadsheetImportValueError';
  }
}

function invalid(code: string, message: string): never {
  throw new SpreadsheetImportValueError(code, message);
}

function finitePositive(value: number, code = 'AMOUNT_INVALID'): number {
  const cents = Math.round(value * 100);
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(cents)) invalid(code, 'Tutar pozitif ve geçerli olmalıdır.');
  if (cents <= 0) invalid('AMOUNT_PRECISION', 'Tutar en fazla iki ondalık basamak içerebilir ve sıfıra yuvarlanamaz.');
  if (Math.abs(value * 100 - cents) > 1e-7) invalid('AMOUNT_PRECISION', 'Tutar en fazla iki ondalık basamak içerebilir.');
  return cents / 100;
}

export function parseImportAmount(value: unknown): number {
  if (typeof value === 'number') return finitePositive(value);
  if (typeof value !== 'string') invalid('AMOUNT_INVALID', 'Tutar geçersiz.');
  let text = value.replace(/\u00a0/g, ' ').trim();
  if (!text) invalid('AMOUNT_INVALID', 'Tutar boş olamaz.');
  if (/\d\s*(?:[₺$€£]|TRY|TL|USD|EUR|GBP)\s*\d/i.test(text)) invalid('AMOUNT_INVALID', 'Para birimi işareti rakamların arasında olamaz.');
  text = text.replace(/[₺$€£]/g, '').replace(/\b(?:TRY|TL|USD|EUR|GBP)\b/gi, '').trim();
  if (!text || !/^[+\-\d\s'.,]+$/.test(text)) invalid('AMOUNT_INVALID', 'Tutar geçersiz.');
  if (text.includes('-')) invalid('AMOUNT_INVALID', 'Tutar negatif olamaz.');
  if (text.startsWith('+')) text = text.slice(1);
  if (text.includes('+')) invalid('AMOUNT_INVALID', 'Tutar geçersiz.');
  if (text.includes("'")) invalid('AMOUNT_INVALID', 'Tutar biçimi geçersiz.');
  if (/\s/.test(text)) {
    if (!/^\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?$/.test(text)) invalid('AMOUNT_INVALID', 'Tutar içindeki boşluklar geçersiz.');
    text = text.replace(/ /g, '');
  }
  const comma = text.lastIndexOf(','), dot = text.lastIndexOf('.');
  let normalized: string;
  if (comma >= 0 && dot >= 0) {
    const decimalAt = Math.max(comma, dot);
    const decimal = text.slice(decimalAt + 1);
    if (!/^\d+$/.test(decimal)) invalid('AMOUNT_INVALID', 'Tutar ondalığı geçersiz.');
    const integer = text.slice(0, decimalAt), grouping = comma > dot ? '.' : ',';
    const integerPattern = grouping === '.' ? /^\d{1,3}(?:\.\d{3})*$/ : /^\d{1,3}(?:,\d{3})*$/;
    if (!integerPattern.test(integer) || decimal.length > 2) invalid('AMOUNT_INVALID', 'Tutar biçimi geçersiz.');
    normalized = integer.replace(/[.,]/g, '') + '.' + decimal;
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? ',' : '.';
    const parts = text.split(separator);
    if (parts.some(part => !/^\d+$/.test(part)) || parts.length === 0) invalid('AMOUNT_INVALID', 'Tutar geçersiz.');
    if (parts.length > 2) {
      if (parts[0].length >= 1 && parts[0].length <= 3 && parts.slice(1).every(part => part.length === 3)) normalized = parts.join('');
      else invalid('AMOUNT_AMBIGUOUS', 'Tutar ayraçları belirsiz.');
    } else if (parts[1].length > 2 && parts[0] === '0') {
      invalid('AMOUNT_PRECISION', 'Tutar en fazla iki ondalık basamak içerebilir.');
    } else if (parts[1].length === 3 && parts[0] !== '0') {
      invalid('AMOUNT_AMBIGUOUS', 'Tutar ayraçları belirsiz; ondalık veya binlik biçimi açıkça belirtilmelidir.');
    } else {
      if (parts[1].length > 2) invalid('AMOUNT_PRECISION', 'Tutar en fazla iki ondalık basamak içerebilir.');
      normalized = parts[0] + '.' + parts[1];
    }
  } else {
    normalized = text;
  }
  return finitePositive(Number(normalized));
}

export function parseImportExchangeRate(value: unknown, currency: string, projectCurrency: string): number {
  const missing = value === undefined || value === null || (typeof value === 'string' && !value.trim());
  if (missing) {
    if (currency === projectCurrency) return 1;
    invalid('EXCHANGE_RATE_REQUIRED', 'Farklı para birimi için döviz kuru gereklidir.');
  }
  const text = typeof value === 'string' ? value.trim() : value;
  if (typeof text !== 'number' && (typeof text !== 'string' || !/^\d+(?:[.,]\d+)?$/.test(text))) invalid('EXCHANGE_RATE_INVALID', 'Döviz kuru pozitif ve geçerli olmalıdır.');
  const rate = typeof text === 'number' ? text : Number(text.replace(',', '.'));
  if (!Number.isFinite(rate) || rate <= 0 || (currency === projectCurrency && rate !== 1)) invalid('EXCHANGE_RATE_INVALID', 'Döviz kuru pozitif ve geçerli olmalıdır; proje para birimi için kur 1 olmalıdır.');
  return rate;
}

function utcDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) invalid('DATE_INVALID', 'Tarih geçersiz.');
  return d.toISOString();
}

export function parseImportDate(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) invalid('DATE_INVALID', 'Tarih geçersiz.');
    return value.toISOString();
  }
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) invalid('DATE_INVALID', 'Tarih geçersiz.');
    const d = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, Math.floor(parsed.S || 0)));
    if (Number.isNaN(d.getTime()) || d.getUTCFullYear() !== parsed.y || d.getUTCMonth() !== parsed.m - 1 || d.getUTCDate() !== parsed.d) invalid('DATE_INVALID', 'Tarih geçersiz.');
    return d.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) invalid('DATE_INVALID', 'Tarih geçersiz.');
  const text = value.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(text);
  if (match) {
    const iso = utcDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (text.length > 10) {
      const parsed = new Date(text);
      if (Number.isNaN(parsed.getTime())) invalid('DATE_INVALID', 'Tarih geçersiz.');
      return parsed.toISOString();
    }
    return iso;
  }
  match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (match) return utcDate(Number(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (match) {
    const first = Number(match[1]), second = Number(match[2]), year = Number(match[3]);
    if (first <= 12 && second <= 12) invalid('DATE_INVALID', 'Tarih biçimi belirsiz. ISO veya noktalı tarih kullanın.');
    return first > 12 ? utcDate(year, second, first) : utcDate(year, first, second);
  }
  invalid('DATE_INVALID', 'Tarih geçersiz.');
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
}

export function parseImportPaid(value: unknown): boolean {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value !== 'string') invalid('PAYMENT_INVALID', 'Ödeme durumu geçersiz.');
  const normalized = normalizeText(value);
  if (['true', '1', 'yes', 'y', 'evet', 'odendi', 'paid', 'payment complete', 'x'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'hayir', 'odenmedi', 'unpaid', 'not paid', 'bekliyor', 'pending', 'vadeli'].includes(normalized)) return false;
  invalid('PAYMENT_INVALID', 'Ödeme durumu tanınmadı.');
}

function amountCurrency(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const found = new Set<string>();
  const codePattern = /\b(TRY|TL|USD|EUR|GBP)\b/gi;
  for (const match of value.matchAll(codePattern)) found.add(parseImportCurrency(match[1], 'TRY'));
  for (const [symbol, currency] of Object.entries({ '₺': 'TRY', '$': 'USD', '€': 'EUR', '£': 'GBP' })) {
    if (value.includes(symbol)) found.add(currency);
  }
  if (found.size > 1) invalid('CURRENCY_CONFLICT', 'Tutar alanında birden fazla para birimi var.');
  return found.values().next().value;
}

export function parseImportCurrency(value: unknown, fallback: string, amountValue?: unknown): string {
  const marked = amountCurrency(amountValue);
  const explicit = value !== undefined && value !== null && !(typeof value === 'string' && !value.trim());
  const source = explicit ? value : marked || fallback;
  if (typeof source !== 'string') invalid('CURRENCY_INVALID', 'Para birimi geçersiz.');
  const trimmed = source.trim().toUpperCase();
  const symbols: Record<string, string> = { '₺': 'TRY', TL: 'TRY', '$': 'USD', '€': 'EUR', '£': 'GBP' };
  const currency = symbols[trimmed] || trimmed;
  if (!['TRY', 'USD', 'EUR', 'GBP'].includes(currency)) invalid('CURRENCY_INVALID', 'Para birimi desteklenmiyor. TRY, USD, EUR veya GBP kullanın.');
  if (marked && marked !== currency) invalid('CURRENCY_CONFLICT', 'Tutar ve para birimi alanları uyuşmuyor.');
  return currency;
}
