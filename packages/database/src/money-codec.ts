import { encryptField, decryptField } from '@cost-core/crypto';
import { moneyFromMinor, moneyToMinor, type MoneyPolicy } from '@cost-core/types';

export function encryptMoneyMinor(value: bigint, currency: string, policy: MoneyPolicy, masterKey: string | Buffer): string {
  return encryptField(moneyFromMinor(value, currency, policy), masterKey);
}

export function decryptMoneyMinor(ciphertext: unknown, expectedCurrency: string, policy: MoneyPolicy, masterKey: string | Buffer): bigint {
  if (typeof ciphertext !== 'string' || ciphertext.length > 4096) throw new Error('Invalid encrypted money envelope');
  const match = /^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:(?:[0-9a-f]{2})+$/.exec(ciphertext);
  if (!match || match[0] !== ciphertext) throw new Error('Invalid encrypted money envelope');
  return moneyToMinor(decryptField<unknown>(ciphertext, masterKey), expectedCurrency, policy);
}
