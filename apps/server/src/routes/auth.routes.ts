import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateUserSchema,
  LoginSchema,
  TwoFactorVerifySchema,
  SetPinSchema,
  SwitchUserPinSchema, UserRoleSchema,
  z,
} from '@cost-core/types';
import {
  verifyPassword,
  hashPassword,
  generateTotpSecret,
  verifyTotp,
  generateBackupCodes,
  hashBackupCode,
  decryptField,
} from '@cost-core/crypto';
import { AuditLogRepository, authSessions, users, type CostCoreDatabase } from '@cost-core/database';
import { eq, or, sql } from 'drizzle-orm';
import { ForbiddenError, SessionInvalidError } from '../services/project-access.service.js';

class UserIdentifierConflictError extends Error {}

// Public directory DTO only: PIN presence is computed by SQLite, never read as
// a hash. No password, TOTP secret or recovery-code column is selected.
const publicUserColumns = {
  id: users.id, username: users.username, email: users.email,
  fullName: users.fullName, role: users.role, isActive: users.isActive,
  hasPin: sql<boolean>`case when ${users.pinHash} is not null and ${users.pinHash} <> '' then 1 else 0 end`.mapWith(Boolean),
  twoFactorEnabled: users.twoFactorEnabled,
  createdAt: users.createdAt, updatedAt: users.updatedAt,
};

