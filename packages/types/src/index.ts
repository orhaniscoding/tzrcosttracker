import { z } from 'zod';
export { z };

// ==========================================
// 1. KULLANICI & YETKİLENDİRME (AUTH & RBAC)
// ==========================================

export const UserRoleSchema = z.enum(['admin', 'manager', 'accountant', 'auditor', 'viewer']);
export type UserRole = z.infer<typeof UserRoleSchema>;

// ==========================================
// 1.1 PROJELER & ŞANTİYELER (PROJECTS)
// ==========================================

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  code: z.string().max(30).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  budget: z.number().default(0),
  currency: z.string().default('TRY'),
  status: z.enum(['active', 'completed', 'archived']).default('active'),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  code: z.string().max(30).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  budget: z.number().optional().default(0),
  currency: z.string().optional().default('TRY'),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

// ==========================================
// 1.2 CARİLER, TAŞERONLAR & KİŞİLER (PARTIES)
// ==========================================

export const PartyTypeSchema = z.enum(['subcontractor', 'supplier', 'partner', 'person', 'client']);
export type PartyType = z.infer<typeof PartyTypeSchema>;

export const PartySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(150),
  type: PartyTypeSchema.default('supplier'),
  phone: z.string().max(30).optional().nullable(),
  email: z.string().email().optional().nullable(),
  iban: z.string().max(34).optional().nullable(),
  taxNo: z.string().max(30).optional().nullable(),
  taxOffice: z.string().max(50).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  isActive: z.boolean().default(true),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Party = z.infer<typeof PartySchema>;

export const CreatePartySchema = z.object({
  name: z.string().min(1).max(150),
  type: PartyTypeSchema.default('supplier'),
  phone: z.string().max(30).optional().nullable(),
  email: z.string().email().optional().nullable(),
  iban: z.string().max(34).optional().nullable(),
  taxNo: z.string().max(30).optional().nullable(),
  taxOffice: z.string().max(50).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});
export type CreatePartyInput = z.infer<typeof CreatePartySchema>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  username: z.string().min(3).max(50),
  email: z.string().email(),
  fullName: z.string().min(2).max(100),
  role: UserRoleSchema,
  isActive: z.boolean().default(true),
  hasPin: z.boolean().default(false).optional(),
  twoFactorEnabled: z.boolean().default(false),
  twoFactorSecret: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const CreateUserSchema = z.object({
  username: z.string().min(3).max(50),
  email: z.string().email(),
  fullName: z.string().min(2).max(100),
  password: z.string().min(8).max(128),
  role: UserRoleSchema.default('viewer'),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN 4-6 haneli sayı olmalıdır').optional(),
});
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export const SetPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, 'PIN 4-6 haneli sayı olmalıdır'),
});
export type SetPinInput = z.infer<typeof SetPinSchema>;

export const SwitchUserPinSchema = z.object({
  userId: z.string().uuid().optional(),
  pin: z.string().regex(/^\d{4,6}$/, 'PIN 4-6 haneli sayı olmalıdır'),
});
export type SwitchUserPinInput = z.infer<typeof SwitchUserPinSchema>;

export const LoginSchema = z.object({
  usernameOrEmail: z.string().min(3),
  password: z.string().min(1),
  twoFactorCode: z.string().max(32).trim().regex(/^(?:\d{6}|[0-9a-fA-F]{8}|[0-9a-fA-F]{4}-[0-9a-fA-F]{4})$/).optional(),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const TwoFactorSetupResponseSchema = z.object({
  secret: z.string(),
  qrCodeUrl: z.string(),
  backupCodes: z.array(z.string()),
});
export type TwoFactorSetupResponse = z.infer<typeof TwoFactorSetupResponseSchema>;

export const TwoFactorVerifySchema = z.object({
  code: z.string().regex(/^\d{6}$/),
});
export type TwoFactorVerifyInput = z.infer<typeof TwoFactorVerifySchema>;

// ==========================================
// 2. DİNAMİK ÖZEL ALANLAR (CUSTOM FIELDS)
// ==========================================

export const CustomFieldTypeSchema = z.enum([
  'text',
  'number',
  'currency',
  'date',
  'select',
  'boolean',
  'file',
]);
export type CustomFieldType = z.infer<typeof CustomFieldTypeSchema>;

export const CustomFieldDefinitionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(50), // Key, e.g. "plaka_no", "sozlesme_no"
  label: z.string().min(1).max(100), // Human readable, e.g. "Araç Plaka No"
  type: CustomFieldTypeSchema,
  options: z.array(z.string()).optional(), // Select türü için seçenekler
  unit: z.string().max(20).optional(), // örn: "m2", "ton", "saat", "adet"
  required: z.boolean().default(false),
  placeholder: z.string().max(100).optional(),
  defaultValue: z.any().optional(),
});
export type CustomFieldDefinition = z.infer<typeof CustomFieldDefinitionSchema>;

