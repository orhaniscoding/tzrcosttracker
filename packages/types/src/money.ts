export type MoneyPolicy = { readonly version: string; readonly exponents: Readonly<Record<string, number>> };
export type MoneyV1 = { readonly version: 1; readonly policyVersion: string; readonly currency: string; readonly exponent: number; readonly minor: string };
export type RationalRate = { readonly numerator: string; readonly denominator: string };

function full(pattern: RegExp, value: string): boolean {
  const match = pattern.exec(value);
  return match !== null && match[0] === value;
}

function fields(value: unknown, expected?: readonly string[], maxKeys = 64): Record<string, unknown> {
  if (value === null || typeof value !== "object") throw new Error("Expected plain object");
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) throw new Error("Expected plain object");
  const keys = Reflect.ownKeys(value);
  if (keys.length > maxKeys || keys.some(k => typeof k !== "string") || (expected && (keys.length !== expected.length || expected.some(k => !keys.includes(k))))) throw new Error("Invalid fields");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new Error("Expected data field");
    result[key as string] = descriptor.value;
  }
  return result;
}

function validatedPolicy(value: unknown): { version: string; exponents: Record<string, number> } {
  const p = fields(value, ["version", "exponents"], 2);
  if (typeof p.version !== "string" || p.version.length < 1 || p.version.length > 64 || !full(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, p.version)) throw new Error("Invalid policy version");
  const raw = fields(p.exponents);
  const keys = Object.keys(raw);
  if (keys.length < 1) throw new Error("Invalid exponent map");
  const exponents: Record<string, number> = Object.create(null);
  for (const key of keys) {
    const n = raw[key];
    if (key.length !== 3 || !full(/^[A-Z]{3}$/, key) || typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 18) throw new Error("Invalid exponent");
    exponents[key] = n;
  }
  return { version: p.version, exponents };
}

function exponent(currency: unknown, p: { exponents: Record<string, number> }): number {
  if (typeof currency !== "string" || currency.length !== 3 || !Object.prototype.hasOwnProperty.call(p.exponents, currency)) throw new Error("Unknown currency");
  return p.exponents[currency]!;
}

function minorText(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 101 || (value.length === 101 && value[0] !== "-") || !full(/^(0|-?[1-9][0-9]*)$/, value)) throw new Error("Invalid minor");
  return value;
}

function positiveText(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100 || !full(/^[1-9][0-9]*$/, value)) throw new Error("Invalid rate");
  return value;
}

function decimalMinor(value: number, scale: number): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) throw new Error("Invalid number");
  const token = JSON.stringify(value);
  const match = /^(-?)([0-9]+)(?:[.]([0-9]+))?(?:e([+-]?[0-9]+))?$/.exec(token);
  if (!match || match[0] !== token) throw new Error("Invalid number token");
  const digits = match[2]! + (match[3] ?? "");
  const shift = scale + Number(match[4] ?? "0") - (match[3]?.length ?? 0);
  let result = BigInt(digits);
  if (shift >= 0) result *= 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    if (result % divisor !== 0n) throw new Error("Inexact amount");
    result /= divisor;
  }
  return match[1] === "-" ? -result : result;
}

function decode(value: unknown, currency: unknown, p: { version: string; exponents: Record<string, number> }): bigint {
  const exp = exponent(currency, p);
  const v = fields(value, ["version", "policyVersion", "currency", "exponent", "minor"], 5);
  if (v.version !== 1 || v.policyVersion !== p.version || v.currency !== currency || v.exponent !== exp) throw new Error("Money metadata mismatch");
  return BigInt(minorText(v.minor));
}

function make(value: bigint, currency: string, p: { version: string; exponents: Record<string, number> }): MoneyV1 {
  const exp = exponent(currency, p);
  const minor = minorText(value.toString());
  return { version: 1, policyVersion: p.version, currency, exponent: exp, minor };
}

export function moneyFromMinor(value: bigint, currency: string, policy: MoneyPolicy): MoneyV1 {
  const p = validatedPolicy(policy);
  if (typeof value !== "bigint") throw new Error("Expected bigint");
  return make(value, currency, p);
}

export function moneyFromMajorNumber(value: number, currency: string, policy: MoneyPolicy): MoneyV1 {
  const p = validatedPolicy(policy);
  const exp = exponent(currency, p);
  return make(decimalMinor(value, exp), currency, p);
}

export function moneyToMinor(value: unknown, expectedCurrency: string, policy: MoneyPolicy): bigint {
  return decode(value, expectedCurrency, validatedPolicy(policy));
}

export function moneyToMajorNumber(value: unknown, expectedCurrency: string, policy: MoneyPolicy): number {
  const p = validatedPolicy(policy);
  const exp = exponent(expectedCurrency, p);
  const minor = decode(value, expectedCurrency, p);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exp + 1, "0");
  const decimal = (negative ? "-" : "") + (exp === 0 ? digits : digits.slice(0, -exp) + "." + digits.slice(-exp));
  const result = Number(decimal);
  if (!Number.isFinite(result) || decimalMinor(result, exp) !== minor) throw new Error("Inexact number output");
  return result;
}

export function convertMoneyExact(value: unknown, expectedSourceCurrency: string, targetCurrency: string, rate: RationalRate, policy: MoneyPolicy): MoneyV1 {
  const p = validatedPolicy(policy);
  const sourceExp = exponent(expectedSourceCurrency, p);
  const targetExp = exponent(targetCurrency, p);
  const minor = decode(value, expectedSourceCurrency, p);
  const r = fields(rate, ["numerator", "denominator"], 2);
  const numeratorText = positiveText(r.numerator);
  const denominatorText = positiveText(r.denominator);
  const numerator = minor * BigInt(numeratorText) * (10n ** BigInt(targetExp));
  const denominator = BigInt(denominatorText) * (10n ** BigInt(sourceExp));
  if (numerator % denominator !== 0n) throw new Error("Inexact conversion");
  return make(numerator / denominator, targetCurrency, p);
}
