import { describe, expect, it } from '@effect/vitest';
import { providerApp, type Db } from '@posthub/db';
import { createTestDb } from '@posthub/db/testing';
import { Deferred, Effect, Fiber, Schema } from 'effect';
import { makeDatabase } from './services';

class Oops extends Schema.TaggedError<Oops>()('Oops', {}) {}

const providers = (db: Db) =>
  db
    .select({ provider: providerApp.provider })
    .from(providerApp)
    .all()
    .map((row) => row.provider)
    .sort();

const insert = (db: Db, provider: string) =>
  db.insert(providerApp).values({ provider, config: 'x' }).run();

describe('Database', () => {
  it.effect('commits a transaction that succeeds', () =>
    Effect.gen(function* () {
      const db = createTestDb();
      const database = makeDatabase(db);
      yield* database.transaction(
        Effect.andThen(
          database.use((d) => insert(d, 'a')),
          database.use((d) => insert(d, 'b')),
        ),
      );
      expect(providers(db)).toEqual(['a', 'b']);
    }),
  );

  it.effect('rolls back everything when the transaction fails', () =>
    Effect.gen(function* () {
      const db = createTestDb();
      const database = makeDatabase(db);
      const error = yield* database
        .transaction(
          Effect.andThen(
            database.use((d) => insert(d, 'a')),
            Effect.fail(new Oops()),
          ),
        )
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(Oops);
      expect(providers(db)).toEqual([]);
    }),
  );

  it.effect('joins an outer transaction when nested', () =>
    Effect.gen(function* () {
      const db = createTestDb();
      const database = makeDatabase(db);
      yield* database
        .transaction(
          Effect.gen(function* () {
            yield* database.transaction(database.use((d) => insert(d, 'inner')));
            return yield* new Oops();
          }),
        )
        .pipe(Effect.flip);
      // The inner part was not committed on its own.
      expect(providers(db)).toEqual([]);
    }),
  );

  it.effect('turns a failing statement into a DatabaseError', () =>
    Effect.gen(function* () {
      const db = createTestDb();
      const database = makeDatabase(db);
      yield* database.use((d) => insert(d, 'a'));
      const error = yield* database.use((d) => insert(d, 'a')).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: 'DatabaseError' });
      expect(error.message).toMatch(/UNIQUE/);
    }),
  );

  it.effect("keeps other fibers' statements out of an open transaction", () =>
    Effect.gen(function* () {
      const db = createTestDb();
      const database = makeDatabase(db);
      const inside = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      // A transaction that writes, waits (e.g. on the network), then fails and rolls back.
      const transaction = yield* database
        .transaction(
          Effect.gen(function* () {
            yield* database.use((d) => insert(d, 'rolled-back'));
            yield* Deferred.succeed(inside, undefined);
            yield* Deferred.await(release);
            return yield* new Oops();
          }),
        )
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(inside);

      // Meanwhile another fiber writes. It must wait, not join the transaction: give it every
      // chance to run before the transaction ends.
      const other = yield* database.use((d) => insert(d, 'kept')).pipe(Effect.forkChild);
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(transaction);
      yield* Fiber.join(other);

      expect(providers(db)).toEqual(['kept']);
    }),
  );
});
