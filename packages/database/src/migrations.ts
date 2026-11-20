import { createHash } from "node:crypto";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";

export interface SchemaMigration { version: number; name: string; checksum: string; }
interface LegacyColumn { table: string; column: string; alterSql: string; }

const BASE_DDL: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', is_active INTEGER NOT NULL DEFAULT 1, two_factor_enabled INTEGER NOT NULL DEFAULT 0, two_factor_secret TEXT, two_factor_backup_codes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, description TEXT, budget REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'TRY', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS parties (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_blind_index TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'supplier', phone TEXT, email TEXT, iban TEXT, tax_no TEXT, tax_office TEXT, notes TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_blind_index TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'cash', currency TEXT NOT NULL DEFAULT 'TRY', balance_encrypted TEXT NOT NULL, iban_encrypted TEXT, bank_name TEXT, description TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, parent_id TEXT, description TEXT, color TEXT NOT NULL DEFAULT '#3B82F6', icon TEXT NOT NULL DEFAULT 'folder', order_index INTEGER NOT NULL DEFAULT 0, custom_field_ids TEXT NOT NULL DEFAULT '[]', is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS custom_fields (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, label TEXT NOT NULL, type TEXT NOT NULL, options_json TEXT, unit TEXT, required INTEGER NOT NULL DEFAULT 0, placeholder TEXT, default_value TEXT, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, project_id TEXT, type TEXT NOT NULL DEFAULT 'expense', date TEXT NOT NULL, amount_encrypted TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'TRY', exchange_rate REAL NOT NULL DEFAULT 1.0, base_amount_encrypted TEXT NOT NULL, category_id TEXT NOT NULL, subcategory_id TEXT, title_encrypted TEXT NOT NULL, title_blind_index TEXT NOT NULL, description_encrypted TEXT, party_encrypted TEXT, party_blind_index TEXT, account_from_id TEXT, account_to_id TEXT, payment_source TEXT NOT NULL DEFAULT 'company_account', payer_person_name TEXT, payment_method TEXT NOT NULL DEFAULT 'Banka', oto_kasa_transaction_id TEXT, due_date TEXT, is_paid INTEGER NOT NULL DEFAULT 1, custom_values_encrypted TEXT NOT NULL DEFAULT '', attachments_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'approved', created_by_id TEXT NOT NULL, approved_by_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, timestamp TEXT NOT NULL, ip_address TEXT, user_agent TEXT, diff_encrypted TEXT, hash TEXT NOT NULL, previous_hash TEXT)",
  "CREATE TABLE IF NOT EXISTS white_label_settings (id TEXT PRIMARY KEY DEFAULT 'global', company_name TEXT NOT NULL DEFAULT 'TZRCoster Finance', app_title TEXT NOT NULL DEFAULT 'TZRCoster Maliyet & Finans', logo_url TEXT, favicon_url TEXT, background_url TEXT, primary_color TEXT NOT NULL DEFAULT '#2563EB', secondary_color TEXT NOT NULL DEFAULT '#1E40AF', default_theme TEXT NOT NULL DEFAULT 'dark', base_currency TEXT NOT NULL DEFAULT 'TRY', date_format TEXT NOT NULL DEFAULT 'DD.MM.YYYY', updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS auth_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER)",
];

const LEGACY_COLUMNS: readonly LegacyColumn[] = [
  { table: "transactions", column: "project_id", alterSql: "ALTER TABLE transactions ADD COLUMN project_id TEXT" },
  { table: "transactions", column: "payment_source", alterSql: "ALTER TABLE transactions ADD COLUMN payment_source TEXT NOT NULL DEFAULT 'company_account'" },
  { table: "transactions", column: "payer_person_name", alterSql: "ALTER TABLE transactions ADD COLUMN payer_person_name TEXT" },
  { table: "transactions", column: "payment_method", alterSql: "ALTER TABLE transactions ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'Banka'" },
  { table: "transactions", column: "oto_kasa_transaction_id", alterSql: "ALTER TABLE transactions ADD COLUMN oto_kasa_transaction_id TEXT" },
  { table: "transactions", column: "due_date", alterSql: "ALTER TABLE transactions ADD COLUMN due_date TEXT" },
  { table: "transactions", column: "is_paid", alterSql: "ALTER TABLE transactions ADD COLUMN is_paid INTEGER NOT NULL DEFAULT 1" },
  { table: "transactions", column: "deleted_at", alterSql: "ALTER TABLE transactions ADD COLUMN deleted_at TEXT" },
  { table: "categories", column: "budget", alterSql: "ALTER TABLE categories ADD COLUMN budget REAL NOT NULL DEFAULT 0" },
  { table: "users", column: "pin_hash", alterSql: "ALTER TABLE users ADD COLUMN pin_hash TEXT" },
  { table: "accounts", column: "credit_limit_encrypted", alterSql: "ALTER TABLE accounts ADD COLUMN credit_limit_encrypted TEXT" },
  { table: "accounts", column: "statement_closing_day", alterSql: "ALTER TABLE accounts ADD COLUMN statement_closing_day INTEGER" },
  { table: "accounts", column: "payment_due_day", alterSql: "ALTER TABLE accounts ADD COLUMN payment_due_day INTEGER" },
];

