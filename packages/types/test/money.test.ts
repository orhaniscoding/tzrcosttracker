import { describe, it, expect } from "vitest";
import { moneyFromMinor, moneyFromMajorNumber, moneyToMinor, moneyToMajorNumber, convertMoneyExact } from "../src/money.js";
import * as publicApi from "../src/index.js";
import type { MoneyPolicy, MoneyV1, RationalRate } from "../src/index.js";

const policy: MoneyPolicy = Object.freeze({ version: "test-v1", exponents: Object.freeze({ AAA: 2, BBB: 0, CCC: 3 }) });
const payload = (minor: string, currency = "AAA", exponent = 2): MoneyV1 => ({ version: 1, policyVersion: "test-v1", currency, exponent, minor });
const rate = (numerator: string, denominator: string): RationalRate => ({ numerator, denominator });
const bad = (v: unknown) => v as never;

describe("exact money public codec", () => {
  it("exports five functions through the public index", () => {
    for (const key of ["moneyFromMinor", "moneyFromMajorNumber", "moneyToMinor", "moneyToMajorNumber", "convertMoneyExact"] as const) expect(publicApi[key]).toBeTypeOf("function");
  });
  it("encodes declared minor values and JSON payloads", () => {
    expect(moneyFromMinor(10n + 20n, "AAA", policy)).toEqual(payload("30"));
    expect(moneyFromMajorNumber(0.29, "AAA", policy)).toEqual(payload("29"));
    expect(moneyFromMajorNumber(1e-3, "CCC", policy)).toEqual(payload("1", "CCC", 3));
    expect(moneyFromMajorNumber(-1.25, "AAA", policy)).toEqual(payload("-125"));
    expect(moneyFromMajorNumber(0, "AAA", policy)).toEqual(payload("0"));
    expect(moneyToMinor(JSON.parse(JSON.stringify(payload("-125"))), "AAA", policy)).toBe(-125n);
    expect(moneyToMajorNumber(payload("-125"), "AAA", policy)).toBe(-1.25);
    expect(moneyToMajorNumber(payload("0"), "AAA", policy)).toBe(0);
  });
  it.each([1.001, 0.30000000000000004, 1e-3, -0, NaN, Infinity, -Infinity, "1", null, true])("rejects invalid or inexact major input %s", (v) => {
    expect(() => moneyFromMajorNumber(bad(v), "AAA", policy)).toThrow();
  });
  it("requires primitive bigint and bounded canonical minor values", () => {
    for (const v of [1, "1", null, true, Object(1n)]) expect(() => moneyFromMinor(bad(v), "AAA", policy)).toThrow();
    const max = "9".repeat(100);
    expect(moneyFromMinor(BigInt(max), "AAA", policy).minor).toBe(max);
    expect(moneyToMinor(payload("-" + max), "AAA", policy)).toBe(-BigInt(max));
    expect(() => moneyFromMinor(BigInt("1" + "0".repeat(100)), "AAA", policy)).toThrow();
    expect(() => moneyToMinor(payload("1" + "0".repeat(100)), "AAA", policy)).toThrow();
    for (const v of ["", "-0", "00", "01", "-01", "+1", " 1", "1 ", "1.0", "1e2", 1, null]) expect(() => moneyToMinor({ ...payload("1"), minor: v }, "AAA", policy)).toThrow();
  });
  it("rejects payload metadata mismatches and malformed structures", () => {
    for (const v of [null, [], 1, { ...payload("1"), version: 2 }, { ...payload("1"), policyVersion: "other" }, { ...payload("1"), currency: "BBB" }, { ...payload("1"), exponent: 3 }, { ...payload("1"), extra: 1 }, Object.assign(new Date(), payload("1")), Object.assign(Object.create({ inherited: 1 }), payload("1")), { ...payload("1"), [Symbol("x")]: 1 }]) expect(() => moneyToMinor(v, "AAA", policy)).toThrow();
    expect(() => moneyToMinor(payload("1"), "BBB", policy)).toThrow();
    expect(() => moneyToMinor(payload("1"), "ZZZ", policy)).toThrow();
    let invoked = false;
    const v = { ...payload("1"), get minor() { invoked = true; return "1"; } };
    expect(() => moneyToMinor(v, "AAA", policy)).toThrow();
    expect(invoked).toBe(false);
  });
  it("validates complete policy including boundaries and own data fields", () => {
    const codes = Array.from({ length: 65 }, (_, i) => "A" + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + i % 26));
    const map = Object.fromEntries(codes.slice(0, 64).map(c => [c, 18]));
    const valid = { version: "a".repeat(64), exponents: map };
    expect(moneyFromMinor(1n, codes[0]!, valid).exponent).toBe(18);
    const invalid = [null, [], { version: "", exponents: { AAA: 2 } }, { version: "a".repeat(65), exponents: { AAA: 2 } }, { version: "-bad", exponents: { AAA: 2 } }, { version: "a b", exponents: { AAA: 2 } }, { version: "v", exponents: {} }, { version: "v", exponents: { ...map, [codes[64]!]: 0 } }, { version: "v", exponents: { aaa: 2 } }, { version: "v", exponents: { AAA: 19 } }, { version: "v", exponents: { AAA: -1 } }, { version: "v", exponents: { AAA: 1.5 } }, { version: "v", exponents: { AAA: "2" } }, { ...policy, extra: 1 }, { ...policy, [Symbol("x")]: 1 }, { version: "v", exponents: { AAA: 2, [Symbol("x")]: 1 } }, Object.assign(Object.create({ inherited: 1 }), policy), { version: "v", exponents: Object.assign(Object.create({ BBB: 0 }), { AAA: 2 }) }];
    for (const p of invalid) expect(() => moneyFromMinor(1n, "AAA", bad(p))).toThrow();
    for (const c of ["aaa", " AAA", "ZZZ", null, 1]) expect(() => moneyFromMinor(1n, bad(c), policy)).toThrow();
    let invoked = false;
    const p = { version: "v", exponents: { get AAA() { invoked = true; return 2; } } };
    expect(() => moneyFromMinor(1n, "AAA", p)).toThrow();
    expect(invoked).toBe(false);
    const nullMap = Object.assign(Object.create(null), { AAA: 2 });
    const nullPolicy = Object.assign(Object.create(null), { version: "v", exponents: nullMap });
    expect(moneyFromMinor(1n, "AAA", nullPolicy).minor).toBe("1");
  });
  it("requires exact JSON-number output rather than safe-integer-only gating", () => {
    expect(() => moneyToMajorNumber(payload("9007199254740991"), "AAA", policy)).toThrow();
    expect(moneyToMajorNumber(payload("9007199254741000"), "AAA", policy)).toBe(90071992547410);
  });
  it("converts explicit exact FX ratios including signs, zero and same currency", () => {
    expect(convertMoneyExact(payload("100"), "AAA", "CCC", rate("3", "2"), policy)).toEqual(payload("1500", "CCC", 3));
    expect(convertMoneyExact(payload("1"), "AAA", "CCC", rate("1", "2"), policy)).toEqual(payload("5", "CCC", 3));
    expect(convertMoneyExact(payload("-100"), "AAA", "CCC", rate("3", "2"), policy)).toEqual(payload("-1500", "CCC", 3));
    expect(convertMoneyExact(payload("100"), "AAA", "AAA", rate("2", "1"), policy)).toEqual(payload("200"));
    expect(convertMoneyExact(payload("0"), "AAA", "BBB", rate("1", "3"), policy)).toEqual(payload("0", "BBB", 0));
    expect(() => convertMoneyExact(payload("1"), "AAA", "CCC", rate("1", "3"), policy)).toThrow();
    expect(() => convertMoneyExact(payload("1"), "AAA", "BBB", rate("1", "1"), policy)).toThrow();
    expect(() => convertMoneyExact(payload("1"), "AAA", "ZZZ", rate("1", "1"), policy)).toThrow();
  });
  it("validates rates even for zero and bounds rate and result", () => {
    const max = "9".repeat(100);
    expect(convertMoneyExact(payload("1"), "AAA", "AAA", rate(max, max), policy)).toEqual(payload("1"));
    for (const r of [null, [], rate("0", "1"), rate("1", "0"), rate("01", "1"), rate("-1", "1"), rate("1", "1".repeat(101)), rate("1".repeat(101), "1"), { numerator: 1, denominator: "1" }, { ...rate("1", "1"), extra: 1 }, { ...rate("1", "1"), [Symbol("x")]: 1 }, Object.assign(Object.create({ inherited: 1 }), rate("1", "1"))]) expect(() => convertMoneyExact(payload("0"), "AAA", "AAA", bad(r), policy)).toThrow();
    let invoked = false;
    const r = { get numerator() { invoked = true; return "1"; }, denominator: "1" };
    expect(() => convertMoneyExact(payload("0"), "AAA", "AAA", r, policy)).toThrow();
    expect(invoked).toBe(false);
    expect(() => convertMoneyExact(payload(max), "AAA", "AAA", rate("2", "1"), policy)).toThrow();
  });
  it("accepts frozen inputs without mutation", () => {
    const v = Object.freeze(payload("100")); const r = Object.freeze(rate("3", "2"));
    expect(convertMoneyExact(v, "AAA", "CCC", r, policy)).toEqual(payload("1500", "CCC", 3));
    expect(v).toEqual(payload("100")); expect(r).toEqual(rate("3", "2"));
    expect(policy).toEqual({ version: "test-v1", exponents: { AAA: 2, BBB: 0, CCC: 3 } });
  });
});

