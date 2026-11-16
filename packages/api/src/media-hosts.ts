// The owner's media host (an S3-compatible bucket), used to give platforms that download media
// from a URL (Instagram) a public link. Read per use, so a change in Settings applies immediately.
import {
  createS3MediaHost,
  Vault,
  type IntegrationDeps,
  type MediaHost,
  type S3MediaHostConfig,
  type VaultError,
} from '@posthub/integrations';
import { hostedMedia, type Db } from '@posthub/db';
import { and, eq, isNull } from 'drizzle-orm';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { Database, type DatabaseError } from './services';
import { decodeSetting, deleteSetting, readSettingRow, writeSetting } from './settings';

/** What the settings page shows. The secret never leaves the server. */
export type MediaHostSettings = Omit<S3MediaHostConfig, 'secretAccessKey' | 'publicBaseUrl'> & {
  publicBaseUrl: string | null;
};

export interface MediaHostInput extends Omit<
  S3MediaHostConfig,
  'secretAccessKey' | 'publicBaseUrl'
> {
  /** Leave empty to keep the current secret. */
  secretAccessKey?: string;
  publicBaseUrl?: string | null;
}

/** The owner's media host input can't be used (e.g. a missing secret). */
export class MediaHostError extends Schema.TaggedError<MediaHostError>()('MediaHostError', {
  message: Schema.String,
}) {}

export interface MediaHostsService {
  /** The owner's media host as configured right now, if any. */
  forUser(userId: string): Effect.Effect<Option.Option<MediaHost>, DatabaseError>;
  /** Captures the destination before an upload, for durable cleanup even after settings change. */
  capture(
    userId: string,
  ): Effect.Effect<Option.Option<{ host: MediaHost; encryptedConfig: string }>, DatabaseError>;
  restore(encryptedConfig: string): Effect.Effect<MediaHost, VaultError>;
  describe(userId: string): Effect.Effect<MediaHostSettings | null, DatabaseError>;
  save(userId: string, input: MediaHostInput): Effect.Effect<void, MediaHostError | DatabaseError>;
  remove(userId: string): Effect.Effect<void, DatabaseError>;
  /** A host built from `input` (falling back to the stored secret), for the Test button. */
  build(
    userId: string,
    input: MediaHostInput,
  ): Effect.Effect<MediaHost, MediaHostError | DatabaseError>;
}

export const makeMediaHosts = Effect.fnUntraced(function* (deps: IntegrationDeps = {}) {
  const database = yield* Database;
  const vault = yield* Vault;

  const stored = (userId: string) =>
    Effect.flatMap(
      database.use((db) => readSettingRow(db, userId, 'mediaHost')),
      (row) => decodeSetting<S3MediaHostConfig>(vault, row),
    );

  const create = (config: S3MediaHostConfig) => createS3MediaHost(config, { fetch: deps.fetch });

  // Keep the current destination for legacy uploads before it is replaced or removed.
  const preservePendingUploads = (db: Db, userId: string) => {
    const current = readSettingRow(db, userId, 'mediaHost');
    if (!current?.secret) return;
    db.update(hostedMedia)
      .set({ hostConfig: current.value })
      .where(and(eq(hostedMedia.userId, userId), isNull(hostedMedia.hostConfig)))
      .run();
  };

  const complete = Effect.fnUntraced(function* (userId: string, input: MediaHostInput) {
    const current = yield* stored(userId);
    const secretAccessKey =
      input.secretAccessKey?.trim() ||
      Option.getOrUndefined(Option.map(current, (c) => c.secretAccessKey));
    if (!secretAccessKey) {
      return yield* new MediaHostError({ message: 'The secret access key is required.' });
    }
    const publicBaseUrl = input.publicBaseUrl?.trim();
    return {
      endpoint: input.endpoint.trim(),
      region: input.region.trim(),
      bucket: input.bucket.trim(),
      accessKeyId: input.accessKeyId.trim(),
      secretAccessKey,
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
    } satisfies S3MediaHostConfig;
  });

  return MediaHosts.of({
    forUser: (userId) => Effect.map(stored(userId), Option.map(create)),
    capture: (userId) =>
      Effect.map(
        stored(userId),
        Option.map((config) => ({
          host: create(config),
          encryptedConfig: vault.encrypt(config),
        })),
      ),
    restore: (encryptedConfig) =>
      Effect.map(vault.decrypt<S3MediaHostConfig>(encryptedConfig), create),

    describe: (userId) =>
      Effect.map(stored(userId), (config) =>
        Option.match(config, {
          onNone: () => null,
          onSome: ({ secretAccessKey: _secret, publicBaseUrl, ...rest }) => ({
            ...rest,
            publicBaseUrl: publicBaseUrl ?? null,
          }),
        }),
      ),

    save: Effect.fnUntraced(function* (userId, input) {
      const config = yield* complete(userId, input);
      yield* database.transaction(
        database.use((db) => {
          preservePendingUploads(db, userId);
          writeSetting(db, vault, userId, 'mediaHost', config, { secret: true });
        }),
      );
    }),

    remove: (userId) =>
      Effect.asVoid(
        database.transaction(
          database.use((db) => {
            preservePendingUploads(db, userId);
            deleteSetting(db, userId, 'mediaHost');
          }),
        ),
      ),

    build: (userId, input) => Effect.map(complete(userId, input), create),
  });
});

export class MediaHosts extends Context.Service<MediaHosts, MediaHostsService>()(
  '@posthub/api/MediaHosts',
) {
  static readonly layer = (deps: IntegrationDeps = {}) =>
    Layer.effect(MediaHosts, makeMediaHosts(deps));
}
