import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDatabase,
  CategoryRepository,
  CustomFieldRepository,
  TransactionRepository,
  AuditLogRepository,
  UserRepository,
  WhiteLabelRepository,
  ProjectRepository,
  PartyRepository,
  AccountRepository,
  transactions as transactionsTable,
  auditLogs as auditLogsTable,
} from '../src/index.js';
import { eq } from 'drizzle-orm';
import { verifyPassword, decryptField } from '@cost-core/crypto';

describe('@cost-core/database - Schema & Security Repository Tests', () => {
  const MASTER_KEY = 'unit-test-master-encryption-key-32b!';
  const PEPPER = 'unit-test-blind-index-pepper-key!';

  let db: any;
  let categoryRepo: CategoryRepository;
  let customFieldRepo: CustomFieldRepository;
  let transactionRepo: TransactionRepository;
  let auditRepo: AuditLogRepository;
  let userRepo: UserRepository;
  let whiteLabelRepo: WhiteLabelRepository;
  let projectRepo: ProjectRepository;
  let partyRepo: PartyRepository;
  let accountRepo: AccountRepository;

  beforeEach(() => {
    const initialized = initDatabase({ path: ':memory:' });
    db = initialized.db;

    categoryRepo = new CategoryRepository(db);
    customFieldRepo = new CustomFieldRepository(db);
    transactionRepo = new TransactionRepository(db);
    auditRepo = new AuditLogRepository(db);
    userRepo = new UserRepository(db);
    whiteLabelRepo = new WhiteLabelRepository(db);
    projectRepo = new ProjectRepository(db);
    partyRepo = new PartyRepository(db);
    accountRepo = new AccountRepository(db);
  });

  // 1. KATEGORİ HİYERARŞİSİ (AĞAÇ YAPISI)
  it('should create root and child categories and construct a hierarchical tree', async () => {
    const rootCat = await categoryRepo.createCategory({
      name: 'Kaba Yapı',
      color: '#EF4444',
      icon: 'hammer',
    });

    const subCat1 = await categoryRepo.createCategory({
      name: 'Demir İşçiliği',
      parentId: rootCat.id,
      color: '#F59E0B',
    });

    const subCat2 = await categoryRepo.createCategory({
      name: 'Beton Dökümü',
      parentId: rootCat.id,
      color: '#10B981',
    });

    const tree = await categoryRepo.getCategoryTree();
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('Kaba Yapı');
    expect(tree[0].children.length).toBe(2);
    expect(tree[0].children.map((c) => c.name)).toContain('Demir İşçiliği');
    expect(tree[0].children.map((c) => c.name)).toContain('Beton Dökümü');
  });

  // 2. DİNAMİK ÖZEL ALANLAR
  it('should define dynamic custom fields with units and options', async () => {
    const field = await customFieldRepo.createCustomField({
      name: 'metrekup',
      label: 'Hacim (m³)',
      type: 'number',
      unit: 'm³',
      required: true,
    });

    expect(field.id).toBeDefined();
    expect(field.name).toBe('metrekup');
    expect(field.unit).toBe('m³');

    const all = await customFieldRepo.listCustomFields();
    expect(all.length).toBe(1);
  });

  // 3. ŞİFRELİ MALİ HAREKETLER & KÖR İNDEKS ARAMASI
  it('should store encrypted transactions and search via blind index without exposing raw data', async () => {
    const cat = await categoryRepo.createCategory({ name: 'Hizmet Giderleri' });

    const { transaction: tx } = await transactionRepo.createTransaction(
      {
        type: 'expense',
        date: '2026-10-29T10:00:00.000Z',
        amount: 85000,
        currency: 'TRY',
        categoryId: cat.id,
        title: 'Hazır Beton Faturası',
        description: 'Akçansa 50m3 hazır beton sevkiyatı',
        party: 'Akçansa Beton A.Ş.',
        customValues: { irsaliyeNo: 'IRS-9988' },
        createdById: 'user-patron-id',
      },
      MASTER_KEY,
      PEPPER
    );

    expect(tx.amount).toBe(85000);
    expect(tx.title).toBe('Hazır Beton Faturası');
    expect(tx.amountInWords).toBe('Seksen Beş Bin Türk Lirası');

    // Doğrudan veritabanı satırını incele: ASKERİ ŞİFRELİ OLMALI!
    const rawRows = await db.select().from(transactionsTable);
    expect(rawRows.length).toBe(1);
    expect(rawRows[0].amountEncrypted.startsWith('enc:v1:')).toBe(true);
    expect(rawRows[0].amountEncrypted).not.toContain('85000');
    expect(rawRows[0].titleEncrypted.startsWith('enc:v1:')).toBe(true);
    expect(rawRows[0].titleEncrypted).not.toContain('Beton');
    expect(rawRows[0].titleBlindIndex.startsWith('bidx:v1:')).toBe(true);

    // KÖR İNDEKSLE ARAMA (Veritabanında şifreleri çözmeden birebir eşleşme)
    const searchResults = await transactionRepo.listTransactions(
      { searchTitle: 'Hazır Beton Faturası' },
      MASTER_KEY,
      PEPPER
    );
    expect(searchResults.length).toBe(1);
    expect(searchResults[0].amount).toBe(85000);
    expect(searchResults[0].party).toBe('Akçansa Beton A.Ş.');

    // Eşleşmeyen arama boş dönmeli
    const notFound = await transactionRepo.listTransactions(
      { searchTitle: 'Yemek Faturası' },
      MASTER_KEY,
      PEPPER
    );
    expect(notFound.length).toBe(0);
  });

  // 4. DEĞİŞTİRİLEMEZ DENETİM GÜNLÜĞÜ (AUDIT CHAIN INTEGRITY)
  it('should maintain tamper-evident audit hash chain and detect tampering', async () => {
    // 1. Kayıt
    const log1 = await auditRepo.logAction(
      {
        action: 'CREATE',
        entity: 'transaction',
        entityId: 'tx-001',
        previousState: null,
        newState: { amount: 10000 },
      },
      MASTER_KEY
    );

    // 2. Kayıt
    const log2 = await auditRepo.logAction(
      {
        action: 'UPDATE',
        entity: 'transaction',
        entityId: 'tx-001',
        previousState: { amount: 10000 },
        newState: { amount: 12000 },
      },
      MASTER_KEY
    );

    expect(log2.previousHash).toBe(log1.hash);

    // Zincir doğrulamasını yap: Geçerli olmalı
    const verification = await auditRepo.verifyChainIntegrity(MASTER_KEY);
    expect(verification.valid).toBe(true);
    expect(verification.count).toBe(2);

    // KURCALAMA TESTİ: Veritabanında bir satır doğrudan değiştirilirse!
    const auditTable = auditLogsTable;
    await db
      .update(auditTable)
      .set({ action: 'DELETE' }) // action illegal değiştirildi
      .where(eq(auditTable.id, log1.id));

    // Tekrar doğrula: KURCALAMA TESPİT EDİLMELİ!
    const tamperedVerification = await auditRepo.verifyChainIntegrity(MASTER_KEY);
    expect(tamperedVerification.valid).toBe(false);
    expect(tamperedVerification.corruptedAtId).toBe(log1.id);
  });

  // 5. KULLANICI & 2FA YÖNETİMİ
  it('should securely manage users and encrypt 2FA secrets', async () => {
    const user = await userRepo.createUser(
      {
        username: 'santiye_sefi',
        email: 'sefi@proje.com',
        fullName: 'Mehmet Demir',
        password: 'SantiyePassword2026!',
        role: 'accountant',
      },
      MASTER_KEY
    );

    expect(user.username).toBe('santiye_sefi');
    expect(user.role).toBe('accountant');

    // Parola hash'ini doğrula
    const fetched = await userRepo.getUserById(user.id, MASTER_KEY);
    expect(fetched).not.toBeNull();
    const isPasswordValid = await verifyPassword('SantiyePassword2026!', fetched!.passwordHash);
    expect(isPasswordValid).toBe(true);

    // 2FA Aktifleştir
    const totpSecret = 'JBSWY3DPEHPK3PXP';
    await userRepo.enableTwoFactor(user.id, totpSecret, ['HASHED_CODE_1'], MASTER_KEY);

    const userWith2FA = await userRepo.getUserById(user.id, MASTER_KEY);
    expect(userWith2FA?.twoFactorEnabled).toBe(true);
    expect(userWith2FA?.rawTwoFactorSecret).toBe(totpSecret);
  });

  // 6. BEYAZ ETİKET (WHITE LABEL) AYARLARI
  it('should customize company identity and themes', async () => {
    const initial = await whiteLabelRepo.getSettings();
    expect(initial.companyName).toBe('TZRCoster Finance');

    const updated = await whiteLabelRepo.updateSettings({
      companyName: 'Özdemir İnşaat & Mimarlık',
      primaryColor: '#059669',
      defaultTheme: 'light',
    });

    expect(updated.companyName).toBe('Özdemir İnşaat & Mimarlık');
    expect(updated.primaryColor).toBe('#059669');
    expect(updated.defaultTheme).toBe('light');
  });

  // 7. PROJELER VE CARİLER
  it('should manage multiple projects and parties', async () => {
    const proj = await projectRepo.createProject({
      name: 'Merkez Plaza İnşaat Projesi',
      budget: 15000000,
    });
    expect(proj.name).toContain('Plaza');

    const party = await partyRepo.createParty(
      {
        name: 'Yılmaz Sağır',
        type: 'partner',
        phone: '0532 000 0000',
      },
      PEPPER
    );
    expect(party.name).toBe('Yılmaz Sağır');
  });

  // 8. OTO-KASA (ÇİFT TARAFLI MAHSUP MOTORU)
  it('should automatically create corresponding income transaction when paid by person (Oto-Kasa)', async () => {
    const cat = await categoryRepo.createCategory({ name: 'Belediye Harçları' });

    const result = await transactionRepo.createTransaction(
      {
        type: 'expense',
        date: '2026-07-10T12:00:00.000Z',
        amount: 22500,
        currency: 'TRY',
        categoryId: cat.id,
        title: 'Yapı Denetim Belediye Harcı',
        paymentSource: 'person_out_of_pocket',
        payerPersonName: 'Yılmaz Sağır',
        createdById: 'user-001',
      },
      MASTER_KEY,
      PEPPER
    );

    expect(result.transaction.amount).toBe(22500);
    expect(result.transaction.paymentSource).toBe('person_out_of_pocket');
    expect(result.transaction.payerPersonName).toBe('Yılmaz Sağır');
    expect(result.otoKasaTransaction).toBeDefined();

    // Otomatik oluşturulan Kasa alacak kaydı kontrolü
    const otoKasa = result.otoKasaTransaction!;
    expect(otoKasa.type).toBe('income');
    expect(otoKasa.title).toContain('🔗 Oto-Kasa: Yapı Denetim Belediye Harcı');
    expect(otoKasa.party).toBe('Yılmaz Sağır');
    expect(otoKasa.otoKasaTransactionId).toBe(result.transaction.id);
  });

  // 9. MÜKERRER KAYIT RADARI
  it('should detect duplicate transaction attempts on the same day', async () => {
    const cat = await categoryRepo.createCategory({ name: 'Noter Masrafları' });

    await transactionRepo.createTransaction(
      {
        type: 'expense',
        date: '2026-07-09T10:00:00.000Z',
        amount: 9500,
        currency: 'TRY',
        categoryId: cat.id,
        title: 'Kat İrtifakı Noter Masrafı',
        createdById: 'user-001',
      },
      MASTER_KEY,
      PEPPER
    );

    // Aynı gün aynı başlıkta tekrar denenirse
    const duplicateCheck = await transactionRepo.checkDuplicate(
      {
        type: 'expense',
        date: '2026-07-09T14:30:00.000Z',
        amount: 9500,
        currency: 'TRY',
        categoryId: cat.id,
        title: 'Kat İrtifakı Noter Masrafı',
      },
      PEPPER
    );

    expect(duplicateCheck.isDuplicate).toBe(true);
    expect(duplicateCheck.existingTransactionId).toBeDefined();
  });

  // 10. 4'LÜ BİLANÇO BARI & NAKİT PROJEKSİYONU
  it('should compute actual cash in hand, pending debt, overdue debt, and net balance', async () => {
    const cat = await categoryRepo.createCategory({ name: 'Genel Bütçe' });

    // Kasa Girişi: 100.000 TL
    await transactionRepo.createTransaction(
      {
        type: 'income',
        date: '2026-10-01T10:00:00.000Z',
        amount: 100000,
        currency: 'TRY',
        categoryId: cat.id,
        title: 'Sermaye Girişi',
        payerPersonName: 'Yılmaz Sağır',
        createdById: 'user-001',
      },
      MASTER_KEY,
      PEPPER
    );

    // Ödenen Gider: 40.000 TL
    await transactionRepo.createTransaction(
      {
        type: 'expense',
        date: '2026-10-05T10:00:00.000Z',
        amount: 40000,
        currency: 'TRY',
        categoryId: cat.id,
        title: 'Demir Faturası',
        isPaid: true,
        createdById: 'user-001',
      },
      MASTER_KEY,
      PEPPER
    );

    // Gelecek Vadeli Borç (Henüz ödenmemiş): 30.000 TL (Vade: 2030)
    await transactionRepo.createTransaction(
      {
        type: 'expense',
        date: '2026-10-10T10:00:00.000Z',
        amount: 30000,
        currency: 'TRY',
        categoryId: cat.id,
        title: 'Vadeli Çek',
        isPaid: false,
        dueDate: '2030-01-01T00:00:00.000Z',
        createdById: 'user-001',
      },
      MASTER_KEY,
      PEPPER
    );

    const balance = await transactionRepo.getFinancialBalance(undefined, MASTER_KEY, PEPPER);

    expect(balance.totalIncome).toBe(100000);
    expect(balance.totalPaidExpense).toBe(40000);
    expect(balance.actualCashInHand).toBe(60000); // 100.000 - 40.000
    expect(balance.totalPendingExpense).toBe(30000);
    expect(balance.netPositionAfterDue).toBe(30000); // 60.000 - 30.000
    expect(balance.personContributions.length).toBeGreaterThan(0);
    expect(balance.personContributions[0].personName).toBe('Yılmaz Sağır');
  });

  // 11. KAYIT DÜZENLEME, SİLME VE OTO-KASA SENKRONİZASYONU
  it('should update and delete transactions and synchronize linked Oto-Kasa entries', async () => {
    const cat = await categoryRepo.createCategory({ name: 'Demir Alımları' });

    // 1. Şahsın cebinden ödediği Oto-Kasa kaydı aç (20.000 TL)
    const { transaction, otoKasaTransaction } = await transactionRepo.createTransaction(
      {
        type: 'expense',
        date: '2026-10-15T10:00:00.000Z',
        amount: 20000,
        currency: 'TRY',
        categoryId: cat.id,
        title: 'İnce Donatı Demiri',
        paymentSource: 'person_out_of_pocket',
        payerPersonName: 'Yılmaz Sağır',
        isPaid: false, // Başlangıçta vadeli olsun
        createdById: 'user-001',
      },
      MASTER_KEY,
      PEPPER
    );

    expect(transaction.otoKasaTransactionId).toBeDefined();

    // 2. Kaydı Düzenle (Tutar 20.000 -> 25.000 TL yap, başlığı değiştir)
    const updated = await transactionRepo.updateTransaction(
      transaction.id,
      {
        amount: 25000,
        title: 'İnce Donatı Demiri (Revize)',
      },
      MASTER_KEY,
      PEPPER
    );

    expect(updated?.amount).toBe(25000);
    expect(updated?.title).toBe('İnce Donatı Demiri (Revize)');
    expect(updated?.amountInWords).toBe('Yirmi Beş Bin Türk Lirası');

    // Bağlı Oto-Kasa kaydının da senkronize güncellendiğini doğrula!
    const updatedOtoKasa = await transactionRepo.getTransactionById(transaction.otoKasaTransactionId!, MASTER_KEY);
    expect(updatedOtoKasa?.amount).toBe(25000);
    expect(updatedOtoKasa?.title).toContain('🔗 Oto-Kasa: İnce Donatı Demiri (Revize)');

    // 3. Tek tıkla "Ödendi Yap"
    const paidTx = await transactionRepo.markTransactionPaid(transaction.id, MASTER_KEY);
    expect(paidTx?.isPaid).toBe(true);

    // 4. Kaydı Sil ve Bağlı Oto-Kasa kaydının da silindiğini doğrula
    const deleted = await transactionRepo.deleteTransaction(transaction.id, MASTER_KEY);
    expect(deleted).toBe(true);

    const deletedMain = await transactionRepo.getTransactionById(transaction.id, MASTER_KEY);
    const deletedOto = await transactionRepo.getTransactionById(transaction.otoKasaTransactionId!, MASTER_KEY);
    expect(deletedMain).toBeNull();
    expect(deletedOto).toBeNull();

    // 5. Çöp Kutusunu Listele ve Geri Yükle (Restore)
    const trashList = await transactionRepo.listTrash(MASTER_KEY);
    expect(trashList.length).toBeGreaterThan(0);
    const inTrash = trashList.find((t) => t.id === transaction.id);
    expect(inTrash).toBeDefined();

    const restored = await transactionRepo.restoreTransaction(transaction.id, MASTER_KEY);
    expect(restored).not.toBeNull();
    expect(restored?.deletedAt).toBeNull();

    const restoredOto = await transactionRepo.getTransactionById(transaction.otoKasaTransactionId!, MASTER_KEY);
    expect(restoredOto).not.toBeNull();
  });

  // 12. KATEGORİ BÜTÇESİ & GÜNCELLEME
  it('should create and update category with target budget limit', async () => {
    const cat = await categoryRepo.createCategory({
      name: 'Kaba İnşaat',
      budget: 1500000,
      color: '#E11D48',
    });

    expect(cat.budget).toBe(1500000);

    const updated = await categoryRepo.updateCategory(cat.id, {
      budget: 2000000,
      description: 'Genişletilmiş Kaba Yapı Bütçesi',
    });

    expect(updated?.budget).toBe(2000000);
    expect(updated?.description).toBe('Genişletilmiş Kaba Yapı Bütçesi');
  });

  // 13. HESAPLAR / CÜZDANLAR, VİRMAN VE BAKİYE AYARLAMA
  it('should manage multi-currency accounts and internal transfers', async () => {
    // 1. Banka hesabı aç
    const bank = await accountRepo.createAccount(
      {
        name: 'Şirket Ana Banka Hesabı',
        type: 'bank',
        currency: 'TRY',
        initialBalance: 500000,
        iban: 'TR1234567890',
      },
      MASTER_KEY,
      PEPPER
    );
    expect(bank.balance).toBe(500000);
    expect(bank.iban).toBe('TR1234567890');

    // 2. Kasa hesabı aç
    const cash = await accountRepo.createAccount(
      {
        name: 'Ofis Nakit Kasası',
        type: 'cash',
        currency: 'TRY',
        initialBalance: 50000,
      },
      MASTER_KEY,
      PEPPER
    );
    expect(cash.balance).toBe(50000);

    // 3. Virman yap (Bankadan Kasaya 20.000 TL aktar)
    const transfer = await accountRepo.executeInternalTransfer(
      {
        fromAccountId: bank.id,
        toAccountId: cash.id,
        amount: 20000,
      },
      MASTER_KEY
    );

    expect(transfer.fromAccount.balance).toBe(480000);
    expect(transfer.toAccount.balance).toBe(70000);
  });
});
