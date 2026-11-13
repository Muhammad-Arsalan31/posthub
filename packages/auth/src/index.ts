import { schema, type Db } from '@posthub/db';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

export interface AuthOptions {
  db: Db;
  /** Public URL the browser uses to reach the app, e.g. http://localhost:5173 in dev. */
  baseURL: string;
  secret: string;
  trustedOrigins?: string[];
}

export function createAuth({ db, baseURL, secret, trustedOrigins = [] }: AuthOptions) {
  return betterAuth({
    baseURL,
    secret,
    basePath: '/api/auth',
    trustedOrigins: [baseURL, ...trustedOrigins],
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
    },
    session: {
      // Local desktop app: keep people signed in for a month, refresh daily.
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = Auth['$Infer']['Session'];
