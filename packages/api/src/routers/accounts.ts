import { Account, Api, BadGateway, BadRequest, CurrentUser } from '@posthub/contract';
import { socialAccount } from '@posthub/db';
import { Vault, type WordPressCredentials } from '@posthub/integrations';
import { and, asc, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { saveAccounts } from '../connections';
import { handlerDatabase, notFound } from '../http-support';
import { ProviderApps } from '../provider-apps';
import { Database } from '../services';

/** Everything except credentials, which never leave the server. */
const publicColumns = {
  id: socialAccount.id,
  platform: socialAccount.platform,
  externalId: socialAccount.externalId,
  displayName: socialAccount.displayName,
  status: socialAccount.status,
  tokenExpiresAt: socialAccount.tokenExpiresAt,
  createdAt: socialAccount.createdAt,
};

export const AccountsHandlers = HttpApiBuilder.group(Api, 'accounts', (handlers) =>
  Effect.gen(function* () {
    const { query } = handlerDatabase(yield* Database);
    const vault = yield* Vault;
    const providerApps = yield* ProviderApps;
    const services = yield* Effect.context<Database | Vault>();

    return handlers.handleAll({
      list: () =>
        Effect.flatMap(CurrentUser, (user) =>
          query((db): Account[] =>
            db
              .select(publicColumns)
              .from(socialAccount)
              .where(eq(socialAccount.userId, user.id))
              .orderBy(asc(socialAccount.platform), asc(socialAccount.displayName))
              .all(),
          ),
        ),

      /** Connectable providers, whether they are set up, and where their app credentials come from. */
      providers: () =>
        Effect.flatMap(providerApps.current, (integrations) =>
          Effect.forEach(integrations.status(), (provider) =>
            provider.id === 'wordpress'
              ? Effect.succeed({ ...provider, source: null, clientId: null })
              : Effect.map(providerApps.describe(provider.id), (app) => ({ ...provider, ...app })),
          ),
        ),

      connectWordPress: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const integrations = yield* providerApps.current;
          const account = yield* integrations.wordpress
            .connect(payload)
            .pipe(
              Effect.mapError((error) =>
                error._tag === 'PlatformError'
                  ? new BadRequest({ message: error.message })
                  : new BadGateway({ message: `Could not reach the site: ${error.message}` }),
              ),
            );
          yield* saveAccounts(user.id, [account]).pipe(
            Effect.provideContext(services),
            Effect.orDie,
          );
          return { displayName: account.displayName };
        }),

      wordpressCategories: ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const account = yield* query((db) =>
            db
              .select({ credentials: socialAccount.credentials })
              .from(socialAccount)
              .where(
                and(
                  eq(socialAccount.id, payload.accountId),
                  eq(socialAccount.userId, user.id),
                  eq(socialAccount.platform, 'wordpress'),
                ),
              )
              .get(),
          );
          if (!account?.credentials) return yield* notFound();
          const credentials = yield* vault.decrypt<WordPressCredentials>(account.credentials);
          const integrations = yield* providerApps.current;
          return yield* integrations.wordpress
            .categories(credentials)
            .pipe(Effect.mapError((error) => new BadGateway({ message: error.message })));
        }).pipe(
          Effect.catchTag('VaultError', (error) =>
            Effect.fail(new BadGateway({ message: error.message })),
          ),
        ),

      disconnect: ({ payload }) =>
        Effect.flatMap(CurrentUser, (user) =>
          query((db) => {
            db.delete(socialAccount)
              .where(and(eq(socialAccount.id, payload.id), eq(socialAccount.userId, user.id)))
              .run();
            return { id: payload.id };
          }),
        ),
    });
  }),
);
