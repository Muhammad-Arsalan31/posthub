import { describe, expect, it } from '@effect/vitest';
import { createAuth } from '@posthub/auth';
import { providerApp, user, type Db } from '@posthub/db';
import { createTestDb } from '@posthub/db/testing';
import { Cause, Effect, Exit, Schema } from 'effect';
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
  it('does not roll back a successful auth signup with an unrelated transaction', async () => {
    const db = createTestDb();
    const database = makeDatabase(db);
    const auth = createAuth({
      db,
      baseURL: 'http://localhost:4100',
      secret: 'test-secret-test-secret-test-secret!',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = Effect.runPromise(
      database
        .transaction(
          Effect.gen(function* () {
            yield* database.use((d) => insert(d, 'rolled-back'));
            yield* Effect.promise(() => gate);
            return yield* new Oops();
          }),
        )
        .pipe(Effect.exit),
    );

    try {
      const signup = await auth.api.signUpEmail({
        body: { email: 'owner@posthub.test', password: 'password123', name: 'Owner' },
      });
      release();
      expect(Exit.isFailure(await transaction)).toBe(true);
      expect(db.select().from(user).all()).toMatchObject([{ id: signup.user.id }]);
      expect(providers(db)).toEqual([]);
      expect(db.$client.inTransaction).toBe(false);
    } finally {
      release();
      await transaction;
      db.$client.close();
    }
  });

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

  it.effect('rolls back and fails loudly when a transaction waits', () =>
    Effect.gen(function* () {
      const db = createTestDb();
      const database = makeDatabase(db);
      const exit = yield* database
        .transaction(
          Effect.andThen(
            database.use((d) => insert(d, 'rolled-back')),
            Effect.sleep('1 second'),
          ),
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toMatch(
        /waited for something asynchronous/,
      );
      // Nothing stays open or half-written: other code can write normally.
      expect(providers(db)).toEqual([]);
      yield* database.use((d) => insert(d, 'after'));
      expect(providers(db)).toEqual(['after']);
    }),
  );
});