const INDEXES: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_trans_date ON transactions(date)",
  "CREATE INDEX IF NOT EXISTS idx_trans_category ON transactions(category_id)",
  "CREATE INDEX IF NOT EXISTS idx_trans_project ON transactions(project_id)",
  "CREATE INDEX IF NOT EXISTS idx_trans_title_bidx ON transactions(title_blind_index)",
  "CREATE INDEX IF NOT EXISTS idx_trans_party_bidx ON transactions(party_blind_index)",
  "CREATE INDEX IF NOT EXISTS idx_cat_parent ON categories(parent_id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp)",
  "CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_expires ON auth_sessions(user_id, expires_at)",
];
const PROJECT_MEMBERSHIPS_TABLE = "project_memberships";
const V2_DDL: readonly string[] = [
  "CREATE TABLE project_memberships (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, created_at TEXT NOT NULL, PRIMARY KEY (user_id, project_id))",
  "CREATE INDEX idx_project_memberships_project ON project_memberships(project_id, user_id)",
];
const V2_CONTENT: readonly string[] = ["version=2", "name=project-memberships", ...V2_DDL];

const ACCOUNTS_PROJECT_INDEX = 'idx_accounts_project';
const V3_DDL: readonly string[] = [
  'ALTER TABLE accounts ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT',
  'CREATE INDEX idx_accounts_project ON accounts(project_id)',
];
const V3_CONTENT: readonly string[] = ['version=3', 'name=account-project-scope', ...V3_DDL];
const NEWLINE = String.fromCharCode(10);
interface MigrationDefinition {
  version: number;
  name: string;
  content: readonly string[];
  apply: (sqlite: BetterSqliteDatabase) => void;
}
const V1_CONTENT: readonly string[] = ["version=1", "name=initial-schema", ...BASE_DDL, ...LEGACY_COLUMNS.map((c) => c.alterSql), ...INDEXES];
function checksumOf(content: readonly string[]): string {
  return createHash("sha256").update(content.join(NEWLINE), "utf8").digest("hex");
}
const MIGRATION_DEFINITIONS: readonly MigrationDefinition[] = [
  {
    version: 1,
    name: "initial-schema",
    content: V1_CONTENT,
    apply: (sqlite) => {
      for (const ddl of BASE_DDL) { sqlite.exec(ddl); }
      for (const item of LEGACY_COLUMNS) {
        const cols = columnsOf(sqlite, item.table);
        if (cols.size === 0) throw new Error("schema validation failed: missing required table " + item.table);
        if (!cols.has(item.column)) { sqlite.exec(item.alterSql); }
      }
      for (const idx of INDEXES) { sqlite.exec(idx); }
    },
  },
  {
    version: 2,
    name: "project-memberships",
    content: V2_CONTENT,
    apply: (sqlite) => {
      for (const ddl of V2_DDL) { sqlite.exec(ddl); }
    },
  },
  {
    version: 3,
    name: 'account-project-scope',
    content: V3_CONTENT,
    apply: (sqlite) => {
      for (const ddl of V3_DDL) { sqlite.exec(ddl); }
    },
  },];
