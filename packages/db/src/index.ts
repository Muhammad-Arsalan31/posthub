import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export { schema };
export * from './schema';

export function createDb(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return drizzle({ client: sqlite, schema });
}

export type Db = ReturnType<typeof createDb>;

/** Apply bundled SQL migrations. Runs on every server start so installed upgrades migrate themselves. */
export function runMigrations(db: Db, migrationsFolder: string) {
  migrate(db, { migrationsFolder });
}
