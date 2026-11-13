# PostHub

A local social media manager (YouTube, LinkedIn, Facebook, Instagram, WordPress).

## Stack

| Layer   | Tools                                                                     |
| ------- | ------------------------------------------------------------------------- |
| Web     | React 19, TanStack Router (file routes), Query, DB, Mantine, PWA          |
| API     | Hono on Node, oRPC (typed procedures), better-auth (email + password)     |
| Data    | Drizzle ORM + SQLite (better-sqlite3), migrations applied on server start |
| Tooling | pnpm workspaces, Turborepo, Vite+ (`vp`: dev, build, pack, check, test)   |

## Layout

```
apps/
  web/       React PWA: routes in src/routes, TanStack DB collections in src/collections
  server/    Hono server: /api/auth/* (better-auth), /rpc/* (oRPC), serves web/dist in production
packages/
  db/        Drizzle schema, migrations (drizzle/), createDb, test helpers (@posthub/db/testing)
  auth/      better-auth config (createAuth)
  api/       oRPC router + procedures; the web app imports only its types
```

Workspace packages ship TypeScript source (no build step). The server bundles them with `vp pack`.

## Getting started

```sh
pnpm install
cp apps/server/.env.example apps/server/.env   # then set BETTER_AUTH_SECRET
pnpm dev                                       # web http://localhost:5173, api :4100
```

In dev, Vite proxies `/api` and `/rpc` to the server, so everything is same-origin and auth cookies just work.
Data is stored in `.data/` (override with `POSTHUB_DATA_DIR`).

## Scripts

| Command            | What it does                                                       |
| ------------------ | ------------------------------------------------------------------ |
| `pnpm dev`         | Run web + server in watch mode (Turborepo)                         |
| `pnpm build`       | Build the PWA and bundle the server                                |
| `pnpm start`       | Run the built server, which serves the PWA (`NODE_ENV=production`) |
| `pnpm test`        | Run all test suites (Vitest via `vp test`)                         |
| `pnpm check`       | Format check + lint + type check (`vp check`)                      |
| `pnpm check:fix`   | Same, applying fixes                                               |
| `pnpm db:generate` | Generate a SQL migration after editing `packages/db/src/schema`    |
| `pnpm db:studio`   | Open Drizzle Studio                                                |

## Tests

- `packages/db`: migrations, constraints and cascades on in-memory SQLite.
- `packages/api`: procedures called directly with `call()`, covering auth, ownership and validation.
- `apps/server`: full HTTP flow: sign up, then make typed oRPC calls with the session cookie.
- `apps/web`: jsdom + Testing Library. Renders the real route tree (auth guard, login form).

Use `createTestDb()` / `seedUser()` from `@posthub/db/testing` for new backend tests.