export const MIGRATIONS: readonly SchemaMigration[] = MIGRATION_DEFINITIONS.map((def) => ({ version: def.version, name: def.name, checksum: checksumOf(def.content) }));
const REQUIRED_CORE_COLUMNS: Record<string, readonly string[]> = {
  users: ["id", "username", "email", "full_name", "password_hash", "role", "is_active", "two_factor_enabled", "two_factor_secret", "two_factor_backup_codes", "created_at", "updated_at", "pin_hash"],
  projects: ["id", "name", "code", "description", "budget", "currency", "status", "created_at", "updated_at"],
  parties: ["id", "name", "name_blind_index", "type", "phone", "email", "iban", "tax_no", "tax_office", "notes", "is_active", "created_at", "updated_at"],
  accounts: ['project_id', "id", "name", "name_blind_index", "type", "currency", "balance_encrypted", "iban_encrypted", "bank_name", "description", "is_active", "created_at", "updated_at", "credit_limit_encrypted", "statement_closing_day", "payment_due_day"],
  categories: ["id", "name", "code", "parent_id", "description", "color", "icon", "order_index", "custom_field_ids", "is_active", "created_at", "updated_at", "budget"],
  custom_fields: ["id", "name", "label", "type", "options_json", "unit", "required", "placeholder", "default_value", "created_at"],
  transactions: ["id", "project_id", "type", "date", "amount_encrypted", "currency", "exchange_rate", "base_amount_encrypted", "category_id", "subcategory_id", "title_encrypted", "title_blind_index", "description_encrypted", "party_encrypted", "party_blind_index", "account_from_id", "account_to_id", "payment_source", "payer_person_name", "payment_method", "oto_kasa_transaction_id", "due_date", "is_paid", "deleted_at", "custom_values_encrypted", "attachments_json", "status", "created_by_id", "approved_by_id", "created_at", "updated_at"],
  audit_logs: ["id", "user_id", "action", "entity", "entity_id", "timestamp", "ip_address", "user_agent", "diff_encrypted", "hash", "previous_hash"],
  white_label_settings: ["id", "company_name", "app_title", "logo_url", "favicon_url", "background_url", "primary_color", "secondary_color", "default_theme", "base_currency", "date_format", "updated_at"],
  auth_sessions: ["id", "user_id", "created_at", "expires_at", "revoked_at"],
};

interface AppliedRow { version: number; name: string; checksum: string; }
function tableExists(sqlite: BetterSqliteDatabase, name: string): boolean {
  const row = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { name: string } | undefined;
  return row !== undefined;
}
function columnsOf(sqlite: BetterSqliteDatabase, table: string): Set<string> {
  const rows = sqlite.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}
interface ForeignKeyInfo { id: number; seq: number; table: string; from: string; to: string; on_delete: string; }
function validateMembershipSchema(sqlite: BetterSqliteDatabase): void {
  const table = PROJECT_MEMBERSHIPS_TABLE;
  if (!tableExists(sqlite, table)) throw new Error("schema validation failed: missing required table " + table);
  const cols = sqlite.prepare("SELECT name, pk FROM pragma_table_info(?)").all(table) as Array<{ name: string; pk: number }>;
  const names = new Set(cols.map((c) => c.name));
  for (const col of ["user_id", "project_id", "created_at"]) {
    if (!names.has(col)) throw new Error("schema validation failed: missing required column " + table + "." + col);
  }
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (pk.length !== 2 || pk[0] !== "user_id" || pk[1] !== "project_id") throw new Error("schema validation failed: project_memberships composite primary key (user_id, project_id) required");
  const fks = sqlite.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(table) as ForeignKeyInfo[];
  if (fks.length !== 2) throw new Error("schema validation failed: project_memberships foreign keys are malformed");
  for (const exp of [{ child: "user_id", parent: "users" }, { child: "project_id", parent: "projects" }]) {
    const fk = fks.find((r) => r.from === exp.child);
    if (!fk || fk.table !== exp.parent || fk.to !== "id" || String(fk.on_delete).toUpperCase() !== "CASCADE") throw new Error("schema validation failed: " + table + "." + exp.child + " requires ON DELETE CASCADE reference to " + exp.parent);
  }
}

