// Plain services the API's Effect code depends on. `apiLayer` (layer.ts) provides them all.
import type { Db } from '@posthub/db';
import { Cause, Context, Effect, Exit, Layer, Schema } from 'effect';

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
   * Runs `effect` in one transaction: committed if it succeeds, rolled back if it fails.
   * Nested calls join the outer transaction.
   *
   * The effect runs synchronously, start to finish: it must not wait for anything (network,
   * timers, other fibers). Waiting would leave the transaction open while other code, such as
   * better-auth on the same connection, writes into it. If it tries, it is stopped, the
   * transaction is rolled back, and it dies with an error saying so.
   */
  transaction<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | DatabaseError, R>;
}

/** Set while the current fiber is inside a transaction. */
const InTransaction = Context.Reference<boolean>('@posthub/api/Database/InTransaction', {
  defaultValue: () => false,
});

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The database as an Effect service. better-sqlite3 is synchronous and there is one connection,
 * so running each transaction synchronously keeps every other statement out of it, exactly
 * like `db.transaction(callback)` does.
 */
export function makeDatabase(db: Db): DatabaseService {
  const client = db.$client;

  const attempt = <A>(work: () => A, message: string) =>
    Effect.try({
      try: work,
      catch: (cause) => new DatabaseError({ message: `${message}: ${describe(cause)}`, cause }),
    });

  return {
    use: (query) => attempt(() => query(db), 'Database query failed'),

    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(InTransaction, (inTransaction) =>
        inTransaction
          ? effect
          : Effect.flatMap(Effect.context<R>(), (context) =>
              Effect.suspend((): Effect.Effect<A, E | DatabaseError> => {
                try {
                  client.exec('BEGIN IMMEDIATE');
                } catch (cause) {
                  return Effect.fail(
                    new DatabaseError({
                      message: `Could not start a transaction: ${describe(cause)}`,
                      cause,
                    }),
                  );
                }
                const exit = Effect.runSyncExitWith(Context.add(context, InTransaction, true))(
                  effect,
                );
                if (Exit.isFailure(exit)) {
                  client.exec('ROLLBACK');
                  const async = exit.cause.reasons.find(
                    (reason) => Cause.isDieReason(reason) && Cause.isAsyncFiberError(reason.defect),
                  );
                  if (async && Cause.isDieReason(async) && Cause.isAsyncFiberError(async.defect)) {
                    async.defect.fiber.interruptUnsafe();
                    return Effect.die(
                      new Error(
                        'A database transaction waited for something asynchronous and was rolled ' +
                          'back. Do network calls and other waiting before or after the transaction.',
                      ),
                    );
                  }
                  return exit;
                }
                try {
                  client.exec('COMMIT');
                } catch (cause) {
                  client.exec('ROLLBACK');
                  return Effect.fail(
                    new DatabaseError({ message: `Could not commit: ${describe(cause)}`, cause }),
                  );
                }
                return exit;
              }),
            ),
      ),
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
