import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { initDatabase, UserRepository, users } from '../src/index.js';

function makeRow(overrides: Record<string, any> = {}) {
  const now = new Date().toISOString();
  const base = {
    id: 'user-synthetic-1',
    username: 'synthetic_user',
    email: 'synthetic@example.test',
    fullName: 'Synthetic User',
    passwordHash: 'synthetic-password-hash',
    pinHash: 'synthetic-pin-hash',
    role: 'viewer',
    isActive: true,
    twoFactorEnabled: true,
    twoFactorSecret: 'synthetic-encrypted-secret',
    twoFactorBackupCodes: JSON.stringify(['synthetic-code']),
    createdAt: now,
    updatedAt: now,
  };
  return { ...base, ...overrides };
}

describe('UserRepository.getAuthStateById', () => {
  let db: any;
  let sqlite: any;
  let userRepo: UserRepository;

  beforeEach(() => {
    const initialized = initDatabase({ path: ':memory:' });
    db = initialized.db;
    sqlite = initialized.sqlite;
    userRepo = new UserRepository(db);
  });

  afterEach(() => {
    if (sqlite) {
      sqlite.close();
      sqlite = undefined;
    }
  });

  it('returns exactly the four auth-state fields with exact values', async () => {
    await db.insert(users).values(makeRow({ id: 'auth-1', username: 'alice', role: 'admin', isActive: true }));

    const state = await userRepo.getAuthStateById('auth-1');

    expect(state).not.toBeNull();
    expect(Object.keys(state!).sort()).toEqual(['id', 'isActive', 'role', 'username']);
    expect(state).toEqual({ id: 'auth-1', username: 'alice', role: 'admin', isActive: true });
    expect(Object.keys(state!)).not.toContain('passwordHash');
    expect(Object.keys(state!)).not.toContain('twoFactorSecret');
  });

  it('returns null for an unknown id', async () => {
    const state = await userRepo.getAuthStateById('does-not-exist');
    expect(state).toBeNull();
  });

  it('reflects subsequent database changes to username, role and isActive', async () => {
    await db.insert(users).values(makeRow({ id: 'auth-2', username: 'bob', role: 'viewer', isActive: true }));

    const before = await userRepo.getAuthStateById('auth-2');
    expect(before).toEqual({ id: 'auth-2', username: 'bob', role: 'viewer', isActive: true });

    await db
      .update(users)
      .set({ username: 'bobby', role: 'manager', isActive: false, updatedAt: new Date().toISOString() })
      .where(eq(users.id, 'auth-2'));

    const after = await userRepo.getAuthStateById('auth-2');
    expect(after).toEqual({ id: 'auth-2', username: 'bobby', role: 'manager', isActive: false });
  });
});
