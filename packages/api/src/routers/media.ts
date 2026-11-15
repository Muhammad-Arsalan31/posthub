import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Api, CurrentUser, MAX_UPLOAD_BYTES, type MediaItem } from '@posthub/contract';
import { mediaAsset, post, postMedia } from '@posthub/db';
import { and, desc, eq, inArray, like, or } from 'drizzle-orm';
import { Effect } from 'effect';
import { HttpApiBuilder } from 'effect/http-api';
import { badRequest, conflict, notFound, trySync } from '../http-support';
import { inlineRef } from '../inline-media';
import { Database, MediaDir } from '../services';

export { MAX_UPLOAD_BYTES };

/** Everything except the storage path, which only the server needs. */
export const mediaColumns = {
  id: mediaAsset.id,
  fileName: mediaAsset.fileName,
  mimeType: mediaAsset.mimeType,
  sizeBytes: mediaAsset.sizeBytes,
  width: mediaAsset.width,
  height: mediaAsset.height,
  durationMs: mediaAsset.durationMs,
  createdAt: mediaAsset.createdAt,
};

const isMediaType = (type: string) => type.startsWith('image/') || type.startsWith('video/');

/** A short, safe extension so files open in the right app if someone browses the folder. */
function extensionOf(fileName: string) {
  const ext = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

export const MediaHandlers = HttpApiBuilder.group(Api, 'media', (handlers) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const mediaDir = yield* MediaDir;

    return handlers.handleAll({
      list: () =>
        Effect.flatMap(CurrentUser, (user) =>
          trySync((): MediaItem[] =>
            db
              .select(mediaColumns)
              .from(mediaAsset)
              .where(eq(mediaAsset.userId, user.id))
              .orderBy(desc(mediaAsset.createdAt))
              .all(),
          ),
        ),

      // The multipart parser has already streamed the file to a temp folder (removed afterwards).
      upload: ({ payload: { file } }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const { size } = yield* Effect.promise(() => stat(file.path));
          if (size === 0) return yield* badRequest('The file is empty.');
          if (size > MAX_UPLOAD_BYTES) return yield* badRequest('Files can be up to 1 GB.');
          if (!isMediaType(file.contentType)) {
            return yield* badRequest('Only images and videos can be uploaded.');
          }

          const id = randomUUID();
          const storagePath = `${id}${extensionOf(file.name)}`;
          const target = join(mediaDir, storagePath);
          yield* Effect.promise(async () => {
            await mkdir(mediaDir, { recursive: true });
            try {
              await copyFile(file.path, target, constants.COPYFILE_EXCL);
            } catch (error) {
              await rm(target, { force: true });
              throw error;
            }
          });

          return yield* trySync((): MediaItem =>
            db
              .insert(mediaAsset)
              .values({
                id,
                userId: user.id,
                fileName: file.name || storagePath,
                mimeType: file.contentType,
                sizeBytes: size,
                storagePath,
              })
              .returning(mediaColumns)
              .get(),
          );
        }),

      delete: ({ payload: input }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser;
          const asset = yield* trySync(() => {
            const asset = db
              .select()
              .from(mediaAsset)
              .where(and(eq(mediaAsset.id, input.id), eq(mediaAsset.userId, user.id)))
              .get();
            if (!asset) throw notFound();

            // Removing media from a post that is about to publish would change what goes out.
            const pending = inArray(post.status, ['scheduled', 'publishing']);
            const inUse =
              db
                .select({ title: post.title })
                .from(postMedia)
                .innerJoin(post, eq(post.id, postMedia.postId))
                .where(and(eq(postMedia.mediaId, asset.id), pending))
                .get() ??
              db
                .select({ title: post.title })
                .from(post)
                .where(
                  and(
                    or(
                      eq(post.featuredMediaId, asset.id),
                      eq(post.thumbnailMediaId, asset.id),
                      like(post.body, `%"${inlineRef(asset.id)}"%`),
                    ),
                    pending,
                  ),
                )
                .get();
            if (inUse) throw conflict(`This file is used by the scheduled post “${inUse.title}”.`);

            db.transaction((tx) => {
              // Migration 0004 added these references without ON DELETE SET NULL, so clear them here.
              tx.update(post)
                .set({ featuredMediaId: null })
                .where(eq(post.featuredMediaId, asset.id))
                .run();
              tx.update(post)
                .set({ thumbnailMediaId: null })
                .where(eq(post.thumbnailMediaId, asset.id))
                .run();
              tx.delete(mediaAsset).where(eq(mediaAsset.id, asset.id)).run();
            });
            return asset;
          });
          yield* Effect.promise(() => rm(join(mediaDir, asset.storagePath), { force: true }));
          return { id: asset.id };
        }),
    });
  }),
);

/** One of the owner's uploaded files on disk (for `/files/:id`), or null. */
export const findOwnMedia = (userId: string, id: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const mediaDir = yield* MediaDir;
    const asset = db
      .select({ storagePath: mediaAsset.storagePath, mimeType: mediaAsset.mimeType })
      .from(mediaAsset)
      .where(and(eq(mediaAsset.id, id), eq(mediaAsset.userId, userId)))
      .get();
    return asset ? { path: join(mediaDir, asset.storagePath), mimeType: asset.mimeType } : null;
  });