describe("canonical strings reject trailing line terminators", () => {
  it.each([10, 13, 8232, 8233])("rejects terminator %s in every textual domain", code => {
    const end = String.fromCharCode(code);
    expect(() => moneyToMinor(payload("1" + end), "AAA", policy)).toThrow();
    expect(() => convertMoneyExact(payload("1"), "AAA", "AAA", rate("1" + end, "1"), policy)).toThrow();
    expect(() => convertMoneyExact(payload("1"), "AAA", "AAA", rate("1", "1" + end), policy)).toThrow();
    expect(() => moneyFromMinor(1n, "AAA", { version: "v" + end, exponents: { AAA: 2 } })).toThrow();
    expect(() => moneyFromMinor(1n, "AAA" + end, { version: "v", exponents: { ["AAA" + end]: 2 } })).toThrow();
  });
});

describe("public scientific-token and boundary regressions", () => {
  it("converts positive and negative scientific JSON tokens exactly at declared scales", () => {
    expect(JSON.stringify(1e21)).toBe("1e+21");
    const large = payload("1" + "0".repeat(21), "BBB", 0);
    expect(publicApi.moneyFromMajorNumber(1e21, "BBB", policy)).toEqual(large);
    expect(publicApi.moneyToMajorNumber(large, "BBB", policy)).toBe(1e21);
    expect(JSON.stringify(1e-7)).toBe("1e-7");
    expect(() => publicApi.moneyFromMajorNumber(1e-7, "BBB", policy)).toThrow();
    const p: MoneyPolicy = { version: policy.version, exponents: { ...policy.exponents, DDD: 18 } };
    expect(JSON.stringify(1e-18)).toBe("1e-18");
    expect(publicApi.moneyFromMajorNumber(1e-18, "DDD", p)).toEqual(payload("1", "DDD", 18));
    // Exactness concerns the JSON token, not binary floating-point arithmetic.
    expect(publicApi.moneyToMajorNumber(payload("1", "DDD", 18), "DDD", p)).toBe(1e-18);
    expect(() => publicApi.moneyFromMajorNumber(Number.MIN_VALUE, "DDD", p)).toThrow();
    expect(() => publicApi.moneyFromMajorNumber(1e101, "BBB", policy)).toThrow();
  });
  it("scales descending FX and rejects negative inexact conversion", () => {
    expect(publicApi.convertMoneyExact(payload("500", "CCC", 3), "CCC", "AAA", rate("1", "1"), policy)).toEqual(payload("50"));
    expect(() => publicApi.convertMoneyExact(payload("-1"), "AAA", "CCC", rate("1", "3"), policy)).toThrow();
  });
  it("requires an own minor field and encodes the negative 100-digit boundary", () => {
    expect(() => publicApi.moneyToMinor({ version: 1, policyVersion: "test-v1", currency: "AAA", exponent: 2 }, "AAA", policy)).toThrow();
    const max = "9".repeat(100);
    expect(publicApi.moneyFromMinor(-BigInt(max), "AAA", policy)).toEqual(payload("-" + max));
  });
});
