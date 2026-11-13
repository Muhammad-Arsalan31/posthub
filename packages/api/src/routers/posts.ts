import { ORPCError } from '@orpc/server';
import { post, POST_STATUSES } from '@posthub/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { protectedProcedure } from '../procedures';

const postFields = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(''),
  status: z.enum(POST_STATUSES).default('draft'),
  scheduledAt: z.date().nullable().default(null),
});

export const postsRouter = {
  list: protectedProcedure.handler(({ context }) =>
    context.db
      .select()
      .from(post)
      .where(eq(post.userId, context.user.id))
      .orderBy(desc(post.createdAt)),
  ),

  // Client supplies the id so TanStack DB can insert optimistically.
  create: protectedProcedure
    .input(postFields.extend({ id: z.uuid() }))
    .handler(async ({ context, input }) => {
      const [created] = await context.db
        .insert(post)
        .values({ ...input, userId: context.user.id })
        .returning();
      return created!;
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string(), changes: postFields.partial() }))
    .handler(async ({ context, input }) => {
      const [updated] = await context.db
        .update(post)
        .set(input.changes)
        .where(and(eq(post.id, input.id), eq(post.userId, context.user.id)))
        .returning();
      if (!updated) throw new ORPCError('NOT_FOUND');
      return updated;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ context, input }) => {
      await context.db
        .delete(post)
        .where(and(eq(post.id, input.id), eq(post.userId, context.user.id)));
      return { id: input.id };
    }),
};