function validateAccountsProjectSchema(sqlite: BetterSqliteDatabase): void {
  const table = "accounts";
  if (!tableExists(sqlite, table)) throw new Error("schema validation failed: missing required table " + table);
  const cols = sqlite.pragma("table_info(accounts)") as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
  const projectCol = cols.find((c) => c.name === "project_id");
  if (!projectCol) throw new Error("schema validation failed: missing required column accounts.project_id");
  if (String(projectCol.type).toUpperCase() !== "TEXT") throw new Error("schema validation failed: accounts.project_id must be TEXT");
  if (Number(projectCol.notnull) !== 0) throw new Error("schema validation failed: accounts.project_id must be nullable");
  const dflt = projectCol.dflt_value;
  if (dflt !== null && dflt !== undefined && String(dflt).trim().toUpperCase() !== "NULL") throw new Error("schema validation failed: accounts.project_id must have no non-null default");
  const fks = sqlite.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(table) as ForeignKeyInfo[];
  const fkRows = fks.filter((r) => r.from === "project_id");
  if (fkRows.length !== 1) throw new Error("schema validation failed: accounts.project_id requires ON DELETE RESTRICT reference to projects(id)");
  const fk = fkRows[0];
  if (fks.filter((r) => r.id === fk.id).length !== 1 || Number(fk.seq) !== 0) throw new Error("schema validation failed: accounts.project_id foreign key must be single-column");
  if (!fk || fk.table !== "projects" || fk.to !== "id" || String(fk.on_delete).toUpperCase() !== "RESTRICT") throw new Error("schema validation failed: accounts.project_id requires ON DELETE RESTRICT reference to projects(id)");
  const idxList = sqlite.pragma("index_list(accounts)") as Array<{ name: string; unique: number; partial: number }>;
  const idx = idxList.find((r) => r.name === ACCOUNTS_PROJECT_INDEX);
  if (!idx) throw new Error("schema validation failed: missing required index " + ACCOUNTS_PROJECT_INDEX);
  if (Number(idx.unique) !== 0 || Number(idx.partial) !== 0) throw new Error("schema validation failed: " + ACCOUNTS_PROJECT_INDEX + " must be nonunique and nonpartial");
  const idxCols = sqlite.pragma("index_info(idx_accounts_project)") as Array<{ name: string }>;
  if (idxCols.length !== 1 || idxCols[0].name !== "project_id") throw new Error("schema validation failed: " + ACCOUNTS_PROJECT_INDEX + " must index accounts(project_id)");
}

export function validateCurrentSchema(sqlite: BetterSqliteDatabase): void {
  for (const table of Object.keys(REQUIRED_CORE_COLUMNS)) {
    const cols = columnsOf(sqlite, table);
    if (cols.size === 0) throw new Error("schema validation failed: missing required table " + table);
    for (const col of REQUIRED_CORE_COLUMNS[table]) {
      if (!cols.has(col)) throw new Error("schema validation failed: missing required column " + table + "." + col);
    }
  }
  validateMembershipSchema(sqlite);
  validateAccountsProjectSchema(sqlite);
}

function runForeignKeyCheck(sqlite: BetterSqliteDatabase): void {
  const violations = sqlite.prepare("PRAGMA foreign_key_check").all() as unknown[];
  if (violations.length > 0) throw new Error("foreign key check failed: " + violations.length + " violation(s) detected");
}
function ensureHistoryTable(sqlite: BetterSqliteDatabase): void {
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
}
function readValidatedHistory(sqlite: BetterSqliteDatabase): AppliedRow[] {
  const rows = sqlite.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC").all() as AppliedRow[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const expected = MIGRATION_DEFINITIONS[i];
    if (!expected || row.version !== expected.version) throw new Error("schema migration history is out of sequence at version " + row.version);
    if (row.name !== expected.name) throw new Error("schema migration name mismatch for version " + row.version);
    if (row.checksum !== MIGRATIONS[i].checksum) throw new Error("schema migration checksum mismatch for version " + row.version);
  }
  return rows;
}
export function runMigrations(sqlite: BetterSqliteDatabase): void {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    ensureHistoryTable(sqlite);
    const applied = readValidatedHistory(sqlite);
    const appliedVersions = new Set(applied.map((row) => row.version));
    for (const def of MIGRATION_DEFINITIONS) {
      if (appliedVersions.has(def.version)) continue;
      const meta = MIGRATIONS.find((m) => m.version === def.version);
      if (!meta) throw new Error("unknown schema migration version " + def.version);
      def.apply(sqlite);
      sqlite.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(def.version, def.name, meta.checksum, new Date().toISOString());
    }
    validateCurrentSchema(sqlite);
    runForeignKeyCheck(sqlite);
    sqlite.exec("COMMIT");
  } catch (err) {
    try { sqlite.exec("ROLLBACK"); } catch {}
    throw err;
  }
}
