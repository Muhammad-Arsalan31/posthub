// The publishing worker. Jobs live in SQLite (`post_target` rows), so nothing is lost on restart:
//   1. A scheduled post that is due moves to `publishing`.
//   2. Each of its `pending` targets is claimed (status `publishing`, attempts + 1), published through
//      its platform adapter, and recorded as `published`, `pending` (retry later) or `failed`.
//   3. The post's status is recomputed from its targets.
// A target found in `publishing` at startup was interrupted mid-call: it may or may not have gone out,
// so it is marked failed for the owner to check instead of being retried (posts never duplicate).
import { join } from 'node:path';
import {
  mediaAsset,
  post,
  postMedia,
  postTarget,
  socialAccount,
  type Db,
  type PostStatus,
  type TargetStatus,
} from '@posthub/db';
import {
  bodyFormats,
  PlatformError,
  PROVIDERS,
  refreshIfExpiring,
  type Integrations,
  type MediaFile,
  type Vault,
} from '@posthub/integrations';
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm';
import { inlineMediaIds, inlineRef } from './inline-media';

/** Waits before retry 1, 2 and 3 of a retryable failure (429, 5xx, still processing). */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

export const INTERRUPTED_MESSAGE =
  'PostHub stopped while this was publishing. Check the platform to see whether it went out, then retry if it did not.';

type Executor = Pick<Db, 'select' | 'update'>;

/** A started post's status, from its targets. Manual handoffs (TikTok) don't hold a post open. */
export function summarizeTargets(statuses: TargetStatus[]): PostStatus {
  if (statuses.some((s) => s === 'pending' || s === 'publishing')) return 'publishing';
  if (statuses.some((s) => s === 'failed')) return 'failed';
  return 'published';
}

export function refreshPostStatus(db: Executor, postId: string) {
  const statuses = db
    .select({ status: postTarget.status })
    .from(postTarget)
    .where(eq(postTarget.postId, postId))
    .all()
    .map((t) => t.status);
  db.update(post)
    .set({ status: summarizeTargets(statuses) })
    .where(eq(post.id, postId))
    .run();
}

export interface PublisherOptions {
  db: Db;
  vault: Vault;
  /** Current connectors; read per job so app credentials saved in the UI apply right away. */
  integrations: () => Integrations;
  mediaDir: string;
  /** Targets published at the same time. */
  concurrency?: number;
  now?: () => Date;
  log?: Pick<Console, 'error' | 'info'>;
}

type ClaimedTarget = typeof postTarget.$inferSelect;

