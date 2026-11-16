# PostHub: agent guide

PostHub is a **locally deployed** social media manager for one owner's accounts on YouTube, LinkedIn,
Facebook, Instagram, TikTok and WordPress. It runs on a Windows machine, should start with the
system, and must publish scheduled posts reliably even when no browser window is open.

## Stack

- **Monorepo:** pnpm workspaces + Turborepo. Node >= 22.18, pnpm 11, Windows is the primary OS.
- **Tooling:** Vite+ (`vp`) does dev, build, pack, lint (Oxlint), format (Oxfmt), type check
  (TypeScript 7 via tsgolint) and test (Vitest 5). Root `vite.config.ts` holds the shared lint/fmt config.
- **Web (`apps/web`):** React 19, TanStack Router (file routes), TanStack Query, TanStack DB, Mantine 9, PWA (vite-plugin-pwa).
- **Server (`apps/server`):** Effect's HTTP server (`effect/http` on `@effect/platform-node`), HttpApi (`effect/http-api`), better-auth.
- **Data:** Drizzle ORM + SQLite (better-sqlite3, native module).
- **Effect:** Effect v4 (`effect` 4.1.x) for all backend logic: connectors, services, the HTTP API and server.

## Layout

```
apps/web/            React PWA
  src/routes/        file-based routes; routeTree.gen.ts is GENERATED, never edit it
  src/collections/   TanStack DB collections (backed by the API client)
  src/components/    post-editor (composer), media (dropzone, library, thumbnails)
  src/lib/platforms.ts  platform labels + publishing rules (mirrors api src/post-rules.ts)
  src/lib/api.ts     API client (`client`) + TanStack Query helpers (`api`); lib/ also has the auth and query clients
  src/providers.tsx  MantineProviders: theme, package CSS, Dates/Modals/Notifications (app + tests)
  src/test/          test setup + renderRoute() helper
apps/server/         HTTP server (Effect)
  src/env.ts         all config/env in one place (paths, port, secret)
  src/index.ts       Layer.launch(server + publisherWorker + apiLayer) under NodeRuntime.runMain
  src/app.ts         appRoutes({ auth }): every route as an HttpRouter layer, used by index.ts and tests
packages/db/         Drizzle schema (src/schema), migrations (drizzle/), createDb, runMigrations
  src/testing.ts     createTestDb(), seedUser() for tests (@posthub/db/testing)
packages/auth/       createAuth(): better-auth config
packages/contract/   web-safe API contract: Effect Schema models, errors, HttpApi groups (src/api.ts),
                     Promise facade + fetchApiClient() used by the web app and tests
packages/api/        HttpApi handlers (routers/<area>.ts, assembled in src/routes.ts), services, publisher
  src/services.ts    Database, MediaDir services; layer.ts has apiLayer() (adds Vault, ProviderApps)
  src/connections.ts beginOAuth/completeOAuth/saveAccounts (platform connect flows, as Effects)
  src/publisher.ts   Publisher service + publisherWorker layer (background publishing, run by the server)
  src/sync.ts        Sync service + syncWorker layer: background reads (post/account metrics) from `sync_job`
  src/comments.ts    comment sync (upsertComments) and the outbox (comment_action) run by the sync worker
  src/accounts.ts    makeCredentialAccess: decrypt, refresh, store tokens, mark expired (publisher + sync)
  src/settings.ts    per-user `app_setting` rows (JSON, vault-encrypted when secret)
  src/media-hosts.ts MediaHosts service: the owner's media host (S3 bucket), read per use
  src/analytics.ts   analytics definitions (gains from snapshot deltas, engagement, buckets) + CSV
  src/queue.ts       posting slots: nextSlotTime() (pure, DST-aware) and findNextSlot(db, ...)
  src/post-rules.ts  what each platform can publish; checked before a post is scheduled
  src/testing.ts     testContext(), sessionFor() for handler tests (@posthub/api/testing)
packages/integrations/  platform connectors: no DB access, injectable fetch
  src/providers/     google (YouTube), meta (Facebook + Instagram), linkedin, wordpress
  src/registry.ts    createIntegrations(config): enabled providers + adapters, PROVIDERS metadata
  src/vault.ts       AES-256-GCM credential encryption
  src/media-host.ts  MediaHost interface + S3-compatible implementation (SigV4 over node:crypto)
  src/testing.ts     createFakeFetch(), tempMedia() (@posthub/integrations/testing)
packages/release/       semver helpers and the `pnpm release` CLI (src/cli.ts)
```

