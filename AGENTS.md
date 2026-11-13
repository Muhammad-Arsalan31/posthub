# PostHub: agent guide

PostHub is a **locally deployed** social media manager for one owner's accounts on YouTube, LinkedIn,
Facebook, Instagram, TikTok and WordPress. It runs on a Windows machine, should start with the
system, and must publish scheduled posts reliably even when no browser window is open.

## Stack

- **Monorepo:** pnpm workspaces + Turborepo. Node >= 22.18, pnpm 11, Windows is the primary OS.
- **Tooling:** Vite+ (`vp`) does dev, build, pack, lint (Oxlint), format (Oxfmt), type check
  (TypeScript 7 via tsgolint) and test (Vitest 5). Root `vite.config.ts` holds the shared lint/fmt config.
- **Web (`apps/web`):** React 19, TanStack Router (file routes), TanStack Query, TanStack DB, Mantine 9, PWA (vite-plugin-pwa).
- **Server (`apps/server`):** Hono on `@hono/node-server`, oRPC, better-auth.
- **Data:** Drizzle ORM + SQLite (better-sqlite3, native module).

## Layout

```
apps/web/            React PWA
  src/routes/        file-based routes; routeTree.gen.ts is GENERATED, never edit it
  src/collections/   TanStack DB collections (oRPC-backed)
  src/lib/           orpc client, auth client, query client
  src/providers.tsx  MantineProviders: theme, package CSS, Dates/Modals/Notifications (app + tests)
  src/test/          test setup + renderRoute() helper
apps/server/         Hono server
  src/env.ts         all config/env in one place (paths, port, secret)
  src/app.ts         createApp({ db, auth, integrations, vault }): routes, used by index.ts and tests
packages/db/         Drizzle schema (src/schema), migrations (drizzle/), createDb, runMigrations
  src/testing.ts     createTestDb(), seedUser() for tests (@posthub/db/testing)
packages/auth/       createAuth(): better-auth config
packages/api/        oRPC router (src/index.ts), procedures (src/procedures.ts), routers/
  src/connections.ts beginOAuth/completeOAuth/saveAccounts (platform connect flows)
  src/testing.ts     testContext(), sessionFor() for procedure tests (@posthub/api/testing)
packages/integrations/  platform connectors: no DB access, injectable fetch
  src/providers/     google (YouTube), meta (Facebook + Instagram), linkedin, wordpress
  src/registry.ts    createIntegrations(config): enabled providers + adapters, PROVIDERS metadata
  src/vault.ts       AES-256-GCM credential encryption
  src/testing.ts     createFakeFetch(), tempMedia() (@posthub/integrations/testing)
```

Internal packages ship **TypeScript source** (`exports` point at `.ts`) with no build step. The web
app bundles them via Vite, and the server bundles them with `vp pack` (`deps.alwaysBundle`).

## Commands (run from the repo root)

| Task                              | Command                                |
| --------------------------------- | -------------------------------------- |
| Install                           | `pnpm install`                         |
| Dev (web :5173 + api :4100)       | `pnpm dev`                             |
| Lint + format + type check        | `pnpm check` (fix: `pnpm check:fix`)   |
| All tests                         | `pnpm test`                            |
| One package's tests               | `pnpm --filter @posthub/api test`      |
| Build                             | `pnpm build`                           |
| Run production build              | `pnpm start` (serves the PWA on :4100) |
| New migration after schema change | `pnpm db:generate`                     |
| Run a TS script                   | `pnpm exec vpx path/to/script.ts`      |

The global `vp` CLI may not be installed, so use `pnpm exec vp ...`. Use `vpx` to run TS files; do
not add `tsx`/`ts-node`. Note that `vp check` is a built-in command and `vp run <name>` runs a script.

**Before finishing any change, run `pnpm check` and `pnpm test`. Both must pass.**

## How requests flow

- In dev, the browser only talks to Vite (:5173), which proxies `/api`, `/rpc` and `/connect` to the server
  (127.0.0.1:4100). Everything is same-origin, so auth cookies need no CORS setup.
- In production, the server serves `apps/web/dist` itself, also same-origin.
- `/api/auth/*` is better-auth. `/rpc/*` is oRPC, and the session is resolved per request and put in the context.
- `/connect/:provider/start` and `/connect/:provider/callback` are the platform OAuth redirects (plain Hono
  routes, because they are browser navigations). They finish by redirecting to `/accounts?connected=N` or `?error=...`.

## Conventions

### API (oRPC)

- Add procedures in `packages/api/src/routers/<area>.ts` and mount them in `router` in `src/index.ts`.
- Use `protectedProcedure` for anything user-scoped; it provides `context.user` and a non-null
  `context.session`. **Always filter by `context.user.id`** (owner scoping is tested).
- Validate input with zod (v4). Throw `ORPCError('NOT_FOUND' | 'UNAUTHORIZED' | ...)` for expected errors.
- The web app imports **only types** from `@posthub/api` (`AppRouter`). Never import server code into the web bundle.
- Middleware gotcha: context injected via `next({ context })` must not redefine an existing context
  key with an incompatible type. Doing so silently breaks type inference for every downstream procedure _and_ the web client.

### Database (Drizzle + SQLite)

- Schema lives in `packages/db/src/schema/`. `auth.ts` holds the better-auth tables (keep them in
  sync with better-auth), and `app.ts` holds the domain tables.