export function createPublisher({
  db,
  vault,
  integrations,
  mediaDir,
  concurrency = 2,
  now = () => new Date(),
  log = console,
}: PublisherOptions) {
  const inFlight = new Set<Promise<void>>();
  let timer: ReturnType<typeof setInterval> | undefined;

  /** Marks targets left `publishing` by a crash or shutdown as failed. Returns how many. */
  function recover() {
    const stuck = db
      .select({ id: postTarget.id, postId: postTarget.postId })
      .from(postTarget)
      .where(eq(postTarget.status, 'publishing'))
      .all();
    if (!stuck.length) return 0;
    db.transaction((tx) => {
      for (const target of stuck) {
        tx.update(postTarget)
          .set({ status: 'failed', lockedAt: null, lastError: INTERRUPTED_MESSAGE })
          .where(eq(postTarget.id, target.id))
          .run();
      }
      for (const postId of new Set(stuck.map((t) => t.postId))) refreshPostStatus(tx, postId);
    });
    return stuck.length;
  }

  function startDuePosts(at: Date) {
    const due = db
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.status, 'scheduled'), lte(post.scheduledAt, at)))
      .all();
    for (const { id } of due) refreshPostStatus(db, id);
  }

  /** Atomically takes the next due target, or returns null when there is none. */
  function claimNext(at: Date): ClaimedTarget | null {
    return db.transaction((tx) => {
      const next = tx
        .select({ id: postTarget.id })
        .from(postTarget)
        .innerJoin(post, eq(post.id, postTarget.postId))
        .where(
          and(
            eq(post.status, 'publishing'),
            eq(postTarget.status, 'pending'),
            or(isNull(postTarget.nextAttemptAt), lte(postTarget.nextAttemptAt, at)),
          ),
        )
        .orderBy(asc(post.scheduledAt), asc(postTarget.createdAt))
        .limit(1)
        .get();
      if (!next) return null;
      const claimed = tx.select().from(postTarget).where(eq(postTarget.id, next.id)).get()!;
      tx.update(postTarget)
        .set({ status: 'publishing', lockedAt: at, attempts: claimed.attempts + 1 })
        .where(eq(postTarget.id, next.id))
        .run();
      return { ...claimed, status: 'publishing' as const, attempts: claimed.attempts + 1 };
    });
  }

  /** One of the post owner's media files, or undefined. */
  function mediaFile(mediaId: string | null, userId: string): MediaFile | undefined {
    if (!mediaId) return undefined;
    const row = db
      .select()
      .from(mediaAsset)
      .where(and(eq(mediaAsset.id, mediaId), eq(mediaAsset.userId, userId)))
      .get();
    if (!row) return undefined;
    return {
      path: join(mediaDir, row.storagePath),
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    };
  }

  function loadMedia(postId: string): MediaFile[] {
    return db
      .select({
        storagePath: mediaAsset.storagePath,
        fileName: mediaAsset.fileName,
        mimeType: mediaAsset.mimeType,
        sizeBytes: mediaAsset.sizeBytes,
      })
      .from(postMedia)
      .innerJoin(mediaAsset, eq(mediaAsset.id, postMedia.mediaId))
      .where(eq(postMedia.postId, postId))
      .orderBy(asc(postMedia.position))
      .all()
      .map(({ storagePath, ...file }) => ({ ...file, path: join(mediaDir, storagePath) }));
  }

  function finish(target: ClaimedTarget, changes: Partial<typeof postTarget.$inferInsert>) {
    db.transaction((tx) => {
      tx.update(postTarget)
        .set({ lockedAt: null, ...changes })
        .where(eq(postTarget.id, target.id))
        .run();
      refreshPostStatus(tx, target.postId);
    });
  }

  async function publishTarget(target: ClaimedTarget) {
    let phase: 'prepare' | 'refresh' | 'publish' = 'prepare';
    let platform = 'platform';
    try {
      const account = db
        .select()
        .from(socialAccount)
        .where(eq(socialAccount.id, target.socialAccountId))
        .get();
      const content = db.select().from(post).where(eq(post.id, target.postId)).get();
      if (!account || !content)
        return finish(target, {
          status: 'failed',
          lastError: 'The post or account no longer exists.',
        });
      platform = account.platform;

      if (account.status !== 'active' || !account.credentials) {
        throw new PlatformError(
          platform,
          'Reconnect this account on the Accounts page, then retry.',
          {
            retryable: false,
          },
        );
      }
      const adapter = integrations().adapter(account.platform);
      if (!adapter) {
        const label =
          PROVIDERS.find((p) => p.platforms.includes(account.platform))?.label ?? platform;
        throw new PlatformError(
          platform,
          `${label} is not set up. Add its app credentials on the Accounts page, then retry.`,
          { retryable: false },
        );
      }

      phase = 'refresh';
      let credentials = vault.decrypt(account.credentials);
      const refreshed = await refreshIfExpiring(
        adapter,
        credentials,
        account.tokenExpiresAt,
        now().getTime(),
      );
      if (refreshed) {
        credentials = refreshed.credentials;
        db.update(socialAccount)
          .set({
            credentials: vault.encrypt(refreshed.credentials),
            tokenExpiresAt: refreshed.tokenExpiresAt,
          })
          .where(eq(socialAccount.id, account.id))
          .run();
      }

      phase = 'publish';
      const body = bodyFormats(content.body);
      const result = await adapter.publish(credentials, {
        title: content.title,
        text: target.captionOverride ?? body.text,
        html: body.html,
        link: content.link ?? undefined,
        media: loadMedia(content.id),
        featuredImage: mediaFile(content.featuredMediaId, content.userId),
        thumbnail: mediaFile(content.thumbnailMediaId, content.userId),
        inlineImages: inlineMediaIds(content.body).flatMap((mediaId) => {
          const file = mediaFile(mediaId, content.userId);
          return file ? [{ ref: inlineRef(mediaId), file }] : [];
        }),
        wordpress: content.wordpressOptions
          ? {
              tags: content.wordpressOptions.tags,
              categoryIds: content.wordpressOptions.categories[account.id] ?? [],
            }
          : undefined,
      });
      finish(target, {
        status: 'published',
        externalPostId: result.externalId,
        externalUrl: result.url ?? null,
        publishedAt: now(),
        // Kept on published targets so the owner sees partial problems (e.g. no thumbnail).
        lastError: result.warning ?? null,
        nextAttemptAt: null,
      });
      log.info(`[publisher] published ${target.id} to ${platform}`);
    } catch (error) {
      recordFailure(target, error, phase, platform);
    }
  }

  function recordFailure(target: ClaimedTarget, error: unknown, phase: string, platform: string) {
    if (error instanceof PlatformError) {
      const delay = RETRY_DELAYS_MS[target.attempts - 1];
      if (error.retryable && delay !== undefined) {
        finish(target, {
          status: 'pending',
          lastError: error.message,
          nextAttemptAt: new Date(now().getTime() + delay),
        });
        return;
      }
      if (phase === 'refresh' && !error.retryable) {
        // The platform rejected the refresh token: the owner has to reconnect.
        db.update(socialAccount)
          .set({ status: 'expired' })
          .where(eq(socialAccount.id, target.socialAccountId))
          .run();
      }
      finish(target, { status: 'failed', lastError: error.message });
      return;
    }

    log.error(`[publisher] ${target.id} (${platform})`, error);
    const message = error instanceof Error ? error.message : String(error);
    finish(target, {
      status: 'failed',
      // A network failure mid-publish is ambiguous: the platform may have received the post.
      lastError:
        phase === 'publish'
          ? `${message}. PostHub could not confirm whether this was posted; check ${platform} before retrying.`
          : message,
    });
  }

  /** Starts due posts and claims targets up to `concurrency`. Resolves when those jobs finish. */
  function tick() {
    const at = now();
    startDuePosts(at);
    const started: Promise<void>[] = [];
    while (inFlight.size < concurrency) {
      const target = claimNext(at);
      if (!target) break;
      const job = publishTarget(target).finally(() => inFlight.delete(job));
      inFlight.add(job);
      started.push(job);
    }
    return Promise.all(started).then(() => undefined);
  }

  return {
    recover,
    tick,
    /** Recovers interrupted work, then checks for due posts every `intervalMs`. */
    start(intervalMs = 5000) {
      const interrupted = recover();
      if (interrupted) log.info(`[publisher] marked ${interrupted} interrupted target(s) failed`);
      const run = () => {
        tick().catch((error: unknown) => log.error('[publisher]', error));
      };
      run();
      timer = setInterval(run, intervalMs);
    },
    /** Stops polling and waits for jobs in progress. */
    async stop() {
      clearInterval(timer);
      await Promise.all(inFlight);
    },
  };
}

export type Publisher = ReturnType<typeof createPublisher>;