Internal packages ship **TypeScript source** (`exports` point at `.ts`) with no build step. The web
app bundles them via Vite, and the server bundles them with `vp pack` (`deps.alwaysBundle`).

## Commands (run from the repo root)

| Task                              | Command                                |
| --------------------------------- | -------------------------------------- |
| Install                           | `pnpm install`                         |
| Dev (web :5173 + api :4100)       | `pnpm dev`                             |
| Lint + format + type check        | `pnpm check` (fix: `pnpm check:fix`)   |
| Unused files, exports and deps    | `pnpm knip` (config: `knip.jsonc`)     |
| All tests                         | `pnpm test`                            |
| One package's tests               | `pnpm --filter @posthub/api test`      |
| Build                             | `pnpm build`                           |
| Run production build              | `pnpm start` (serves the PWA on :4100) |
| New migration after schema change | `pnpm db:generate`                     |
| Run a TS script                   | `pnpm exec vpx path/to/script.ts`      |
| Cut a release (see Releases)      | `pnpm release minor` (or patch/major)  |

The global `vp` CLI may not be installed, so use `pnpm exec vp ...`. Use `vpx` to run TS files; do
not add `tsx`/`ts-node`. Note that `vp check` is a built-in command and `vp run <name>` runs a script.

**Before finishing any change, run `pnpm check`, `pnpm knip` and `pnpm test`. All must pass.** Fix knip findings by
removing the dead code or dependency; add an ignore to `knip.jsonc` only for genuine false positives, with a comment.

## How requests flow

- In dev, the browser only talks to Vite (:5173), which proxies `/api`, `/rpc` and `/connect` to the server
  (127.0.0.1:4100). Everything is same-origin, so auth cookies need no CORS setup.
- In production, the server serves `apps/web/dist` itself, also same-origin.
- `/api/auth/*` is better-auth. `/rpc/*` is the HttpApi from `@posthub/contract`; its `Authorization` middleware
  resolves the session cookie and provides `CurrentUser`.
- `/analytics/export.csv?from&to[&accountId]` downloads analytics as CSV (session checked; a plain route because the
  typed client only speaks JSON). Dev proxies it too.
- `/files/:id` streams an uploaded media file to its owner (Range supported). Uploads go through the API
  (`media.upload` takes a `File`) and land in the media folder.
- `/connect/:provider/start` and `/connect/:provider/callback` are the platform OAuth redirects (plain HttpRouter
  routes, because they are browser navigations). They finish by redirecting to `/accounts?connected=N` or `?error=...`.

## Conventions

### API (Effect HttpApi)

- Define endpoints in `packages/contract/src/api.ts` (schemas in `domain.ts`), then implement them in
  `packages/api/src/routers/<area>.ts` with `HttpApiBuilder.group` and add the group to `ApiRoutes` (`src/routes.ts`).
- Validate with Effect Schema in the contract. Invalid input becomes a `BadRequest` with the schema's message
  (`InputValidation` middleware), and the typed client also refuses to send it.
- Backend logic is Effect code over the services in `apiLayer` (`Database`, `Vault`, `MediaDir`, `ProviderApps`).
  Yield services when the group is built, and `CurrentUser` inside handlers.
- Groups behind `.middleware(Authorization)` get `CurrentUser`. **Always filter by `CurrentUser.id`** (owner scoping is tested).
- Fail with the contract's errors (`NotFound`, `BadRequest`, `Conflict`, `BadGateway`; helpers in `http-support.ts`).
  Handlers reach the database through `handlerDatabase(database)`: `query((db) => ...)` and `transaction(effect)`;
  failing with an ApiError inside a transaction rolls it back.
- `@posthub/contract` is shipped to the browser: it may depend only on `effect`. Never import server code into it or the web app.
- Strings the server trims (titles, credentials) are validated as non-blank in the contract and trimmed in the handler:
  `Schema.Trim` would make the client reject untrimmed input.

