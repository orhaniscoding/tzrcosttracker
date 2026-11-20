import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { getTotpCode } from '@cost-core/crypto';

describe('@cost-core/server - Full API & Security Integration Tests', () => {
  let app: FastifyInstance;
  let authToken: string;
  let adminUserId: string;

  beforeAll(async () => {
    app = await buildApp({
      config: {
        jwtSecret: 'test-jwt-secret-very-long-and-secure-1234',
        masterKey: 'test-master-key-32-bytes-long-1234',
        blindIndexPepper: 'test-pepper-for-blind-index-1234',
      },
      dbPath: ':memory:',
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. HEALTH CHECK
  it('GET /health should return 200 OK', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
  });

  // 2. SYNTHETIC INITIAL ADMIN (via repository) + LOGIN
  it('should create synthetic initial admin via repository and login', async () => {
    const created = await app.userRepo.createUser({ username: 'sirket_yonetici', email: 'yonetici@sirket.com', fullName: 'Synthetic Admin', password: '***REMOVED***', role: 'admin' }, 'test-master-key-32-bytes-long-1234');
    expect(created.username).toBe('sirket_yonetici');
    adminUserId = created.id;
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { usernameOrEmail: 'sirket_yonetici', password: '***REMOVED***' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.username).toBe('sirket_yonetici');
    expect(body.token).toBeDefined();
    authToken = body.token;
  });

  // 3. GİRİŞ (LOGIN)
  it('POST /api/auth/login should authenticate user with correct credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        usernameOrEmail: 'sirket_yonetici',
        password: '***REMOVED***',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.username).toBe('sirket_yonetici');
    expect(body.token).toBeDefined();
  });

  // 4. 2FA KURULUM VE AKTİFLEŞTİRME
  let userTotpSecret: string;
  it('POST /api/auth/2fa/setup should generate TOTP secret and backup codes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/setup',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.secret).toBeDefined();
    expect(body.qrCodeUri).toContain('otpauth://totp');
    expect(body.backupCodes.length).toBe(8);

    userTotpSecret = body.secret;

    // Kodu üretip aktifleştir
    const currentCode = getTotpCode(userTotpSecret);
    const enableRes = await app.inject({
      method: 'POST',
      url: '/api/auth/2fa/enable',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        secret: userTotpSecret,
        code: currentCode,
        backupCodes: body.backupCodes,
      },
    });

    expect(enableRes.statusCode).toBe(200);
  });

  // 5. 2FA İLE GİRİŞ DENETİMİ
  it('POST /api/auth/login should require 2FA code once enabled and succeed with valid code', async () => {
    // Kotsuz giriş denemesi: 2FA istenmeli
    const step1 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        usernameOrEmail: 'sirket_yonetici',
        password: '***REMOVED***',
      },
    });

    expect(step1.statusCode).toBe(200);
    const step1Body = JSON.parse(step1.body);
    expect(step1Body.requireTwoFactor).toBe(true);

    // Geçerli TOTP kodu ile giriş denemesi
    const currentCode = getTotpCode(userTotpSecret);
    const step2 = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        usernameOrEmail: 'sirket_yonetici',
        password: '***REMOVED***',
        twoFactorCode: currentCode,
      },
    });

    expect(step2.statusCode).toBe(200);
    const step2Body = JSON.parse(step2.body);
    expect(step2Body.token).toBeDefined();
    expect(step2Body.user.twoFactorEnabled).toBe(true);
  });

  // 6. HİYERARŞİK KATEGORİ OLUŞTURMA & AĞAÇ SORGUSU
  let rootCategoryId: string;
  let subCategoryId: string;
  it('POST /api/categories & GET /api/categories?tree=true should manage category hierarchy', async () => {
    // Ana Kategori
    const rootRes = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        name: 'Mekanik & Tesisat',
        color: '#3B82F6',
        icon: 'wrench',
      },
    });
    expect(rootRes.statusCode).toBe(201);
    rootCategoryId = JSON.parse(rootRes.body).id;

    // Alt Kategori
    const subRes = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        name: 'Klima & Havalandırma',
        parentId: rootCategoryId,
        color: '#10B981',
      },
    });
    expect(subRes.statusCode).toBe(201);
    subCategoryId = JSON.parse(subRes.body).id;

    // Ağaç Sorgusu
    const treeRes = await app.inject({
      method: 'GET',
      url: '/api/categories?tree=true',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(treeRes.statusCode).toBe(200);
    const tree = JSON.parse(treeRes.body);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('Mekanik & Tesisat');
    expect(tree[0].children[0].name).toBe('Klima & Havalandırma');
  });

  // 7. DİNAMİK ÖZEL ALAN TANIMI
  it('POST /api/custom-fields should register dynamic custom fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/custom-fields',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        name: 'sozlesme_no',
        label: 'Taşeron Sözleşme No',
        type: 'text',
        required: true,
        placeholder: 'SZ-2026-XYZ',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('sozlesme_no');
  });

  // 8. ŞİFRELİ MALİ HAREKET GİRİŞİ VE KÖR İNDEKS ARAMASI
  it('POST /api/transactions should create encrypted record and search via blind index', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        type: 'expense',
        date: '2026-10-29T12:00:00.000Z',
        amount: 250000,
        currency: 'TRY',
        categoryId: rootCategoryId,
        subcategoryId: subCategoryId,
        title: 'VRF Klima Santrali Alımı',
        description: 'Daikin VRF Dış Ünite 10HP',
        party: 'Daikin Türkiye A.Ş.',
        customValues: {
          sozlesme_no: 'SZ-2026-990',
        },
      },
    });

    expect(createRes.statusCode).toBe(201);
    const { transaction: createdTx } = JSON.parse(createRes.body);
    expect(createdTx.amount).toBe(250000);
    expect(createdTx.customValues.sozlesme_no).toBe('SZ-2026-990');

    // Kör indeksle arama (searchTitle)
    const searchRes = await app.inject({
      method: 'GET',
      url: '/api/transactions?searchTitle=VRF Klima Santrali Alımı',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(searchRes.statusCode).toBe(200);
    const searchList = JSON.parse(searchRes.body);
    expect(searchList.length).toBe(1);
    expect(searchList[0].amount).toBe(250000);
    expect(searchList[0].party).toBe('Daikin Türkiye A.Ş.');
  });

  // 9. MALİ RAPOR VE ÖZET
  it('GET /api/reports/summary should compute aggregated totals', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/summary',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.totalExpense).toBe(250000);
    expect(body.transactionCount).toBe(1);
    expect(body.categoryBreakdown.length).toBe(1);
    expect(body.categoryBreakdown[0].amount).toBe(250000);
  });

  // 10. EXCEL / CSV RAPOR İNDİRME
  it('GET /api/reports/export/csv should export formatted CSV for Excel', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/export/csv',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body).toContain('Tarih;Başlık / Kalem;Tutar;Para Birimi;Kategori;Tedarikçi / Cari;Açıklama');
    expect(res.body).toContain('VRF Klima Santrali Alımı');
    expect(res.body).toContain('250000');
  });

  // 10. DENETİM GÜNLÜĞÜ KRİPTOGRAFİK ZİNCİR DOĞRULAMASI
  it('GET /api/audit/verify should confirm 100% cryptographic audit chain integrity', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/verify',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.verified).toBe(true);
    expect(body.totalRecordsVerified).toBeGreaterThan(0);
    expect(body.corruptedAtId).toBeNull();
  });

  // 11. BEYAZ ETİKET (WHITE LABEL) AYARLARI
  it('GET and PUT /api/settings/white-label should customize company branding', async () => {
    const updateRes = await app.inject({
      method: 'PUT',
      url: '/api/settings/white-label',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        companyName: 'Büyük İskele İnşaat A.Ş.',
        appTitle: 'Merkezi Bütçe & Maliyet Portali',
        primaryColor: '#8B5CF6',
        defaultTheme: 'dark',
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body);
    expect(updated.companyName).toBe('Büyük İskele İnşaat A.Ş.');
    expect(updated.primaryColor).toBe('#8B5CF6');

    // Herkesin erişebildiği GET kontrolü (Kimlik doğrulamasız da okunabilir olmalı)
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/settings/white-label',
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).companyName).toBe('Büyük İskele İnşaat A.Ş.');
  });

  // 12. PROJE YÖNETİMİ
  it('POST & GET /api/projects should manage projects', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        name: 'Merkez Plaza İnşaat Projesi',
        budget: 25000000,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toContain('Plaza');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body).length).toBeGreaterThan(0);
  });

  // 13. OTO-KASA (ÇİFT TARAFLI MAHSUP API)
  it('POST /api/transactions with person_out_of_pocket should create both expense and oto-kasa income', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        type: 'expense',
        date: '2026-07-10T10:00:00.000Z',
        amount: 15000,
        currency: 'TRY',
        categoryId: rootCategoryId,
        title: 'Aplikasyon Harcı',
        paymentSource: 'person_out_of_pocket',
        payerPersonName: 'Yılmaz Sağır',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.transaction.amount).toBe(15000);
    expect(body.transaction.amountInWords).toBe('On Beş Bin Türk Lirası');
    expect(body.otoKasaTransaction).toBeDefined();
    expect(body.otoKasaTransaction.title).toContain('🔗 Oto-Kasa');
    expect(body.otoKasaTransaction.party).toBe('Yılmaz Sağır');
  });

  // 14. MÜKERRER KAYIT RADARI
  it('POST /api/transactions/check-duplicate should report existing duplicates', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/transactions/check-duplicate',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        date: '2026-07-10T15:00:00.000Z',
        title: 'Aplikasyon Harcı',
        amount: 15000,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.isDuplicate).toBe(true);
  });

  // 15. 4'LÜ BİLANÇO BARI & PROJEKSİYON API'Sİ
  it('GET /api/reports/balance should return real cash, pending debt, overdue debt, and net balance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/reports/balance',
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.totalIncome).toBeDefined();
    expect(body.totalPaidExpense).toBeDefined();
    expect(body.actualCashInHand).toBeDefined();
    expect(body.personContributions.length).toBeGreaterThan(0);
  });

  // 16. KAYIT DÜZENLEME, "ÖDENDİ YAP" VE SİLME API'LERİ
  it('PUT, POST /mark-paid, and DELETE /api/transactions/:id should update and delete records', async () => {
    // 1. Kayıt oluştur (Vadeli)
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        type: 'expense',
        date: '2026-10-20T10:00:00.000Z',
        amount: 50000,
        currency: 'TRY',
        categoryId: rootCategoryId,
        title: 'Asansör Avansı',
        isPaid: false,
      },
    });

    expect(createRes.statusCode).toBe(201);
    const txId = JSON.parse(createRes.body).transaction.id;

    // 2. PUT ile düzenle (Tutar 50.000 -> 60.000 TL)
    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/transactions/${txId}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        amount: 60000,
        title: 'Asansör 1. Avansı (Revize)',
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body);
    expect(updated.amount).toBe(60000);
    expect(updated.title).toBe('Asansör 1. Avansı (Revize)');
    expect(updated.amountInWords).toBe('Altmış Bin Türk Lirası');

    // 3. POST /mark-paid ile ödendi yap
    const paidRes = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txId}/mark-paid`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(paidRes.statusCode).toBe(200);
    expect(JSON.parse(paidRes.body).isPaid).toBe(true);

    // 4. DELETE ile sil
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/transactions/${txId}`,
      headers: { authorization: `Bearer ${authToken}` },
    });

    expect(deleteRes.statusCode).toBe(200);
    expect(JSON.parse(deleteRes.body).success).toBe(true);

    // Tekrar getirince 404 dönmeli
    const getDeleted = await app.inject({
      method: 'GET',
      url: `/api/transactions/${txId}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(getDeleted.statusCode).toBe(404);
  });

  // 17. ÇOKLU KULLANICI LİSTELEME, PIN TANIMLAMA VE HIZLI PIN İLE GEÇİŞ
  it('GET /api/auth/users, POST /set-pin, and POST /switch-pin should allow quick PIN switching', async () => {
    // 1. Mevcut kullanıcıya PIN tanımla (Örn: 1234)
    const setPinRes = await app.inject({
      method: 'POST',
      url: '/api/auth/set-pin',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { pin: '1234' },
    });
    expect(setPinRes.statusCode).toBe(200);

    // 2. Kullanıcıları listele
    const usersRes = await app.inject({
      method: 'GET',
      url: '/api/auth/users',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(usersRes.statusCode).toBe(200);
    const users = JSON.parse(usersRes.body);
    expect(Array.isArray(users)).toBe(true);
    const currentUser = users.find((u: any) => u.hasPin === true);
    expect(currentUser).toBeDefined();

    // 3. Yanlış PIN ile geçiş denemesi -> 401 dönmeli
    const failRes = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-pin',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { userId: currentUser.id, pin: '9999' },
    });
    expect(failRes.statusCode).toBe(401);

    // 4. Doğru PIN (1234) ile geçiş -> 200 ve yeni token dönmeli
    const switchRes = await app.inject({
      method: 'POST',
      url: '/api/auth/switch-pin',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { userId: currentUser.id, pin: '1234' },
    });
    expect(switchRes.statusCode).toBe(200);
    const switchBody = JSON.parse(switchRes.body);
    expect(switchBody.token).toBeDefined();
    expect(switchBody.user.id).toBe(currentUser.id);
  });

  // 19. ÇÖP KUTUSU & GERİ YÜKLEME VE KATEGORİ BÜTÇE LİMİTİ API'LERİ
  it('GET /api/transactions/trash, POST /:id/restore, and PUT /api/categories/:id should manage trash and budget', async () => {
    // 1. Yeni harcama oluştur
    const createTx = await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        type: 'expense',
        date: '2026-10-25T10:00:00.000Z',
        amount: 35000,
        currency: 'TRY',
        categoryId: rootCategoryId,
        title: 'Geçici İskele Kurulumu',
        isPaid: true,
      },
    });
    expect(createTx.statusCode).toBe(201);
    const txId = JSON.parse(createTx.body).transaction.id;

    // 2. Çöp Kutusuna Sil (Soft Delete)
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/transactions/${txId}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(delRes.statusCode).toBe(200);

    // 3. Çöp Kutusunda Listele
    const trashRes = await app.inject({
      method: 'GET',
      url: '/api/transactions/trash',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(trashRes.statusCode).toBe(200);
    const trashItems = JSON.parse(trashRes.body);
    expect(trashItems.some((t: any) => t.id === txId)).toBe(true);

    // 4. Çöp Kutusundan Geri Yükle (Restore)
    const restoreRes = await app.inject({
      method: 'POST',
      url: `/api/transactions/${txId}/restore`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(restoreRes.statusCode).toBe(200);
    expect(JSON.parse(restoreRes.body).deletedAt).toBeNull();

    // 5. Kategori Bütçesi Güncelle
    const putCatRes = await app.inject({
      method: 'PUT',
      url: `/api/categories/${rootCategoryId}`,
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        budget: 750000,
      },
    });
    expect(putCatRes.statusCode).toBe(200);
    expect(JSON.parse(putCatRes.body).budget).toBe(750000);
  });

  // 20. SİSTEM KURULUM DURUMU & SEKTÖR ŞABLONLARI
  it('GET /api/system/status and /templates should report readiness', async () => {
    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/system/status',
    });
    expect(statusRes.statusCode).toBe(200);
    const status = JSON.parse(statusRes.body);
    expect(status.hasUsers).toBe(true);

    const tmplRes = await app.inject({
      method: 'GET',
      url: '/api/system/templates',
    });
    expect(tmplRes.statusCode).toBe(200);
    const templates = JSON.parse(tmplRes.body);
    expect(templates.length).toBeGreaterThan(3);
    expect(templates.some((t: any) => t.id === 'construction')).toBe(true);
  });

  // 21. ASKERİ DÜZEYDE ŞİFRELİ SİSTEM YEDEĞİ (.tzrvault) ALMA VE GERİ YÜKLEME
  it('uses the supported V2 backup endpoint and retires live legacy operations', async () => {
    const headers = { authorization: `Bearer ${authToken}` };
    const payload = { backupPassword: 'secure-test-backup-password' };
    const result = await app.inject({ method: 'POST', url: '/api/backup/export-v2', headers, payload });
    expect(result.statusCode).toBe(200);
    expect(result.json().vaultData).toMatch(/^TZRVAULT:v2:/);
    for (const operation of ['export', 'import']) {
      const legacy = await app.inject({ method: 'POST', url: '/api/backup/' + operation, headers, payload });
      expect(legacy.statusCode).toBe(410);
      expect(legacy.json().code).toBe('BACKUP_V1_RETIRED');
    }
  });
  // 22. ÇOKLU CÜZDAN, LİKİDİTE HUB'I, VİRMAN VE BAKİYE MUTABAKATI
  it('POST /api/accounts, /transfer, and /liquidity/summary should manage multi-currency wallets and internal transfers', async () => {
    // 1. Kasa Hesabı Oluştur (100.000 TL)
    const cashRes = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        name: 'Şantiye Merkez Kasası',
        type: 'cash',
        currency: 'TRY',
        initialBalance: 100000,
      },
    });
    expect(cashRes.statusCode).toBe(201);
    const cashAcc = JSON.parse(cashRes.body);
    expect(cashAcc.balance).toBe(100000);

    // 2. Banka Hesabı Oluştur (250.000 TL)
    const bankRes = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        name: 'Garanti Ticari Şirket Hesabı',
        type: 'bank',
        currency: 'TRY',
        initialBalance: 250000,
        bankName: 'Garanti BBVA',
        iban: 'TR120006200000000000000001',
      },
    });
    expect(bankRes.statusCode).toBe(201);
    const bankAcc = JSON.parse(bankRes.body);
    expect(bankAcc.balance).toBe(250000);

    // 3. Kredi Kartı Oluştur (50.000 TL Limit, Kesim Günü 15, Son Ödeme 25)
    const ccRes = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        name: 'Şirket İş Bankası Kredi Kartı',
        type: 'credit_card',
        currency: 'TRY',
        creditLimit: 50000,
        statementClosingDay: 15,
        paymentDueDay: 25,
      },
    });
    expect(ccRes.statusCode).toBe(201);
    const ccAcc = JSON.parse(ccRes.body);
    expect(ccAcc.creditLimit).toBe(50000);

    // 4. Virman / İç Transfer Gerçekleştir (Bankadan Kasaya 30.000 TL aktar)
    const transferRes = await app.inject({
      method: 'POST',
      url: '/api/accounts/transfer',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        fromAccountId: bankAcc.id,
        toAccountId: cashAcc.id,
        amount: 30000,
        description: 'Kasaya nakit avans virmanı',
      },
    });
    expect(transferRes.statusCode).toBe(200);
    const transferBody = JSON.parse(transferRes.body);
    expect(transferBody.fromAccount.balance).toBe(220000);
    expect(transferBody.toAccount.balance).toBe(130000);

    // 5. Likidite Özetini Doğrula (220.000 + 130.000 = 350.000 TL reel nakit)
    const liqRes = await app.inject({
      method: 'GET',
      url: '/api/accounts/liquidity/summary',
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(liqRes.statusCode).toBe(200);
    const liqBody = JSON.parse(liqRes.body);
    expect(liqBody.totalLiquidAssets).toBe(350000);
    expect(liqBody.totalCashBase).toBe(130000);
    expect(liqBody.totalBankBase).toBe(220000);

    // 6. Kasadan Harcama Yapıldığında Cüzdan Bakiyesinin Otomatik Düşmesi
    const expRes = await app.inject({
      method: 'POST',
      url: '/api/transactions',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        type: 'expense',
        date: '2026-10-31T10:00:00.000Z',
        amount: 20000,
        currency: 'TRY',
        categoryId: rootCategoryId,
        title: 'Akaryakıt Alımı',
        accountFromId: cashAcc.id,
        isPaid: true,
      },
    });
    expect(expRes.statusCode).toBe(201);

    // Kasa bakiyesi 130.000 - 20.000 = 110.000 TL olmalı!
    const getCashUpdated = await app.inject({
      method: 'GET',
      url: `/api/accounts/${cashAcc.id}`,
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(getCashUpdated.statusCode).toBe(200);
    expect(JSON.parse(getCashUpdated.body).balance).toBe(110000);
  });
});
