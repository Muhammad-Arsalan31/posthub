import { randomUUID } from 'node:crypto';
import { Api, CurrentUser } from '@posthub/contract';
import { queueSlot, socialAccount, type Db } from '@posthub/db';
import { Vault } from '@posthub/integrations';
import { and, eq, inArray } from 'drizzle-orm';
import { Clock, Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { badRequest, handlerDatabase } from '../http-support';
import { findNextSlot, readSlots, readTimeZone } from '../queue';
import { Database } from '../services';
import { writeSetting } from '../settings';

const queueSettings = (db: Db, userId: string) => ({
  timezone: readTimeZone(db, userId),
  slots: readSlots(db, userId)
    .map(({ weekday, minuteOfDay, socialAccountId }) => ({ weekday, minuteOfDay, socialAccountId }))
    .sort((a, b) => a.weekday - b.weekday || a.minuteOfDay - b.minuteOfDay),
});

export const QueueHandlers = HttpApiBuilder.group(Api, 'queue', (handlers) =>
  Effect.gen(function* () {
    const { query, transaction } = handlerDatabase(yield* Database);
    const vault = yield* Vault;

    return handlers.handleAll({
      slots: () => Effect.flatMap(CurrentUser, (user) => query((db) => queueSettings(db, user.id))),

      saveSlots: ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          transaction(
            Effect.gen(function* () {
              const accountIds = [
                ...new Set(payload.slots.flatMap((slot) => slot.socialAccountId ?? [])),
              ];
              const owned = yield* query((db) =>
                accountIds.length
                  ? db
                      .select({ id: socialAccount.id })
                      .from(socialAccount)
                      .where(
                        and(
                          eq(socialAccount.userId, user.id),
                          inArray(socialAccount.id, accountIds),
                        ),
                      )
                      .all()
                  : [],
              );
              if (owned.length !== accountIds.length) {
                return yield* badRequest('One of the selected accounts no longer exists.');
              }
              return yield* query((db) => {
                db.delete(queueSlot).where(eq(queueSlot.userId, user.id)).run();
                const unique = new Map(
                  payload.slots.map((slot) => [
                    `${slot.weekday}:${slot.minuteOfDay}:${slot.socialAccountId}`,
                    slot,
                  ]),
                );
                if (unique.size) {
                  db.insert(queueSlot)
                    .values(
                      [...unique.values()].map((slot) => ({
                        ...slot,
                        id: randomUUID(),
                        userId: user.id,
                      })),
                    )
                    .run();
                }
                writeSetting(db, vault, user.id, 'timezone', payload.timezone);
                return queueSettings(db, user.id);
              });
            }),
          ),
        ),

      nextSlot: () =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const now = yield* Clock.currentTimeMillis;
          return { at: yield* query((db) => findNextSlot(db, user.id, now)) };
        }),
    });
  }),
);