### Database (Drizzle + SQLite)

- Schema lives in `packages/db/src/schema/`. `auth.ts` holds the better-auth tables (keep them in
  sync with better-auth), and `app.ts` holds the domain tables.
- After changing the schema, run `pnpm db:generate` and commit the SQL in `packages/db/drizzle/`.
  Never hand-edit applied migrations. The server applies migrations on every start.
- Timestamps are `integer(..., { mode: 'timestamp_ms' })` and surface as `Date`. The API encodes `Date` as ISO strings (`Schema.Date`).
- IDs are text. Posts use client-generated UUIDs so TanStack DB can insert optimistically.
- DB access happens only in the server/packages, never in the web app.
- Effect code uses the `Database` service (`packages/api/src/services.ts`): `database.use((db) => db.select()...all())`
  runs Drizzle (synchronous on better-sqlite3) and fails with `DatabaseError`; `database.transaction(effect)` commits or
  rolls back. The transaction's effect runs synchronously (one connection, shared with better-auth), so it must not
  wait for anything: do network calls before or after it. If it does wait, it is rolled back and dies. Never call
  `db.transaction` directly.

### Web

- Read data with TanStack DB `useLiveQuery` over a collection. Mutate with `collection.insert/update/delete`;
  the collection's `onInsert/onUpdate/onDelete` handlers persist through the API client.
- For non-collection data, use `api.<group>.<endpoint>.queryOptions()` / `.mutationOptions()` from `src/lib/api.ts`,
  and `api.<group>.key()` to invalidate. Errors are the contract's typed errors, with a user-facing `message`.
- Signed-in pages live under `src/routes/_app/` (the guard is in `_app.tsx`). Use Mantine components; don't add CSS frameworks.
- Installed Mantine extensions: form, dates (+dayjs), schedule (the calendar page), charts (+recharts), notifications,
  modals, tiptap (+StarterKit, Link), dropzone, emoji. Keep every `@mantine/*` on the same version: schedule pins its peers exactly. Their CSS and providers are already wired in `src/providers.tsx`.
  Use `notifications.show()` and `modals.openConfirmModal()` directly.
- Charts use `@mantine/charts`; each platform has a fixed color (`--viz-<platform>` in `src/chart-colors.css`, a
  validated palette with light and dark steps). Load the `dataviz` skill before changing charts.
- Test files sit next to routes and are excluded from routing via `routeFileIgnorePattern` in `vite.config.ts`.

### Connectors (`packages/integrations`)

- A **provider** is a connect flow (`google`, `meta`, `linkedin`, `wordpress`); an **adapter** publishes to one
  platform. One Meta login yields many accounts (each Page plus its linked Instagram account).
- Reading numbers is a separate capability: `InsightsAdapter<C>` (`postMetrics`, optional `accountMetrics`, `scopes` it
  needs), looked up with `integrations.insights(platform)` (undefined for LinkedIn and TikTok). Reads are safe to repeat,
  so every failure there is retried later. A missing metric is `undefined`/null ("not available"), never zero.
- Comments are `EngagementAdapter<C>` (`listComments`, `reply`, `setLike`, `moderate`, `capabilities`, `scopes`), looked
  up with `integrations.engagement(platform)` (files `providers/*-engagement.ts`). The web app reads `Account.engagement`
  (the capabilities) instead of branching on platform names.
- Adapters implement `PlatformAdapter<C>`: `publish(credentials, input)` and optional `refresh(credentials)`, each
  returning an `Effect` that fails with `PublishError` (`PlatformError | TransportError`). They receive decrypted
  credentials and never touch the DB. Callers persist refreshed credentials.
- Fail with `platformError(source, message, { retryable })` (a `Schema.TaggedError`; 429/5xx default to retryable).
  A `TransportError` (network failure) means the outcome is unknown, so it is never retried automatically.
  After the call that creates the post succeeds, **the effect must not fail** (e.g. a permalink lookup): catch
  everything with `Effect.catchCause`, or a retry would post twice.