// ==========================================
// 3. HİYERARŞİK DİNAMİK KATEGORİ AĞACI
// ==========================================

export const CategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  code: z.string().max(30).optional().nullable(),
  parentId: z.string().uuid().nullable().optional(), // Null ise Ana Kategori
  description: z.string().max(500).optional().nullable(),
  budget: z.number().default(0),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3B82F6'),
  icon: z.string().max(50).default('folder'),
  orderIndex: z.number().int().default(0),
  customFieldIds: z.array(z.string().uuid()).default([]),
  isActive: z.boolean().default(true),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Category = z.infer<typeof CategorySchema>;

export const CreateCategorySchema = z.object({
  name: z.string().min(1).max(100),
  code: z.string().max(30).optional().nullable(),
  parentId: z.string().uuid().nullable().optional(),
  description: z.string().max(500).optional().nullable(),
  budget: z.number().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(50).optional(),
  orderIndex: z.number().int().optional(),
  customFieldIds: z.array(z.string().uuid()).optional(),
});
export type CreateCategoryInput = z.infer<typeof CreateCategorySchema>;

// ==========================================
// 4. KASALAR & BANKA HESAPLARI (ACCOUNTS)
// ==========================================

export const AccountTypeSchema = z.enum(['cash', 'bank', 'pos', 'credit_card', 'other']);
export type AccountType = z.infer<typeof AccountTypeSchema>;

const OpaqueProjectIdSchema = z.string().min(1).max(128).refine((value) => value.trim().length > 0);

export const AccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  type: AccountTypeSchema.default('cash'),
  currency: z.string().min(3).max(3).default('TRY'),
  balance: z.number().default(0),
  creditLimit: z.number().optional().default(0),
  statementClosingDay: z.number().int().min(1).max(31).optional().nullable(),
  paymentDueDay: z.number().int().min(1).max(31).optional().nullable(),
  iban: z.string().max(34).optional().nullable(),
  bankName: z.string().max(100).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  projectId: OpaqueProjectIdSchema.optional().nullable(),
  isActive: z.boolean().default(true),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Account = z.infer<typeof AccountSchema>;

