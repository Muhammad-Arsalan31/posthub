import { call, ORPCError } from '@orpc/server';
import type { AuthSession } from '@posthub/auth';
import type { Db } from '@posthub/db';
import { createTestDb, seedUser } from '@posthub/db/testing';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { router } from '../index';
import type { Context } from '../procedures';

function sessionFor(u: { id: string; email: string; name: string }): AuthSession {
  const now = new Date();
  return {
    user: { ...u, emailVerified: false, image: null, createdAt: now, updatedAt: now },
    session: {
      id: crypto.randomUUID(),
      token: 'test',
      userId: u.id,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
      updatedAt: now,
    },
  } as AuthSession;
}

describe('posts router', () => {
  let db: Db;
  let ctx: Context;

  beforeEach(() => {
    db = createTestDb();
    ctx = { db, session: sessionFor(seedUser(db)) };
  });

  it('rejects anonymous callers', async () => {
    await expect(
      call(router.posts.list, undefined, { context: { db, session: null } }),
    ).rejects.toSatisfy((e) => e instanceof ORPCError && e.code === 'UNAUTHORIZED');
  });

  it('creates, lists, updates and deletes a post', async () => {
    const id = crypto.randomUUID();
    const created = await call(router.posts.create, { id, title: '  Launch  ' }, { context: ctx });
    expect(created).toMatchObject({ id, title: 'Launch', status: 'draft' });

    expect(await call(router.posts.list, undefined, { context: ctx })).toHaveLength(1);

    const updated = await call(
      router.posts.update,
      { id, changes: { status: 'scheduled', scheduledAt: new Date('2030-01-01') } },
      { context: ctx },
    );
    expect(updated.status).toBe('scheduled');

    await call(router.posts.delete, { id }, { context: ctx });
    expect(await call(router.posts.list, undefined, { context: ctx })).toHaveLength(0);
  });

  it("hides other users' posts", async () => {
    const id = crypto.randomUUID();
    await call(router.posts.create, { id, title: 'Mine' }, { context: ctx });

    const other: Context = { db, session: sessionFor(seedUser(db)) };
    expect(await call(router.posts.list, undefined, { context: other })).toHaveLength(0);
    await expect(
      call(router.posts.update, { id, changes: { title: 'Stolen' } }, { context: other }),
    ).rejects.toSatisfy((e) => e instanceof ORPCError && e.code === 'NOT_FOUND');
  });

  it('validates input', async () => {
    await expect(
      call(router.posts.create, { id: crypto.randomUUID(), title: '' }, { context: ctx }),
    ).rejects.toSatisfy((e) => e instanceof ORPCError && e.code === 'BAD_REQUEST');
  });
});
