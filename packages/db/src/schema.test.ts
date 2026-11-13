import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vite-plus/test';
import { post, postTarget, socialAccount, user } from './index';
import { createTestDb, seedUser } from './testing';

describe('database schema', () => {
  it('applies migrations and fills defaults', () => {
    const db = createTestDb();
    const owner = seedUser(db);

    const created = db
      .insert(post)
      .values({ id: crypto.randomUUID(), userId: owner.id, title: 'Hello' })
      .returning()
      .get();

    expect(created.status).toBe('draft');
    expect(created.body).toBe('');
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it('enforces one target per post and account', () => {
    const db = createTestDb();
    const owner = seedUser(db);
    const account = db
      .insert(socialAccount)
      .values({
        id: crypto.randomUUID(),
        userId: owner.id,
        platform: 'linkedin',
        externalId: 'urn:li:person:1',
        displayName: 'Me',
      })
      .returning()
      .get();
    const p = db
      .insert(post)
      .values({ id: crypto.randomUUID(), userId: owner.id, title: 'Hi' })
      .returning()
      .get();

    const target = { postId: p.id, socialAccountId: account.id };
    db.insert(postTarget)
      .values({ id: crypto.randomUUID(), ...target })
      .run();
    expect(() =>
      db
        .insert(postTarget)
        .values({ id: crypto.randomUUID(), ...target })
        .run(),
    ).toThrow(/UNIQUE/);
  });

  it('cascades deletes from user to posts', () => {
    const db = createTestDb();
    const owner = seedUser(db);
    db.insert(post).values({ id: crypto.randomUUID(), userId: owner.id, title: 'Bye' }).run();

    db.delete(user).where(eq(user.id, owner.id)).run();

    expect(db.select().from(post).all()).toHaveLength(0);
  });
});
