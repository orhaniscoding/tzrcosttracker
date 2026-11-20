import { describe, expect, it } from 'vitest';
import { moneyFromMinor } from '@cost-core/types';
import { effectOf, cashEffectOf } from '../src/financial-effects.js';
import { exactAccountEffect, exactCashEffect, type ExactFinancialInput } from '../src/exact-financial-effects.js';

const policy = Object.freeze({ version: 'synthetic-1', exponents: Object.freeze({ AAA: 2, BBB: 0, CCC: 18 }) });
const amount = (n: bigint, currency = 'AAA') => moneyFromMinor(n, currency, policy);
const base: ExactFinancialInput = Object.freeze({ type: 'expense', status: 'approved', paymentSource: 'company_account', isPaid: true, currency: 'AAA', amount: Object.freeze(amount(29n)), accountFromId: 'wallet-a', accountToId: 'wallet-b', otoKasaTransactionId: null, deletedAt: null });
const bad = (tx: any, p: any = policy) => {
  for (const fn of [() => exactAccountEffect(tx, p), () => exactCashEffect(tx, p)]) {
    let caught: any;
    try { fn(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toBe('Invalid exact financial effect');
    expect(caught.cause).toBeUndefined();
    expect(String(caught)).not.toContain('SECRET_MARKER');
  }
};

describe('exact financial effects', () => {
  it('uses exact bigint signs for both helpers, including zero and extreme magnitudes', () => {
    const huge = BigInt('9'.repeat(100));
    for (const currency of ['AAA', 'BBB', 'CCC']) {
      for (const n of [1n, -1n, 0n, huge, -huge]) {
        const tx = Object.freeze({ ...base, currency, amount: Object.freeze(amount(n, currency)) });
        expect(exactAccountEffect(tx, policy)).toEqual({ accountId: 'wallet-a', delta: amount(-n, currency) });
        expect(exactCashEffect(tx, policy)).toEqual(amount(-n, currency));
        const income = Object.freeze({ ...tx, type: 'income' as const });
        expect(exactAccountEffect(income, policy)).toEqual({ accountId: 'wallet-b', delta: amount(n, currency) });
        expect(exactCashEffect(income, policy)).toEqual(amount(n, currency));
      }
    }
    expect(exactCashEffect({ ...base, currency: 'CCC', amount: amount(1n, 'CCC') }, policy)?.minor).toBe('-1');
    expect(exactCashEffect({ ...base, currency: 'CCC', amount: amount(-1n, 'CCC') }, policy)?.minor).toBe('1');
    expect(exactCashEffect({ ...base, amount: amount(0n) }, policy)?.minor).toBe('0');
  });

  it('implements the explicit seven-status by type and paid decision table', () => {
    const rows = [
      ['draft', false, false], ['pending_approval', false, false],
      ['pending', true, false], ['approved', true, true], ['paid', true, true],
      ['rejected', false, false], ['cancelled', false, false],
    ] as const;
    for (const [status, expensePaid, incomePaid] of rows) {
      for (const type of ['expense', 'income', 'transfer'] as const) {
        for (const isPaid of [false, true]) {
          const tx = { ...base, status, type, isPaid };
          const applies = isPaid && (type === 'expense' ? expensePaid : type === 'income' ? incomePaid : false);
          const delta = type === 'expense' ? amount(-29n) : amount(29n);
          expect(exactCashEffect(tx, policy), `${status}/${type}/${isPaid} cash`).toEqual(applies ? delta : null);
          expect(exactAccountEffect(tx, policy), `${status}/${type}/${isPaid} account`).toEqual(applies ? { accountId: type === 'expense' ? 'wallet-a' : 'wallet-b', delta } : null);
        }
      }
    }
  });

  it('separates OTO, payment source, wallet side and deletion rules', () => {
    expect(exactCashEffect({ ...base, otoKasaTransactionId: 'oto' }, policy)).toEqual(amount(-29n));
    expect(exactAccountEffect({ ...base, otoKasaTransactionId: 'oto' }, policy)).toEqual({ accountId: 'wallet-a', delta: amount(-29n) });
    expect(exactCashEffect({ ...base, type: 'income', otoKasaTransactionId: 'oto' }, policy)).toBeNull();
    expect(exactAccountEffect({ ...base, type: 'income', otoKasaTransactionId: 'oto' }, policy)).toBeNull();
    for (const type of ['expense', 'income', 'transfer'] as const) {
      const tx = { ...base, type, paymentSource: 'person_out_of_pocket' as const };
      expect(exactCashEffect(tx, policy)).toBeNull();
      expect(exactAccountEffect(tx, policy)).toBeNull();
    }
    for (const [type, from, to, delta] of [['expense', null, 'wrong', -29n], ['income', 'wrong', null, 29n]] as const) {
      const tx = { ...base, type, accountFromId: from, accountToId: to };
      expect(exactAccountEffect(tx, policy)).toBeNull();
      expect(exactCashEffect(tx, policy)).toEqual(amount(delta));
    }
    const deleted = { ...base, deletedAt: 'legacy timestamp' };
    expect(exactAccountEffect(deleted, policy)).toBeNull();
    expect(exactAccountEffect(deleted, policy, false)).toBeNull();
    expect(exactAccountEffect(deleted, policy, undefined)).toBeNull();
    expect(exactAccountEffect(deleted, policy, true)).toEqual({ accountId: 'wallet-a', delta: amount(-29n) });
    expect(exactCashEffect(deleted, policy)).toBeNull();
    expect(exactAccountEffect({ ...base, accountFromId: ' padded ' }, policy)?.accountId).toBe(' padded ');
    for (const id of ['x'.repeat(128), 'hesap-😀']) {
      expect(exactAccountEffect({ ...base, accountFromId: id }, policy)).toEqual({ accountId: id, delta: amount(-29n) });
    }
    const extra = { ...base, harmlessNote: 'ignored' };
    expect(exactAccountEffect(extra, policy)).toEqual({ accountId: 'wallet-a', delta: amount(-29n) });
    expect(exactCashEffect(extra, policy)).toEqual(amount(-29n));
  });

  it('validates nullable IDs and required own properties, without coercion', () => {
    for (const key of ['accountFromId', 'accountToId', 'otoKasaTransactionId']) {
      for (const value of ['', '   ', 'x'.repeat(129), '\ud800', 12, undefined]) bad({ ...base, [key]: value });
      const missing: any = { ...base }; delete missing[key]; bad(missing);
    }
    for (const key of Object.keys(base)) {
      const missing: any = { ...base }; delete missing[key]; bad(missing);
    }
    for (const patch of [{ type: 'unknown' }, { status: 'unknown' }, { paymentSource: 'unknown' }, { isPaid: 1 }, { deletedAt: '' }, { deletedAt: 0 }, { currency: 'SECRET_MARKER' }, { amount: 0.29 }]) bad({ ...base, ...patch });
    bad(undefined); bad([]); bad('expense');
    const inherited = Object.create(base); bad(inherited);
  });

  it('validates money and policy before every no-effect filter', () => {
    const invalidAmounts = [
      { ...base.amount, minor: '-0' }, { ...base.amount, minor: '1'.repeat(101) },
      { ...base.amount, minor: '01' }, { ...base.amount, minor: 'SECRET_MARKER' },
      { ...base.amount, currency: 'BBB' }, { ...base.amount, exponent: 18 },
      { ...base.amount, policyVersion: 'wrong' }, { ...base.amount, version: 2 },
      { ...base.amount, extra: true }, null,
    ];
    const states = [{}, { status: 'draft' }, { deletedAt: 'old' }, { type: 'income', otoKasaTransactionId: 'oto' }, { accountFromId: null }, { paymentSource: 'person_out_of_pocket' }];
    for (const state of states) {
      for (const value of invalidAmounts) bad({ ...base, ...state, amount: value });
      bad({ ...base, ...state }, { version: 'SECRET_MARKER', exponents: { AAA: 99 } });
      bad({ ...base, ...state }, { version: 'synthetic-1', exponents: { AAA: 2, BBB: 99 } });
      bad({ ...base, ...state, type: 'unknown' });
    }
  });

  it('checks includeDeleted before null while null does not inspect policy', () => {
    expect(exactAccountEffect(null, null as any)).toBeNull();
    expect(exactCashEffect(null, null as any)).toBeNull();
    for (const option of [null, 0, 1, 'true', {}]) {
      for (const tx of [null, base]) {
        let caught: any;
        try { exactAccountEffect(tx, policy, option as any); } catch (e) { caught = e; }
        expect(caught).toBeInstanceOf(Error);
        expect(caught.message).toBe('Invalid exact financial effect');
        expect(caught.cause).toBeUndefined();
      }
    }
    expect(exactCashEffect({ ...base, status: 'draft', amount: amount(0n) }, policy)).toBeNull();
    expect(exactCashEffect({ ...base, amount: amount(0n) }, policy)).toEqual(amount(0n));
  });

  it('matches legacy eligibility and sign only for explicit small two-decimal inputs', () => {
    for (const status of ['draft', 'pending_approval', 'pending', 'approved', 'paid', 'rejected', 'cancelled'] as const) {
      for (const type of ['expense', 'income', 'transfer'] as const) {
        for (const isPaid of [false, true]) {
          for (const accounts of [{ accountFromId: 'wallet-a', accountToId: 'wallet-b' }, { accountFromId: null, accountToId: null }]) {
            const tx = { ...base, ...accounts, status, type, isPaid };
            const legacy = { ...tx, amount: 0.29 };
            const oldAccount = effectOf(legacy);
            const exactAccount = exactAccountEffect(tx, policy);
            expect(exactAccount === null ? null : { accountId: exactAccount.accountId, delta: Number(exactAccount.delta.minor) / 100 }).toEqual(oldAccount);
            const exactCash = exactCashEffect(tx, policy);
            expect(exactCash === null ? 0 : Number(exactCash.minor) / 100).toBe(cashEffectOf(legacy));
          }
        }
      }
    }
  });
});