function userManagementError(reply: FastifyReply, error: unknown) {
  if (error instanceof SessionInvalidError) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erişim.' });
  if (error instanceof ForbiddenError) return reply.status(403).send({ error: 'Yasak.' });
  if (error instanceof UserIdentifierConflictError) return reply.status(409).send({ error: 'Bu kullanıcı adı veya e-posta zaten kullanımda.' });
  return reply.status(500).send({ error: 'Beklenmedik bir hata oluştu. Lütfen daha sonra tekrar deneyin.' });
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const { userRepo, auditRepo, config, sessionRepo } = fastify;
  const db: any = (fastify as any).db;
  const insertAuditSync = (tx: any, input: any) => {
    new AuditLogRepository(tx).logAction(input, config.masterKey);
  };
  const hashId = (v: string) => createHash('sha256').update(v).digest('hex');
  const normId = (req: any) => { const b: any = req?.body; const raw = b && typeof b === 'object' && typeof b.usernameOrEmail === 'string' ? b.usernameOrEmail : ''; return raw.trim().toLowerCase(); };
  const uid = (req: any) => { const u: any = req?.user; return u && typeof u.id === 'string' ? u.id : ''; };
  const checkLoginAcct = fastify.createRateLimit({ max: 5, timeWindow: 60000, keyGenerator: async (req: any) => { const idn = normId(req); if (!idn) { return 'login-acct:empty'; } try { const u: any = await userRepo.getUserByUsernameOrEmail(idn); if (u && typeof u.id === 'string') { return 'login-user:' + hashId(u.id); } } catch { } return 'login-acct:' + hashId(idn); } });
  const checkLoginIp = fastify.createRateLimit({ max: 60, timeWindow: 60000, keyGenerator: (req: any) => 'login-ip:' + String(req?.ip || 'unknown') });
  const limitLogin = async (req: any, reply: any) => { for (const check of [checkLoginAcct, checkLoginIp]) { const r: any = await check(req); if (r && r.isAllowed === false && r.isExceeded) { reply.header('retry-after', String(r.ttlInSeconds || 60)); return reply.status(429).send({ error: '\u00c7ok fazla deneme yap\u0131ld\u0131. L\u00fctfen daha sonra tekrar deneyin.' }); } } };
  const limitPin = fastify.rateLimit({ max: 5, timeWindow: 60000, keyGenerator: (req: any) => 'pin:' + hashId(uid(req)) });
  const limit2fa = fastify.rateLimit({ max: 5, timeWindow: 60000, keyGenerator: (req: any) => '2fa:' + hashId(uid(req)) });
  const pending = new Map();
  const P_MS = 5 * 60 * 1000, P_MAX = 256;
  const pKey = (u: string, s: string) => u + ':' + s;
  const prune = () => { const n = Date.now(); for (const [k, v] of pending) if (!v || v.expiresAt <= n) pending.delete(k); };
  const getP = (u: string, s: string) => { const v = pending.get(pKey(u, s)); if (!v) return null; if (v.expiresAt <= Date.now()) { pending.delete(pKey(u, s)); return null; } return v; };
  const setP = (u: string, s: string, d: any) => { prune(); const k = pKey(u, s); if (!pending.has(k) && pending.size >= P_MAX) { const o = pending.keys().next().value; if (o) pending.delete(o); } pending.set(k, d); };
  const clearUserP = (u: string) => { for (const k of [...pending.keys()]) if (k.startsWith(u + ':')) pending.delete(k); };
  fastify.addHook('onClose', async () => pending.clear());


  // 1. KULLANICI KAYDI (KAPALI)
  fastify.post('/register', async (_request, reply) => {
    return reply.status(403).send({
      error: 'Herkese açık kayıt kapalıdır. İlk kurulumu sistem kurulumundan, yeni kullanıcıları yönetici aracılığıyla oluşturun.',
    });
  });

  // 2. GİRİŞ (LOGIN) & 2FA KONTROLÜ
  fastify.post('/login', { preHandler: [limitLogin] }, async (request, reply) => {
    const parse = LoginSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ error: 'Gecersiz veri' });
    const { usernameOrEmail, password, twoFactorCode } = parse.data;
    const snapshot = await userRepo.getUserByUsernameOrEmail(usernameOrEmail);
    if (!snapshot || !snapshot.isActive) return reply.status(401).send({ error: 'Kullanıcı adı veya parola hatalı.' });
    const validPw = await verifyPassword(password, snapshot.passwordHash);
    if (!validPw) return reply.status(401).send({ error: 'Kullanıcı adı veya parola hatalı.' });
    let outcome: any;
    try {
      outcome = db.transaction((tx: any) => {
        const fresh = tx.select().from(users).where(eq(users.id, snapshot.id)).get();
        if (!fresh || !fresh.isActive || fresh.passwordHash !== snapshot.passwordHash) return { kind: 'invalid' };
        if (!UserRoleSchema.safeParse(fresh.role).success) return { kind: 'invalid' };
        const pub = { id: fresh.id, username: fresh.username, email: fresh.email, fullName: fresh.fullName, role: fresh.role, hasPin: !!fresh.pinHash, twoFactorEnabled: !!fresh.twoFactorEnabled };
        if (!fresh.twoFactorEnabled) {
          const sess = (fastify as any).sessionRepo.createSessionInTx(tx, fresh.id);
          insertAuditSync(tx, { userId: fresh.id, action: 'LOGIN', entity: 'user', entityId: fresh.id, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
          return { kind: 'session', session: sess, pub }; }
        if (!twoFactorCode) return { kind: 'challenge', pub };
        if (/^\d{6}$/.test(twoFactorCode)) {
          let raw = null; try { raw = fresh.twoFactorSecret ? decryptField(fresh.twoFactorSecret, config.masterKey) : null; } catch { raw = null; }
          if (!raw || !verifyTotp(twoFactorCode, raw)) return { kind: 'invalid2fa' };
          const sess = (fastify as any).sessionRepo.createSessionInTx(tx, fresh.id);
          insertAuditSync(tx, { userId: fresh.id, action: 'LOGIN', entity: 'user', entityId: fresh.id, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
          return { kind: 'session', session: sess, pub }; }
        let consumed = false;
        try { consumed = (fastify as any).userRepo.consumeBackupCodeInTx(tx, fresh.id, hashBackupCode(twoFactorCode)); } catch (e:any) { if (e && e.message === 'INVALID_BACKUP_CODE_STATE') return { kind: 'badstate' }; throw e; }
        if (!consumed) return { kind: 'invalid2fa' };
        const revokedCount = (fastify as any).sessionRepo.revokeAllSessionsInTx(tx, fresh.id);
        const sess = (fastify as any).sessionRepo.createSessionInTx(tx, fresh.id);
        insertAuditSync(tx, { userId: fresh.id, action: 'LOGIN', entity: 'user', entityId: fresh.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], newState: { method: 'recovery_code', revokedCount } });
        return { kind: 'session', session: sess, pub };
      }, { behavior: 'immediate' });
    } catch { return reply.status(500).send({ error: 'Beklenmedik bir hata olustu. Lutfen daha sonra tekrar deneyin.' }); }
    if (!outcome || outcome.kind === 'invalid') return reply.status(401).send({ error: 'Kullanıcı adı veya parola hatalı.' });
    if (outcome.kind === 'challenge') { const tempToken = fastify.jwt.sign({ id: outcome.pub.id, is2FaPending: true }, { expiresIn: '5m' }); return reply.send({ requireTwoFactor: true, tempToken }); }
    if (outcome.kind === 'invalid2fa') return reply.status(401).send({ error: 'Gecersiz veya suresi dolmus 2FA kodu.' });
    if (outcome.kind === 'badstate') return reply.status(500).send({ error: 'Beklenmedik bir hata olustu. Lutfen daha sonra tekrar deneyin.' });
    const token = fastify.jwt.sign({ id: outcome.pub.id, username: outcome.pub.username, role: outcome.pub.role, sid: outcome.session.id, exp: outcome.session.expiresAt });
    return reply.send({ user: outcome.pub, token });
  });
  // 3. 2FA SETUP
  fastify.post('/2fa/setup', { onRequest: [fastify.authenticate], preHandler: [limit2fa] }, async (request, reply) => {
    const authUser = request.user as { id: string; username: string };
    const sid = (request as any).authSession?.id as string;
    if (!sid) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erisim.' });
    const u0: any = await userRepo.getUserById(authUser.id, config.masterKey);
    if (!u0 || !u0.isActive) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erisim.' });
    if (u0.twoFactorEnabled) return reply.status(409).send({ error: 'Iki asamali dogrulama zaten aktif.' });
    const { secret, uri } = generateTotpSecret(authUser.username, 'TZRCoster');
    const backupCodes = generateBackupCodes(8);
    setP(authUser.id, sid, { secret, backupCodes, expiresAt: Date.now() + P_MS });
    return reply.send({ secret, qrCodeUri: uri, backupCodes });
  });
  // 4. 2FA ENABLE
  fastify.post('/2fa/enable', { onRequest: [fastify.authenticate], preHandler: [limit2fa] }, async (request, reply) => {
    const authUser = request.user as { id: string };
    const sid = (request as any).authSession?.id as string;
    const S = z.object({ code: z.string().regex(/^\d{6}$/) }).strip();
    const pr = S.safeParse(request.body);
    if (!pr.success) return reply.status(400).send({ error: 'Gecersiz veri' });
    if (!sid) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erisim.' });
    const u1: any = await userRepo.getUserById(authUser.id, config.masterKey);
    if (!u1 || !u1.isActive) return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz erisim.' });
    if (u1.twoFactorEnabled) return reply.status(409).send({ error: 'Iki asamali dogrulama zaten aktif.' });
    const ent = getP(authUser.id, sid);
    if (!ent) return reply.status(400).send({ error: 'Kurulum bulunamadi veya suresi doldu.' });
    if (!verifyTotp(pr.data.code, ent.secret)) return reply.status(400).send({ error: 'Dogrulama kodu hatali.' });
    const hashed = (ent.backupCodes as string[]).map(hashBackupCode);
    let done = false, gone = false;
    try { db.transaction((tx: any) => {
      const cur = tx.select().from(authSessions).where(eq(authSessions.id, sid)).get();
      const now = Math.floor(Date.now()/1000);
      if (!cur || cur.userId !== authUser.id || cur.revokedAt !== null || !(cur.expiresAt > now)) { gone = true; return; }
      const ok = (fastify as any).userRepo.enableTwoFactorInTx(tx, authUser.id, ent.secret, hashed, config.masterKey);
      if (!ok) { gone = true; return; }
      (fastify as any).sessionRepo.revokeOtherSessionsInTx(tx, authUser.id, sid);
      insertAuditSync(tx, { userId: authUser.id, action: '2FA_ENABLE', entity: 'user', entityId: authUser.id, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
      done = true;
    }, { behavior: 'immediate' }); } catch { return reply.status(500).send({ error: 'Beklenmedik bir hata olustu.' }); }
    if (!done) return reply.status(gone ? 409 : 400).send({ error: 'Iki asamali dogrulama aktiflestirilemedi.' });
    clearUserP(authUser.id);
    return reply.send({ success: true });
  });
  // 5. GİRİŞ YAPMIŞ KULLANICI PROFİLİ
  fastify.get('/me', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const authUser = request.user as { id: string };
    const user = await userRepo.getUserById(authUser.id, config.masterKey);
    if (!user) {
      return reply.status(404).send({ error: 'Kullanıcı bulunamadı.' });
    }

    return reply.send({
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      hasPin: user.hasPin,
      twoFactorEnabled: user.twoFactorEnabled,
    });
  });

  // 6. KULLANICILARI LİSTELE (Kullanıcı Seçimi & Kiosk PIN Değişimi için)
  fastify.get('/users', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const list = (db as CostCoreDatabase).transaction(tx => {
        const session = request.authSession;
        fastify.projectAccess.requireFreshAdmin(tx, (request.user as { id: string }).id, session?.id as string, session?.expiresAt ?? NaN);
        return tx.select(publicUserColumns).from(users).all();
      });
      return reply.send(list);
    } catch (error) { return userManagementError(reply, error); }
  });

  // 7. YENİ KULLANICI OLUŞTUR (Yönetici veya Yetkili Kullanıcı)
  fastify.post('/users', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    try {
      const userDb = db as CostCoreDatabase;
      const userId = (request.user as { id: string }).id;
      // Keep the original authenticated session identity/expiry across hashing.
      const sessionId = request.authSession?.id as string;
      const originalExpiresAt = request.authSession?.expiresAt ?? NaN;
      userDb.transaction(tx => fastify.projectAccess.requireFreshAdmin(tx, userId, sessionId, originalExpiresAt));

      const parse = CreateUserSchema.safeParse(request.body);
      if (!parse.success) return reply.status(400).send({ error: 'Geçersiz veri', details: parse.error.format() });
      const input = parse.data;
      // Scrypt is deliberately outside any SQLite transaction. Authorization
      // is checked again after BOTH awaits, before identifier reads or writes.
      const passwordHash = await hashPassword(input.password);
      const pinHash = input.pin ? await hashPassword(input.pin) : null;

      const created = userDb.transaction(tx => {
        fastify.projectAccess.requireFreshAdmin(tx, userId, sessionId, originalExpiresAt);
        // Login accepts either identifier. Check all four combinations under
        // the immediate write lock without introducing normalization changes.
        const existing = tx.select({ id: users.id }).from(users).where(or(
          eq(users.username, input.username), eq(users.email, input.username),
          eq(users.username, input.email), eq(users.email, input.email),
        )).limit(1).get();
        if (existing) throw new UserIdentifierConflictError();
        const id = randomUUID(), now = new Date().toISOString();
        const row = {
          id, username: input.username, email: input.email, fullName: input.fullName,
          role: input.role, passwordHash, pinHash, isActive: true,
          twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: JSON.stringify([]),
          createdAt: now, updatedAt: now,
        };
        const inserted = tx.insert(users).values(row).run();
        if (inserted.changes !== 1) throw new Error('User insert failed');
        insertAuditSync(tx, {
          userId, action: 'CREATE', entity: 'user', entityId: id,
          ipAddress: request.ip, userAgent: request.headers['user-agent'],
          newState: { username: row.username, role: row.role },
        });
        return {
          id, username: row.username, email: row.email, fullName: row.fullName,
          role: row.role, isActive: row.isActive, hasPin: !!pinHash,
          twoFactorEnabled: row.twoFactorEnabled, createdAt: now, updatedAt: now,
        };
      }, { behavior: 'immediate' });
      return reply.status(201).send(created);
    } catch (error) { return userManagementError(reply, error); }
  });

  // 8. HIZLI KULLANICI DEĞİŞTİR (4-HANELİ PIN İLE)
  fastify.post('/logout', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const authUser = request.user as { id: string }; const sess: any = (request as any).authSession;
    try {
      db.transaction((tx: any) => {
        const ok = (fastify as any).sessionRepo.revokeSessionInTx(tx, sess.id, authUser.id);
        if (!ok) { throw new Error('revoke failed'); }
        insertAuditSync(tx, { userId: authUser.id, action: 'LOGOUT', entity: 'user', entityId: authUser.id, ipAddress: request.ip, userAgent: request.headers['user-agent'] });
      }, { behavior: 'immediate' });
    } catch (err) { return reply.status(500).send({ error: 'Beklenmedik bir hata olustu. Lutfen daha sonra tekrar deneyin.' }); }
    return reply.send({ success: true });
  });

  fastify.post('/logout-all', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const authUser = request.user as { id: string };
    try {
      const count = db.transaction((tx: any) => {
        const n = (fastify as any).sessionRepo.revokeAllSessionsInTx(tx, authUser.id);
        insertAuditSync(tx, { userId: authUser.id, action: 'LOGOUT', entity: 'user', entityId: authUser.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], newState: { scope: 'all', revokedCount: n } });
        return n;
      }, { behavior: 'immediate' });
      return reply.send({ success: true, revokedCount: count });
    } catch (err) { return reply.status(500).send({ error: 'Beklenmedik bir hata olustu. Lutfen daha sonra tekrar deneyin.' }); }
  });

  fastify.post('/users/:id/revoke-sessions', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const authUser = request.user as { id: string; role: string };
    if (authUser.role !== 'admin') { return reply.status(403).send({ error: 'Yetkisiz islem. Yalnizca yoneticiler oturumlari iptal edebilir.' }); }
    const targetId = (request.params as any).id as string;
    let state: any;
    try { state = await userRepo.getAuthStateById(targetId); } catch (err) { return reply.status(500).send({ error: 'Beklenmedik bir hata olustu. Lutfen daha sonra tekrar deneyin.' }); }
    if (!state) { return reply.status(404).send({ error: 'Kullanici bulunamadi.' }); }
    try {
      const count = db.transaction((tx: any) => {
        const n = (fastify as any).sessionRepo.revokeAllSessionsInTx(tx, targetId);
        insertAuditSync(tx, { userId: authUser.id, action: 'LOGOUT', entity: 'user', entityId: targetId, ipAddress: request.ip, userAgent: request.headers['user-agent'], newState: { scope: 'admin-revoke', revokedCount: n } });
        return n;
      }, { behavior: 'immediate' });
      return reply.send({ success: true, revokedCount: count });
    } catch (err) { return reply.status(500).send({ error: 'Beklenmedik bir hata olustu. Lutfen daha sonra tekrar deneyin.' }); }
  });

  fastify.post('/switch-pin', { onRequest: [fastify.authenticate], preHandler: [limitPin] }, async (request, reply) => {
    const parse = SwitchUserPinSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Geçersiz PIN formatı. 4-6 haneli sayı giriniz.' });
    }

    const { userId, pin } = parse.data;
    const currentAuth = request.user as { id: string };

    if (userId && userId !== currentAuth.id) {
      return reply.status(403).send({
        error: 'PIN do\u011frulamas\u0131 yaln\u0131zca mevcut oturumdaki kullan\u0131c\u0131 hesab\u0131 i\u00e7indir. Ba\u015fka bir hesaba ge\u00e7i\u015f i\u00e7in parola ile giri\u015f yap\u0131n.',
      });
    }

    const targetUserId = currentAuth.id;

    const targetUser = await userRepo.verifyUserPin(targetUserId, pin);
    if (!targetUser) {
      return reply.status(401).send({ error: 'Hatalı PIN kodu veya kullanıcıda PIN tanımlı değil.' });
    }
    await auditRepo.logAction(
      {
        userId: targetUser.id,
        action: 'LOGIN',
        entity: 'user',
        entityId: targetUser.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        newState: { switchFrom: currentAuth.id, method: 'PIN' },
      },
      config.masterKey
    );

    const sess = request.authSession;
    const rawAuth = request.headers.authorization;
    const bearerMatch = typeof rawAuth === 'string' ? /^Bearer\s+/i.exec(rawAuth) : null;
    const token = typeof rawAuth === 'string' && bearerMatch ? rawAuth.slice(bearerMatch[0].length) : '';
    if (!sess || !token) {
      return reply.status(401).send({ code: 'SESSION_INVALID', error: 'Yetkisiz eri\u015fim. Ge\u00e7erli bir oturum a\u00e7man\u0131z gerekmektedir.' });
    }

    return reply.send({
      user: targetUser,
      token,
      message: `${targetUser.fullName} kullanıcısına başarıyla geçiş yapıldı.`,
    });
  });

  // 9. MEVCUT KULLANICI İÇİN PIN TANIMLA / DEĞİŞTİR
  fastify.post('/set-pin', { onRequest: [fastify.authenticate], preHandler: [limitPin] }, async (request, reply) => {
    const authUser = request.user as { id: string };
    const parse = SetPinSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.status(400).send({ error: 'Geçersiz PIN formatı. 4-6 haneli sayı giriniz.' });
    }

    const success = await userRepo.setUserPin(authUser.id, parse.data.pin);
    if (!success) {
      return reply.status(400).send({ error: 'PIN kaydedilemedi.' });
    }

    await auditRepo.logAction(
      {
        userId: authUser.id,
        action: 'UPDATE',
        entity: 'user',
        entityId: authUser.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        newState: { pinConfigured: true },
      },
      config.masterKey
    );

    return reply.send({ success: true, message: 'Hızlı PIN kodunuz başarıyla güncellendi.' });
  });
};
