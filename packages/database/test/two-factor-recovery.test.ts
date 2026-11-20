import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { initDatabase, UserRepository, users } from '../src/index.js';
import { hashBackupCode, generateBackupCodes, generateTotpSecret } from '@cost-core/crypto';

const H = (c: string) => hashBackupCode(c);

function row(overrides: Record<string, any> = {}) {
  const now = new Date().toISOString();
  const base = {
    id: 'u1', username: 'u1', email: 'u1@example.test', fullName: 'Synthetic User',
    passwordHash: 'synthetic-password-hash', pinHash: null, role: 'viewer', isActive: true,
    twoFactorEnabled: true, twoFactorSecret: generateTotpSecret('synthetic-seed').secret,
    twoFactorBackupCodes: JSON.stringify([]), createdAt: now, updatedAt: now,
  };
  return { ...base, ...overrides };
}

describe('UserRepository.consumeBackupCodeInTx', () => {
  let db: any;
  let sqlite: any;
  let repo: UserRepository;

  beforeEach(() => {
    const initialized = initDatabase({ path: ':memory:' });
    db = initialized.db;
    sqlite = initialized.sqlite;
    repo = new UserRepository(db);
  });

  afterEach(() => {
    if (sqlite) { sqlite.close(); sqlite = undefined; }
  });
  function add(overrides: Record<string, any> = {}) {
    const r = row(overrides);
    db.insert(users).values(r).run();
    return r;
  }

  function seed(id: string, hashes: string[], over: Record<string, any> = {}) {
    add({ id, username: id, email: id + '@example.test', twoFactorBackupCodes: JSON.stringify(hashes), ...over });
  }

  function get(id: string) {
    return db.select().from(users).where(eq(users.id, id)).get();
  }

  it('consumes a valid code exactly once and retains unrelated codes', () => {
    const codes = generateBackupCodes(3);
    seed('a1', codes.map(H));
    expect(repo.consumeBackupCodeInTx(db, 'a1', H(codes[0]))).toBe(true);
    const left = JSON.parse(get('a1').twoFactorBackupCodes);
    expect(left).toHaveLength(2);
    expect(left).not.toContain(H(codes[0]));
    expect(left).toContain(H(codes[1]));
    expect(left).toContain(H(codes[2]));
    expect(repo.consumeBackupCodeInTx(db, 'a1', H(codes[0]))).toBe(false);
  });
  it('returns false for an unknown hash without mutating the row', () => {
    const codes = generateBackupCodes(2);
    seed('b1', codes.map(H));
    const before = JSON.stringify(get('b1'));
    expect(repo.consumeBackupCodeInTx(db, 'b1', H('ZZZZ-9999'))).toBe(false);
    expect(repo.consumeBackupCodeInTx(db, 'b1', 'not-a-sha256')).toBe(false);
    expect(JSON.stringify(get('b1'))).toBe(before);
  });

  it('returns false for a mismatched user id without mutating either row', () => {
    const codes = generateBackupCodes(2);
    seed('c1', codes.map(H));
    seed('c2', []);
    const before = JSON.stringify(get('c1'));
    expect(repo.consumeBackupCodeInTx(db, 'c2', H(codes[0]))).toBe(false);
    expect(JSON.stringify(get('c1'))).toBe(before);
  });

  it('returns false and writes nothing when 2FA is disabled', () => {
    const codes = generateBackupCodes(2);
    seed('d1', codes.map(H), { twoFactorEnabled: false });
    const before = JSON.stringify(get('d1'));
    expect(repo.consumeBackupCodeInTx(db, 'd1', H(codes[0]))).toBe(false);
    expect(JSON.stringify(get('d1'))).toBe(before);
  });

  it('returns false and writes nothing when the user is inactive', () => {
    const codes = generateBackupCodes(2);
    seed('e1', codes.map(H), { isActive: false });
    const before = JSON.stringify(get('e1'));
    expect(repo.consumeBackupCodeInTx(db, 'e1', H(codes[0]))).toBe(false);
    expect(JSON.stringify(get('e1'))).toBe(before);
  });
  it('removes all duplicate matching hashes and rejects replay', () => {
    const c = 'AAAA-1111';
    const other = 'BBBB-2222';
    seed('f1', [H(c), H(c), H(other)]);
    expect(repo.consumeBackupCodeInTx(db, 'f1', H(c))).toBe(true);
    const left = JSON.parse(get('f1').twoFactorBackupCodes);
    expect(left).toEqual([H(other)]);
    expect(repo.consumeBackupCodeInTx(db, 'f1', H(c))).toBe(false);
    expect(JSON.parse(get('f1').twoFactorBackupCodes)).toEqual([H(other)]);
  });

  it('fails closed with a generic error on malformed stored JSON', () => {
    seed('g1', [], { twoFactorBackupCodes: 'not-json' });
    const before = JSON.stringify(get('g1'));
    let msg = '';
    try { repo.consumeBackupCodeInTx(db, 'g1', H('AAAA-1111')); } catch (e: any) { msg = e.message; }
    expect(msg).toBe('INVALID_BACKUP_CODE_STATE');
    expect(msg).not.toContain('not-json');
    expect(JSON.stringify(get('g1'))).toBe(before);
  });

  it('fails closed when the stored value is not an array', () => {
    seed('g2', [], { twoFactorBackupCodes: '{a:1}' });
    const before = JSON.stringify(get('g2'));
    expect(() => repo.consumeBackupCodeInTx(db, 'g2', H('AAAA-1111'))).toThrow('INVALID_BACKUP_CODE_STATE');
    expect(JSON.stringify(get('g2'))).toBe(before);
  });
  it('fails closed when an entry is not a hex64 string', () => {
    seed('g3', [], { twoFactorBackupCodes: JSON.stringify(['zzz']) });
    const before = JSON.stringify(get('g3'));
    expect(() => repo.consumeBackupCodeInTx(db, 'g3', H('AAAA-1111'))).toThrow('INVALID_BACKUP_CODE_STATE');
    expect(JSON.stringify(get('g3'))).toBe(before);
    seed('g4', [], { twoFactorBackupCodes: JSON.stringify([12]) });
    const before4 = JSON.stringify(get('g4'));
    expect(() => repo.consumeBackupCodeInTx(db, 'g4', H('AAAA-1111'))).toThrow('INVALID_BACKUP_CODE_STATE');
    expect(JSON.stringify(get('g4'))).toBe(before4);
  });

  it('fails closed when the stored list exceeds 256 entries', () => {
    const many = Array.from({ length: 257 }, (_, i) => i.toString(16).padStart(64, '0'));
    seed('g5', [], { twoFactorBackupCodes: JSON.stringify(many) });
    const before = JSON.stringify(get('g5'));
    expect(() => repo.consumeBackupCodeInTx(db, 'g5', H('AAAA-1111'))).toThrow('INVALID_BACKUP_CODE_STATE');
    expect(JSON.stringify(get('g5'))).toBe(before);
  });

  it('rolls back a consumed code when the enclosing transaction throws', () => {
    const codes = generateBackupCodes(3);
    seed('h1', codes.map(H));
    const before = JSON.stringify(get('h1'));
    expect(() => db.transaction((tx: any) => {
      expect(repo.consumeBackupCodeInTx(tx, 'h1', H(codes[0]))).toBe(true);
      throw new Error('abort-after-consume');
    }, { behavior: 'immediate' })).toThrow('abort-after-consume');
    expect(JSON.stringify(get('h1'))).toBe(before);
    let ok = false;
    db.transaction((tx: any) => { ok = repo.consumeBackupCodeInTx(tx, 'h1', H(codes[0])); }, { behavior: 'immediate' });
    expect(ok).toBe(true);
    expect(JSON.parse(get('h1').twoFactorBackupCodes)).not.toContain(H(codes[0]));
  });
  it('observes consumption across two independent connections to the same temp DB', () => {
    const root = mkdtempSync(join(tmpdir(), 'cctwofa-'));
    const file = join(root, 'synthetic.db');
    let a: any;
    let b: any;
    try {
      a = initDatabase({ path: file });
      b = initDatabase({ path: file });
      const codes = generateBackupCodes(2);
      a.db.insert(users).values(row({ id: 'i1', username: 'i1', email: 'i1@example.test', twoFactorBackupCodes: JSON.stringify(codes.map(H)) })).run();
      const repoA = new UserRepository(a.db);
      const repoB = new UserRepository(b.db);
      expect(repoA.consumeBackupCodeInTx(a.db, 'i1', H(codes[0]))).toBe(true);
      expect(repoB.consumeBackupCodeInTx(b.db, 'i1', H(codes[0]))).toBe(false);
      expect(repoB.consumeBackupCodeInTx(b.db, 'i1', H(codes[1]))).toBe(true);
      expect(JSON.parse(a.db.select().from(users).where(eq(users.id, 'i1')).get().twoFactorBackupCodes)).toEqual([]);
    } finally {
      if (a) a.sqlite.close();
      if (b) b.sqlite.close();
      const verifiedTarget = realpathSync(root);
      const tempRoot = realpathSync(tmpdir());
      if (!verifiedTarget.startsWith(tempRoot + sep) || !basename(verifiedTarget).startsWith('cctwofa-')) { throw new Error('UNSAFE_CLEANUP_TARGET'); }
      expect(existsSync(verifiedTarget)).toBe(true);
      rmSync(verifiedTarget, { recursive: true, force: true });
      expect(existsSync(verifiedTarget)).toBe(false);
    }
  });
});