export const CreateAccountSchema = z.object({
  name: z.string().min(1).max(100),
  type: AccountTypeSchema.default('cash'),
  currency: z.string().min(3).max(3).default('TRY'),
  initialBalance: z.number().optional().default(0),
  creditLimit: z.number().optional().default(0),
  statementClosingDay: z.number().int().min(1).max(31).optional().nullable(),
  paymentDueDay: z.number().int().min(1).max(31).optional().nullable(),
  iban: z.string().max(34).optional().nullable(),
  bankName: z.string().max(100).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  projectId: OpaqueProjectIdSchema.optional().nullable(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountSchema>;

export const InternalTransferSchema = z.object({
  date: z.string().datetime().optional(),
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amount: z.number().positive(),
  exchangeRate: z.number().positive().optional().default(1),
  description: z.string().max(500).optional().nullable(),
});
export type InternalTransferInput = z.infer<typeof InternalTransferSchema>;

// ==========================================
// 5. MALİ HAREKETLER (TRANSACTIONS / GİDERLER)
// ==========================================

export const TransactionTypeSchema = z.enum(['expense', 'income', 'transfer']);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

export const TransactionStatusSchema = z.enum([
  'draft',
  'pending_approval',
  'pending',
  'approved',
  'paid',
  'rejected',
  'cancelled',
]);
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>;

export const TransactionPaymentSourceSchema = z.enum(['company_account', 'person_out_of_pocket']);
export type TransactionPaymentSource = z.infer<typeof TransactionPaymentSourceSchema>;

export const TransactionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid().optional().nullable(),
  type: TransactionTypeSchema.default('expense'),
  date: z.string().datetime(),
  amount: z.number().positive(),
  amountInWords: z.string().optional(),
  currency: z.string().min(3).max(3).default('TRY'),
  exchangeRate: z.number().positive().default(1),
  baseAmount: z.number().positive(), // Tutar * Kur
  categoryId: z.string().uuid(),
  subcategoryId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  party: z.string().max(200).optional().nullable(), // Tedarikçi / Cari / Kişi
  accountFromId: z.string().uuid().nullable().optional(),
  accountToId: z.string().uuid().nullable().optional(),
  paymentSource: TransactionPaymentSourceSchema.default('company_account'),
  payerPersonName: z.string().max(100).optional().nullable(), // Kasaya Ekleyen / Cebinden Ödeyen
  paymentMethod: z.string().max(50).default('Banka'), // Nakit, Banka, Kredi Kartı, Çek / Senet
  otoKasaTransactionId: z.string().uuid().optional().nullable(),
  dueDate: z.string().datetime().optional().nullable(),
  isPaid: z.boolean().default(true),
  customValues: z.record(z.string(), z.unknown()).default({}), // Dinamik alan verileri
  attachments: z.array(z.string()).default([]), // Fiş, fatura, makbuz yolları
  status: TransactionStatusSchema.default('approved'),
  deletedAt: z.string().datetime().optional().nullable(),
  createdById: z.string().uuid(),
  approvedById: z.string().uuid().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const CreateTransactionSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  type: TransactionTypeSchema.default('expense'),
  date: z.string().datetime(),
  amount: z.number().positive(),
  currency: z.string().min(3).max(3).default('TRY'),
  exchangeRate: z.number().positive().default(1),
  categoryId: z.string().uuid(),
  subcategoryId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  party: z.string().max(200).optional().nullable(),
  accountFromId: z.string().uuid().nullable().optional(),
  accountToId: z.string().uuid().nullable().optional(),
  paymentSource: TransactionPaymentSourceSchema.optional().default('company_account'),
  payerPersonName: z.string().max(100).optional().nullable(),
  paymentMethod: z.string().max(50).optional().default('Banka'),
  dueDate: z.string().datetime().optional().nullable(),
  isPaid: z.boolean().optional().default(true),
  customValues: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(z.string()).optional(),
  status: TransactionStatusSchema.optional(),
});
export type CreateTransactionInput = z.infer<typeof CreateTransactionSchema>;

// ==========================================
// 6. DEĞİŞTİRİLEMEZ DENETİM İZİ (AUDIT LOG)
// ==========================================

export const AuditActionSchema = z.enum([
  'CREATE',
  'UPDATE',
  'DELETE',
  'RESTORE',
  'PERMANENT_DELETE',
  'LOGIN',
  'LOGOUT',
  '2FA_ENABLE',
  '2FA_DISABLE',
  'EXPORT',
  'SETTINGS_UPDATE',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AuditLogSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid().nullable().optional(),
  action: AuditActionSchema,
  entity: z.string().min(1).max(50), // örn: "transaction", "category", "user"
  entityId: z.string().max(100).nullable().optional(),
  timestamp: z.string().datetime(),
  ipAddress: z.string().max(50).optional().nullable(),
  userAgent: z.string().max(500).optional().nullable(),
  previousState: z.record(z.string(), z.unknown()).nullable().optional(),
  newState: z.record(z.string(), z.unknown()).nullable().optional(),
  hash: z.string().min(64).max(64), // SHA-256 zincir hash'i
  previousHash: z.string().min(64).max(64).nullable().optional(),
});
export type AuditLog = z.infer<typeof AuditLogSchema>;

// ==========================================
// 7. BEYAZ ETİKET & KOZMETİK (WHITE LABEL)
// ==========================================

export const WhiteLabelConfigSchema = z.object({
  companyName: z.string().min(1).max(100).default('TZRCoster Finance'),
  appTitle: z.string().min(1).max(100).default('TZRCoster Maliyet & Finans'),
  logoUrl: z.string().url().nullable().optional(),
  faviconUrl: z.string().url().nullable().optional(),
  backgroundUrl: z.string().url().nullable().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#2563EB'),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#1E40AF'),
  defaultTheme: z.enum(['light', 'dark', 'system']).default('dark'),
  baseCurrency: z.string().min(3).max(3).default('TRY'),
  dateFormat: z.string().default('DD.MM.YYYY'),
  updatedAt: z.string().datetime().optional(),
});
export type WhiteLabelConfig = z.infer<typeof WhiteLabelConfigSchema>;
export { moneyFromMinor, moneyFromMajorNumber, moneyToMinor, moneyToMajorNumber, convertMoneyExact } from "./money.js";
export type { MoneyPolicy, MoneyV1, RationalRate } from "./money.js";