- After changing the schema, run `pnpm db:generate` and commit the SQL in `packages/db/drizzle/`.
  Never hand-edit applied migrations. The server applies migrations on every start.
- Timestamps are `integer(..., { mode: 'timestamp_ms' })` and surface as `Date`. oRPC serializes `Date` natively.
- IDs are text. Posts use client-generated UUIDs so TanStack DB can insert optimistically.
- DB access happens only in the server/packages, never in the web app.

### Web

- Read data with TanStack DB `useLiveQuery` over a collection. Mutate with `collection.insert/update/delete`;
  the collection's `onInsert/onUpdate/onDelete` handlers persist through oRPC.
- For non-collection data, use `orpc.<path>.queryOptions()` with TanStack Query.
- Signed-in pages live under `src/routes/_app/` (the guard is in `_app.tsx`). Use Mantine components; don't add CSS frameworks.
- Installed Mantine extensions: form, dates (+dayjs), charts (+recharts), notifications, modals, tiptap
  (+StarterKit, Link), dropzone, emoji. Their CSS and providers are already wired in `src/providers.tsx`.
  Use `notifications.show()` and `modals.openConfirmModal()` directly.
- Test files sit next to routes and are excluded from routing via `routeFileIgnorePattern` in `vite.config.ts`.

### Connectors (`packages/integrations`)

- A **provider** is a connect flow (`google`, `meta`, `linkedin`, `wordpress`); an **adapter** publishes to one
  platform. One Meta login yields many accounts (each Page plus its linked Instagram account).
- Adapters implement `PlatformAdapter<C>`: `publish(credentials, input)` and optional `refresh(credentials)`.
  They receive decrypted credentials and never touch the DB. Callers persist refreshed credentials.
- Throw `PlatformError` with the right `retryable` flag (429/5xx default to retryable). After the call that
  creates the post succeeds, **nothing may throw** (e.g. a permalink lookup), or a retry would post twice.
- Credentials are encrypted with the vault before storage, and `accounts.list` never selects them.
- **Developer-app credentials** (client id/secret per OAuth provider) are entered on the Accounts page and stored
  vault-encrypted in `provider_app`. `createIntegrationsManager` (`packages/api/src/provider-apps.ts`) merges them
  over env values (`apps/server/src/env.ts`, DB wins field by field) and rebuilds the connectors on save, with no restart.
  Read `context.integrations` (a per-request snapshot) to use connectors, and `context.providerApps` to change app credentials.
  Secrets are never returned to the client.
- API versions are pinned: Meta Graph `v26.0` (`META_GRAPH_VERSION`), LinkedIn `202608` (`LINKEDIN_API_VERSION`).
  LinkedIn retires versions after about a year and returns 426 `NONEXISTENT_VERSION`.
- Test connectors with `createFakeFetch` routes (`"METHOD url-prefix"`, first match wins, so list longer prefixes first).

### Tests

- Import test APIs from `vite-plus/test` (not `vitest`).
- Backend tests: use `createTestDb()` (in-memory SQLite, real migrations) and `seedUser()`. Call
  procedures with `call(router.x.y, input, { context })`, or go through HTTP with `createApp({ db, auth, log: false })`.
- Web tests: jsdom + Testing Library. Use `renderRoute('/path')` and `vi.mock('../lib/auth-client')` for auth.

### Dependencies

- Versions live in the `catalog:` in `pnpm-workspace.yaml`. Add new ones there and reference them as
  `"pkg": "catalog:"`. Internal packages use `"workspace:*"`.
- `vite` is overridden to Vite+'s core (`@voidzero-dev/vite-plus-core`). Don't add `vite` or `vitest` directly.
- Packages with install scripts must be listed under `allowBuilds` in `pnpm-workspace.yaml`.

## Domain rules (publishing)

- **Each `post_target` row (post × account) publishes, fails and retries independently.** A post's status summarizes its targets.
- Publishing must be **durable and idempotent**: store jobs in SQLite, recover unfinished work on
  restart, and check whether an uncertain attempt actually succeeded before retrying, so posts never duplicate.
- Platform credentials are stored **encrypted** in `social_account.credentials` and never sent to the web app.
- Platform notes: WordPress uses Application Passwords; LinkedIn uses `w_member_social`; Facebook posts
  to Pages; Instagram requires Business/Creator accounts and may need publicly reachable media URLs;
  YouTube has upload quotas. **TikTok uses a manual handoff** (target status `manual`), because Direct Post
  isn't available for private tools.
- Instagram needs a **public media URL** (`MediaFile.publicUrl`); local files alone are not enough. YouTube needs a video.
  LinkedIn supports text, link, and single-image posts (video comes later).
- Planned next: media uploads, then a publishing worker in the server (claims due `post_target` rows, calls
  `refreshIfExpiring` and the adapter, and records the result), then a Windows startup/Electron shell.

## Environment

- `apps/server/.env` (copy from `.env.example`) needs `BETTER_AUTH_SECRET` and `POSTHUB_ENCRYPTION_KEY` (32+ chars each),
  Connector app credentials are optional here (the Accounts page is preferred). Never commit `.env`.
- Data lives in `<repo>/.data/` in dev (`POSTHUB_DATA_DIR` overrides it): `posthub.db` and `media/`.
- On Windows, shell `python` may be the Microsoft Store stub and hang, so use Node for scripting.
