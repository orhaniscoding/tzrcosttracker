import { sqliteTable, text, integer, real, index, primaryKey } from 'drizzle-orm/sqlite-core';

// ==========================================
// 1. KULLANICILAR & 2FA TABLOSU (USERS)
// ==========================================
export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // UUID
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'manager', 'accountant', 'auditor', 'viewer'] })
    .notNull()
    .default('viewer'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  twoFactorEnabled: integer('two_factor_enabled', { mode: 'boolean' }).notNull().default(false),
  twoFactorSecret: text('two_factor_secret'), // AES-256 şifreli
  twoFactorBackupCodes: text('two_factor_backup_codes'), // JSON array (hashed)
  pinHash: text('pin_hash'), // Scrypt PIN hash
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ==========================================
// 1.1 PROJELER & ŞANTİYELER (PROJECTS)
// ==========================================
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code'),
  description: text('description'),
  budget: real('budget').notNull().default(0),
  currency: text('currency').notNull().default('TRY'),
  status: text('status', { enum: ['active', 'completed', 'archived'] }).notNull().default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ==========================================
// 1.2 PROJE UYELIKLERI (PROJECT MEMBERSHIPS)
// ==========================================
export const projectMemberships = sqliteTable('project_memberships', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.projectId] }),
  index('idx_project_memberships_project').on(table.projectId, table.userId),
]);

// ==========================================
// 1.2 CARİLER, TAŞERONLAR & KİŞİLER (PARTIES)
// ==========================================
export const parties = sqliteTable('parties', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nameBlindIndex: text('name_blind_index').notNull(),
  type: text('type', { enum: ['subcontractor', 'supplier', 'partner', 'person', 'client'] })
    .notNull()
    .default('supplier'),
  phone: text('phone'),
  email: text('email'),
  iban: text('iban'),
  taxNo: text('tax_no'),
  taxOffice: text('tax_office'),
  notes: text('notes'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ==========================================
// 2. KASALAR & BANKALAR (ACCOUNTS)
// ==========================================
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nameBlindIndex: text('name_blind_index').notNull(),
  type: text('type', { enum: ['cash', 'bank', 'pos', 'credit_card', 'other'] })
    .notNull()
    .default('cash'),
  currency: text('currency').notNull().default('TRY'),
  balanceEncrypted: text('balance_encrypted').notNull(), // AES-256 şifreli
  creditLimitEncrypted: text('credit_limit_encrypted'), // Kredi kartı limiti şifreli
  statementClosingDay: integer('statement_closing_day'), // Hesap kesim günü (1-31)
  paymentDueDay: integer('payment_due_day'), // Son ödeme günü (1-31)
  ibanEncrypted: text('iban_encrypted'), // AES-256 şifreli
  bankName: text('bank_name'),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'restrict' }),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [index('idx_accounts_project').on(table.projectId)]);

// ==========================================
// 3. HİYERARŞİK DİNAMİK KATEGORİLER
// ==========================================
export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code'),
  parentId: text('parent_id'), // Sınırsız derinlik: null = Ana Başlık
  description: text('description'),
  budget: real('budget').notNull().default(0),
  color: text('color').notNull().default('#3B82F6'),
  icon: text('icon').notNull().default('folder'),
  orderIndex: integer('order_index').notNull().default(0),
  customFieldIds: text('custom_field_ids').notNull().default('[]'), // JSON array of UUIDs
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ==========================================
// 4. DİNAMİK ÖZEL ALAN TANIMLARI (CUSTOM FIELDS)
// ==========================================
export const customFields = sqliteTable('custom_fields', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(), // örn: "plaka_no"
  label: text('label').notNull(), // örn: "Plaka No"
  type: text('type', { enum: ['text', 'number', 'currency', 'date', 'select', 'boolean', 'file'] })
    .notNull(),
  optionsJson: text('options_json'), // Select tipi için JSON listesi
  unit: text('unit'), // örn: "m2", "ton", "saat"
  required: integer('required', { mode: 'boolean' }).notNull().default(false),
  placeholder: text('placeholder'),
  defaultValue: text('default_value'),
  createdAt: text('created_at').notNull(),
});