- Platform calls go through the `Http` helper in `src/http.ts` (Effect's fetch-based `HttpClient`, with tracing
  headers turned off). Use `Clock`/`Effect.sleep` rather than `Date.now()`/timers so tests can use `TestClock`.
- Credentials are encrypted with the vault before storage, and `accounts.list` never selects them.
- **Developer-app credentials** (client id/secret per OAuth provider) are entered on the Accounts page and stored
  vault-encrypted in `provider_app`. The `ProviderApps` service (`packages/api/src/provider-apps.ts`) merges them
  over env values (`apps/server/src/env.ts`, DB wins field by field) and rebuilds the connectors on save, with no restart.
  Read `(yield* ProviderApps).current` for the connectors as configured right now (per use, not once at startup), and
  `save`/`remove` on the same service to change app credentials.
  Secrets are never returned to the client.
- The Accounts page walks the owner through each connect flow (`apps/web/src/lib/setup-guides.tsx`, shown by
  `components/connect-guide.tsx`). When a connector's scopes, products or redirect URLs change, update its guide too.
- API versions are pinned: Meta Graph `v26.0` (`META_GRAPH_VERSION`), LinkedIn `202608` (`LINKEDIN_API_VERSION`).
  LinkedIn retires versions after about a year and returns 426 `NONEXISTENT_VERSION`.
- Test connectors with `createFakeFetch` routes (`"METHOD url-prefix"`, first match wins, so list longer prefixes first).

### Tests

- Import test APIs from `vite-plus/test` (not `vitest`). Tests of Effect code use `@effect/vitest` instead
  (`it.effect`, `Effect.flip` for expected failures, `TestClock` for time); it shares Vite+'s vitest.
- Backend tests: use `createTestDb()` (in-memory SQLite, real migrations) and `seedUser()`. Call
  handlers through `testContext(db, session).api.<group>.<endpoint>(input)` (the full HTTP pipeline, signed in as
  `session`; `ctx.fetch` sends raw requests), or go through the server with `HttpRouter.toWebHandler(appRoutes({ auth }))` (see `apps/server/src/app.test.ts`).
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
- Instagram needs a **public media URL** (`MediaFile.publicUrl`). Adapters with `needsPublicMedia` get their files put on
  the owner's **media host** (Settings page, `app_setting` key `mediaHost`) in the publisher's `upload` phase, under the key
  `<targetId>/<mediaId><ext>`. Each key is recorded in `hosted_media` before the upload and the object is deleted when the
  attempt ends (`sweepHostedMedia` at startup cleans up after a crash). Upload failures back off like platform errors:
  nothing was posted yet. Without a media host, Instagram cannot be scheduled. YouTube needs a video.
  LinkedIn supports text, link, and single-image posts (video comes later).
- **Post lifecycle:** the owner sets `draft` or `scheduled` ("Publish now" means scheduled at now). The publisher moves a
  due post to `publishing`, claims each `pending` target, and the post ends `published`/`failed` based on its targets.
  Posts are editable only while `draft`/`scheduled`. Failed targets are retried with `posts.retry`, and TikTok targets are
  closed with `posts.markPosted`.
- Retryable `PlatformError`s back off (`RETRY_DELAYS_MS`, `next_attempt_at`). A target found `publishing` at startup, or a
  non-`PlatformError` during the publish call, is marked failed for the owner to check. It is never retried automatically.
- `post.body` is HTML from the Tiptap editor (older posts may be plain text). The publisher passes `html` (WordPress) and
  `text` (everyone else) via `bodyFormats()` in `packages/integrations/src/content.ts`. Per-platform images:
  `featuredMediaId` (WordPress, falls back to the first attached image) and `thumbnailMediaId` (YouTube; a failed thumbnail
  is a `PublishResult.warning` stored in `lastError` on a published target, never a retry).
- Images inside the body are `<img src="/files/<media id>">` (see `packages/api/src/inline-media.ts`). The publisher passes
  them as `inlineImages`; the WordPress adapter uploads each and swaps it for an image block in place. Other platforms drop
  them (they only get attached media). `post.wordpressOptions` holds tags (names, created on the site if missing) and
  categories per WordPress account id.
