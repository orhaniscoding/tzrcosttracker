import { describe, it, expect } from 'vitest';
import { encryptField, decryptField } from '@cost-core/crypto';
import { moneyFromMinor, type MoneyPolicy } from '@cost-core/types';
import { encryptMoneyMinor, decryptMoneyMinor } from '../src/money-codec.js';

const policy: MoneyPolicy = Object.freeze({ version: 'test-v1', exponents: Object.freeze({ AAA: 2, BBB: 0, CCC: 3 }) });
const key = 'synthetic-test-key';
const payload = moneyFromMinor(123n, 'AAA', policy);
const bad = <T>(v: unknown) => v as T;

describe('encrypted money adapter', () => {
  it('roundtrips exact signed boundaries and exposes canonical MoneyV1', () => {
    const max = BigInt('9'.repeat(100));
    for (const value of [0n, 1n, -1n, 123n, -123n, max, -max]) {
      for (const currency of ['AAA', 'BBB', 'CCC']) {
        const encrypted = encryptMoneyMinor(value, currency, policy, key);
        expect(decryptField<unknown>(encrypted, key)).toEqual(moneyFromMinor(value, currency, policy));
        expect(decryptMoneyMinor(encrypted, currency, policy, key)).toBe(value);
      }
    }
    const a = encryptMoneyMinor(123n, 'AAA', policy, key);
    const b = encryptMoneyMinor(123n, 'AAA', policy, key);
    expect(a.split(':')[2]).not.toBe(b.split(':')[2]);
    expect(decryptMoneyMinor(a, 'AAA', policy, key)).toBe(123n);
    expect(decryptMoneyMinor(b, 'AAA', policy, key)).toBe(123n);
  });
  it('interoperates with generic AES for all existing key forms', () => {
    for (const k of [key, Buffer.alloc(32, 7), Buffer.alloc(5, 8)]) {
      expect(decryptField<unknown>(encryptMoneyMinor(123n, 'AAA', policy, k), k)).toEqual(payload);
      expect(decryptMoneyMinor(encryptField(payload, k), 'AAA', policy, k)).toBe(123n);
    }
  });
  it('rejects tampering, noncanonical envelopes and nonstrings', () => {
    const good = encryptMoneyMinor(123n, 'AAA', policy, key);
    expect(() => decryptMoneyMinor(good, 'AAA', policy, 'wrong-synthetic-key')).toThrow();
    const parts = good.split(':');
    for (const index of [2, 3, 4]) {
      const altered = [...parts];
      const s = altered[index]!;
      altered[index] = (s[0] === '0' ? '1' : '0') + s.slice(1);
      expect(() => decryptMoneyMinor(altered.join(':'), 'AAA', policy, key)).toThrow();
    }
    const malformed: unknown[] = [null, undefined, 123, {}, '', good.slice(0, -1), good.slice(0, -2), good + ':', good + ' ', ' ' + good, good.replace('enc:v1:', 'enc:v2:'), good.replace('enc:v1:', 'enc:v1::'), good.slice(0, -1) + 'g', good.slice(0, 7) + 'A' + good.slice(8), JSON.stringify(payload), ...[10, 13, 8232, 8233].map(c => good + String.fromCharCode(c))];
    for (const value of malformed) expect(() => decryptMoneyMinor(value, 'AAA', policy, key)).toThrow();
  });
  it('enforces the envelope limit before decoding otherwise valid authenticated JSON', () => {
    const json = JSON.stringify(payload);
    const make = (bytes: number) => encryptField(' '.repeat(bytes - Buffer.byteLength(json)) + json, key);
    const inside = make(2015), outside = make(2016);
    expect(inside.length).toBe(4095);
    expect(outside.length).toBe(4097);
    expect(decryptField<unknown>(outside, key)).toEqual(payload);
    expect(decryptMoneyMinor(inside, 'AAA', policy, key)).toBe(123n);
    expect(() => decryptMoneyMinor(outside, 'AAA', policy, key)).toThrow();
    const longPolicy: MoneyPolicy = { version: 'v'.repeat(64), exponents: { AAA: 2 } };
    const maximum = BigInt('9'.repeat(100));
    const normal = encryptMoneyMinor(-maximum, 'AAA', longPolicy, key);
    expect(normal.length).toBeLessThanOrEqual(4096);
    expect(decryptMoneyMinor(normal, 'AAA', longPolicy, key)).toBe(-maximum);
  });
  it('rejects authenticated legacy and malformed payloads', () => {
    const { minor: ignored, ...missing } = payload;
    const invalid: (string | number | object)[] = [123, 'legacy', 'null', [], missing, { ...payload, extra: 1 }, { ...payload, version: 2 }, { ...payload, policyVersion: 'other' }, { ...payload, currency: 'BBB' }, { ...payload, exponent: 0 }, ...['-0', '01', '+1', '1.0', '1'.repeat(101)].map(minor => ({ ...payload, minor })), { ...payload, minor: 1 }];
    for (const value of invalid) expect(() => decryptMoneyMinor(encryptField(value, key), 'AAA', policy, key)).toThrow();
    expect(() => decryptMoneyMinor(encryptField(payload, key), 'BBB', policy, key)).toThrow();
  });
  it('rejects invalid values and policies without mutating or invoking accessors', () => {
    let invoked = false;
    const accessor = { get version() { invoked = true; return 'test-v1'; }, exponents: { AAA: 2 } };
    const unknown = { version: 'test-v1', exponents: { AAA: 2 }, extra: true };
    const before = JSON.stringify(unknown);
    const encrypted = encryptField(payload, key);
    for (const p of [accessor, unknown, null]) {
      expect(() => encryptMoneyMinor(1n, 'AAA', bad<MoneyPolicy>(p), key)).toThrow();
      expect(() => decryptMoneyMinor(encrypted, 'AAA', bad<MoneyPolicy>(p), key)).toThrow();
    }
    expect(invoked).toBe(false);
    expect(JSON.stringify(unknown)).toBe(before);
    for (const value of [1, '1', null, BigInt('1'.repeat(101))]) expect(() => encryptMoneyMinor(bad<bigint>(value), 'AAA', policy, key)).toThrow();
    expect(policy).toEqual({ version: 'test-v1', exponents: { AAA: 2, BBB: 0, CCC: 3 } });
  });
});