// ==========================================
// 5. ŞİFRELİ MALİ HAREKETLER (TRANSACTIONS)
// ==========================================
export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),
  projectId: text('project_id'), // Proje / Şantiye ilişkisi
  type: text('type', { enum: ['expense', 'income', 'transfer'] })
    .notNull()
    .default('expense'),
  date: text('date').notNull(), // ISO
  amountEncrypted: text('amount_encrypted').notNull(), // AES-256 şifreli tutar
  currency: text('currency').notNull().default('TRY'),
  exchangeRate: real('exchange_rate').notNull().default(1.0),
  baseAmountEncrypted: text('base_amount_encrypted').notNull(), // Tutar * Kur şifreli
  categoryId: text('category_id').notNull(),
  subcategoryId: text('subcategory_id'),
  titleEncrypted: text('title_encrypted').notNull(),
  titleBlindIndex: text('title_blind_index').notNull(), // Güvenli arama
  descriptionEncrypted: text('description_encrypted'),
  partyEncrypted: text('party_encrypted'), // Tedarikçi / Cari
  partyBlindIndex: text('party_blind_index'), // Tedarikçi kör arama
  accountFromId: text('account_from_id'),
  accountToId: text('account_to_id'),
  paymentSource: text('payment_source', { enum: ['company_account', 'person_out_of_pocket'] })
    .notNull()
    .default('company_account'),
  payerPersonName: text('payer_person_name'), // Kasaya Ekleyen / Cebinden Ödeyen Kişi
  paymentMethod: text('payment_method').notNull().default('Banka'), // Nakit, Banka, Kredi Kartı, Çek / Senet
  otoKasaTransactionId: text('oto_kasa_transaction_id'), // Çift taraflı mahsup ilişkisi
  dueDate: text('due_date'), // Vade tarihi
  isPaid: integer('is_paid', { mode: 'boolean' }).notNull().default(true), // Ödendi mi / Bekliyor (Vadeli) mi?
  customValuesEncrypted: text('custom_values_encrypted').notNull().default(''), // Dinamik alan JSON şifreli
  attachmentsJson: text('attachments_json').notNull().default('[]'),
  status: text('status', { enum: ['draft', 'pending_approval', 'pending', 'approved', 'rejected', 'paid', 'cancelled'] })
    .notNull()
    .default('approved'),
  deletedAt: text('deleted_at'), // Çöp kutusu (Soft-delete)
  createdById: text('created_by_id').notNull(),
  approvedById: text('approved_by_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ==========================================
// 6. DEĞİŞTİRİLEMEZ DENETİM İZİ (AUDIT LOGS)
// ==========================================
export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  timestamp: text('timestamp').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  diffEncrypted: text('diff_encrypted'), // Eski ve yeni durum farkı (AES-256)
  hash: text('hash').notNull(), // SHA-256 zincir hash'i
  previousHash: text('previous_hash'), // Önceki satırın hash'i
});

// ==========================================
// 7. BEYAZ ETİKET & KOZMETİK AYARLAR
// ==========================================
export const whiteLabelSettings = sqliteTable('white_label_settings', {
  id: text('id').primaryKey().default('global'),
  companyName: text('company_name').notNull().default('TZRCoster Finance'),
  appTitle: text('app_title').notNull().default('TZRCoster Maliyet & Finans'),
  logoUrl: text('logo_url'),
  faviconUrl: text('favicon_url'),
  backgroundUrl: text('background_url'),
  primaryColor: text('primary_color').notNull().default('#2563EB'),
  secondaryColor: text('secondary_color').notNull().default('#1E40AF'),
  defaultTheme: text('default_theme', { enum: ['light', 'dark', 'system'] })
    .notNull()
    .default('dark'),
  baseCurrency: text('base_currency').notNull().default('TRY'),
  dateFormat: text('date_format').notNull().default('DD.MM.YYYY'),
  updatedAt: text('updated_at').notNull(),
});


export const authSessions = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  revokedAt: integer('revoked_at'),
}, (table) => [index('idx_auth_sessions_user_expires').on(table.userId, table.expiresAt)]);