- When changing what an adapter accepts, update `packages/api/src/post-rules.ts` and `apps/web/src/lib/platforms.ts` together.
- **Metrics:** a target that becomes `published` gets a `post_metrics` sync job (inserted in the publisher's finish
  transaction with `insertSyncJob(db, ...)`); each active account has an `account_metrics` job. The sync worker stores
  snapshots (`post_metric_snapshot`, `account_metric_snapshot`) and reschedules by post age (`nextMetricsRun`). A job found
  `running` at startup runs again. When a refresh is rejected the account is marked expired and its jobs `paused`;
  `saveAccounts` resumes them. `social_account.grantedScopes` drives the "reconnect" hint (`Account.reconnectFor`).
  TikTok numbers are typed in by hand (`metrics.setManual`).
- **Comments:** each published target gets a `comments` sync job (every 10 minutes for a day, then like metrics). A sync
  reads up to 10 pages, then upserts them in one transaction; after a complete read, comments missing from it get
  `deletedAt`. Every write (reply, like, hide, delete) goes into `comment_action` first and the sync worker sends it.
  A reply whose outcome is unknown (network failure, found `sending` at startup, or retried by the owner) gets
  `checkFirst`: the worker reads the post's comments and only resends when no own comment with the same text exists.
- **First comment:** `post.firstComment` is posted under the post by the sync worker as its own step
  (`post_target.firstCommentStatus`), so it never fails or reposts the post: the publisher only sets it `pending` in the
  same `finish` update that publishes the target. It follows the reply rules (`firstCommentCheck` before any resend).
  No platform lets apps pin comments: `pinFirstComment` gives the owner a link and steps, and `posts.markPinned` records it.
  Comment rules (length, Instagram's 30 hashtags) live in `firstCommentProblem` (post-rules.ts, mirrored in platforms.ts).
- **Queue:** `queue_slot` rows are weekly wall-clock times in the owner's time zone (`app_setting` key `timezone`, sent by
  the browser when slots are saved). `posts.enqueue` picks the first future slot no scheduled post has, inside one
  synchronous transaction, so concurrent enqueues get different slots.
- Shutdown: Ctrl+C/SIGTERM interrupts the program; the publisher's scope waits for jobs in progress.
- Planned next: LinkedIn video, then a Windows startup/Electron shell.

## Releases

- One version for the whole app, in the root `package.json` (every workspace package is kept in step). It follows
  semver: **major** for breaking changes (e.g. a migration that needs manual steps, removed features, changed
  config), **minor** for new features, **patch** for fixes.
- Release notes live on **GitHub Releases** (there is no CHANGELOG file). They are built from commit subjects and
  merged PRs, so write commit subjects the owner can read ("Add LinkedIn video posts", not "wip"). PR labels
  `breaking`, `enhancement`/`feature` and `bug`/`fix` group the generated notes (`.github/release.yml`).
- `pnpm release <patch|minor|major|x.y.z>` (on a clean `main`; add `--dry-run` to preview) bumps every
  `package.json`, commits `Release vX.Y.Z` and creates the tag. `git push --follow-tags` then triggers
  `.github/workflows/release.yml`, which publishes the GitHub release. Polish the notes there if needed.
- The app shows the version in the sidebar, linking to its GitHub release (`RELEASE_NOTES_URL` in
  `apps/web/src/lib/version.ts`, from `repository.url` in the root `package.json`), and notifies the owner once
  after an update. The server reports the version on `/health`.

## Environment

- `apps/server/.env` (copy from `.env.example`) needs `BETTER_AUTH_SECRET` and `POSTHUB_ENCRYPTION_KEY` (32+ chars each),
  Connector app credentials are optional here (the Accounts page is preferred). Never commit `.env`.
- Data lives in `<repo>/.data/` in dev (`POSTHUB_DATA_DIR` overrides it): `posthub.db` and `media/`.
- Line endings are LF everywhere (`.gitattributes`, `.editorconfig`, Oxfmt `endOfLine`), even with `core.autocrlf=true`.
  An older checkout with CRLF files is fixed by `git rm --cached -r . && git reset --hard` (commit or stash first).
- On Windows, shell `python` may be the Microsoft Store stub and hang, so use Node for scripting.
