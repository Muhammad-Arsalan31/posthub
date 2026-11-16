// Per-user settings in `app_setting`. Plain functions over `db` (callable inside a transaction),
// plus Effect wrappers. Secret settings are stored vault-encrypted and never sent to the client.
import { appSetting, type Db } from '@posthub/db';
import type { VaultService } from '@posthub/integrations';
import { and, eq } from 'drizzle-orm';
import { Effect, Option } from 'effect';

export type SettingKey = 'mediaHost' | 'timezone';

export const readSettingRow = (db: Db, userId: string, key: SettingKey) =>
  db
    .select()
    .from(appSetting)
    .where(and(eq(appSetting.userId, userId), eq(appSetting.key, key)))
    .get();

export function writeSetting(
  db: Db,
  vault: VaultService,
  userId: string,
  key: SettingKey,
  value: unknown,
  options: { secret?: boolean } = {},
) {
  const secret = options.secret ?? false;
  const stored = secret ? vault.encrypt(value) : JSON.stringify(value);
  db.insert(appSetting)
    .values({ userId, key, value: stored, secret })
    .onConflictDoUpdate({
      target: [appSetting.userId, appSetting.key],
      set: { value: stored, secret, updatedAt: new Date() },
    })
    .run();
}

export const deleteSetting = (db: Db, userId: string, key: SettingKey) =>
  db
    .delete(appSetting)
    .where(and(eq(appSetting.userId, userId), eq(appSetting.key, key)))
    .run();

/** A setting's value, decrypted when secret. A setting that can't be decrypted counts as unset. */
export const decodeSetting = <T>(
  vault: VaultService,
  row: typeof appSetting.$inferSelect | undefined,
): Effect.Effect<Option.Option<T>> => {
  if (!row) return Effect.succeedNone;
  if (!row.secret) return Effect.succeed(Option.some(JSON.parse(row.value) as T));
  return vault.decrypt<T>(row.value).pipe(
    Effect.map(Option.some),
    Effect.catchTag('VaultError', () =>
      Effect.as(
        Effect.logWarning(
          `[settings] could not decrypt ${row.key}; was the encryption key changed?`,
        ),
        Option.none<T>(),
      ),
    ),
  );
};
