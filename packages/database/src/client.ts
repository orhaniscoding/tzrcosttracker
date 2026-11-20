import Database from "better-sqlite3";
import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { runMigrations } from "./migrations.js";
import { acquireDatabaseLease, type DatabaseLease } from './lease.js';

export interface DatabaseOptions {
  path?: string;
  verbose?: boolean;
}

export interface DatabaseInstance {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: BetterSqliteDatabase;
}

export interface LeasedDatabaseInstance extends DatabaseInstance {
  close(): void;
}

export function initDatabase(options: DatabaseOptions = {}): DatabaseInstance {
  return openWritableDatabase(options.path || ':memory:', options.verbose);
}

export function initLeasedDatabase(path = ':memory:'): LeasedDatabaseInstance {
  const lease = path === ':memory:' ? undefined : acquireDatabaseLease(path);
  return openWritableDatabase(lease?.databasePath ?? path, false, lease);
}

function openWritableDatabase(path: string, verbose?: boolean, lease?: DatabaseLease): LeasedDatabaseInstance {
  let sqlite: BetterSqliteDatabase | undefined;
  function close(): void {
    if (sqlite?.open) sqlite.close();
    lease?.release();
  }

  try {
    lease?.assertRecoveryClear();
    sqlite = new Database(path, { verbose: verbose ? console.log : undefined });
    if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    runMigrations(sqlite);
    return { db: drizzle(sqlite, { schema }), sqlite, close };
  } catch (error) {
    try {
      close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Could not close the database after failed initialization.');
    }
    throw error;
  }
}

/** Open an existing database for verification without migrations or journal changes. */
export function openReadOnlyDatabase(path: string): DatabaseInstance {
  const sqlite = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return { sqlite, db: drizzle(sqlite, { schema }) };
  } catch (err) {
    try { sqlite.close(); } catch { /* keep original error */ }
    throw err;
  }
}

export type CostCoreDatabase = ReturnType<typeof initDatabase>["db"];
