import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ORPCError } from '@orpc/server';
import { mediaAsset, post, postMedia } from '@posthub/db';
import { and, desc, eq, inArray, like, or } from 'drizzle-orm';
import { z } from 'zod';
import { inlineRef } from '../inline-media';
import { protectedProcedure } from '../procedures';

/** Uploads are buffered by the RPC handler, so keep this sensible for a local machine. */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

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

export const mediaRouter = {
  list: protectedProcedure.handler(({ context }) =>
    context.db
      .select(mediaColumns)
      .from(mediaAsset)
      .where(eq(mediaAsset.userId, context.user.id))
      .orderBy(desc(mediaAsset.createdAt)),
  ),

  upload: protectedProcedure
    .input(
      z.object({
        file: z
          .file()
          .min(1, 'The file is empty.')
          .max(MAX_UPLOAD_BYTES, 'Files can be up to 1 GB.')
          .refine((f) => isMediaType(f.type), 'Only images and videos can be uploaded.'),
      }),
    )
    .handler(async ({ context, input }) => {
      const { file } = input;
      const id = randomUUID();
      const storagePath = `${id}${extensionOf(file.name)}`;
      const target = join(context.mediaDir, storagePath);

      await mkdir(context.mediaDir, { recursive: true });
      try {
        await pipeline(
          Readable.fromWeb(file.stream() as WebReadableStream),
          createWriteStream(target, { flags: 'wx' }),
        );
      } catch (error) {
        await rm(target, { force: true });
        throw error;
      }

      const [created] = await context.db
        .insert(mediaAsset)
        .values({
          id,
          userId: context.user.id,
          fileName: file.name || storagePath,
          mimeType: file.type,
          sizeBytes: file.size,
          storagePath,
        })
        .returning(mediaColumns);
      return created!;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ context, input }) => {
      const asset = context.db
        .select()
        .from(mediaAsset)
        .where(and(eq(mediaAsset.id, input.id), eq(mediaAsset.userId, context.user.id)))
        .get();
      if (!asset) throw new ORPCError('NOT_FOUND');

      // Removing media from a post that is about to publish would change what goes out.
      const pending = inArray(post.status, ['scheduled', 'publishing']);
      const inUse =
        context.db
          .select({ title: post.title })
          .from(postMedia)
          .innerJoin(post, eq(post.id, postMedia.postId))
          .where(and(eq(postMedia.mediaId, asset.id), pending))
          .get() ??
        context.db
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
      if (inUse) {
        throw new ORPCError('CONFLICT', {
          message: `This file is used by the scheduled post “${inUse.title}”.`,
        });
      }

      context.db.transaction((tx) => {
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
      await rm(join(context.mediaDir, asset.storagePath), { force: true });
      return { id: asset.id };
    }),
};
