// Plain services the API's Effect code depends on. `apiLayer` (layer.ts) provides them all.
import type { Db } from '@posthub/db';
import { Context, Effect, Exit, Layer, Schema, Semaphore } from 'effect';

/** SQLite refused a statement (constraint, disk, corrupt file...). Unexpected for callers. */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()('DatabaseError', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface DatabaseService {
  /**
   * Runs Drizzle code (synchronous with better-sqlite3), e.g.
   * `database.use((db) => db.select().from(post).all())`. Failures become a DatabaseError.
   */
  use<A>(query: (db: Db) => A): Effect.Effect<A, DatabaseError>;
  /**
   * Runs `effect` in one transaction: committed if it succeeds, rolled back if it fails or is
   * interrupted. Nested calls join the outer transaction.
   */
  transaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseError, R>;
}

/** Set while the current fiber is inside a transaction. */
const InTransaction = Context.Reference<boolean>('@posthub/api/Database/InTransaction', {
  defaultValue: () => false,
});

/**
 * The database as an Effect service. There is one SQLite connection, so statements from other
 * fibers must not run while a transaction is open (they would become part of it): a one-permit
 * lock serializes transactions and plain statements alike.
 */
export function makeDatabase(db: Db): DatabaseService {
  const lock = Semaphore.makeUnsafe(1);
  const client = db.$client;

  const attempt = <A>(work: () => A, message: string) =>
    Effect.try({
      try: work,
      catch: (cause) =>
        new DatabaseError({
          message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });

  return {
    use: (query) =>
      Effect.flatMap(InTransaction, (inTransaction) => {
        const run = attempt(() => query(db), 'Database query failed');
        return inTransaction ? run : lock.withPermits(1)(run);
      }),

    transaction: (effect) =>
      Effect.flatMap(InTransaction, (inTransaction) => {
        if (inTransaction) return effect;
        return lock.withPermits(1)(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* attempt(() => client.exec('BEGIN IMMEDIATE'), 'Could not start a transaction');
              const exit = yield* Effect.exit(
                restore(Effect.provideService(effect, InTransaction, true)),
              );
              if (Exit.isSuccess(exit)) {
                yield* attempt(() => client.exec('COMMIT'), 'Could not commit').pipe(
                  Effect.tapError(() => Effect.sync(() => client.exec('ROLLBACK'))),
                );
              } else {
                client.exec('ROLLBACK');
              }
              return yield* exit;
            }),
          ),
        );
      }),
  };
}

/** The database (Drizzle on better-sqlite3), with Effect-based queries and transactions. */
export class Database extends Context.Service<Database, DatabaseService>()(
  '@posthub/api/Database',
) {
  static readonly layer = (db: Db) => Layer.sync(Database, () => makeDatabase(db));
}

/** Folder holding uploaded media files. */
export class MediaDir extends Context.Service<MediaDir, string>()('@posthub/api/MediaDir') {
  static readonly layer = (dir: string) => Layer.succeed(MediaDir, dir);
}
