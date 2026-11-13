import { fileURLToPath } from 'node:url';
import { createDb, runMigrations, user, type Db } from './index';

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Fresh in-memory SQLite database with all migrations applied. */
export function createTestDb(): Db {
  const db = createDb(':memory:');
  runMigrations(db, migrationsFolder);
  return db;
}

export function seedUser(db: Db, overrides: Partial<typeof user.$inferInsert> = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  return db
    .insert(user)
    .values({ id, name: 'Test User', email: `${id}@test.local`, ...overrides })
    .returning()
    .get();
}
