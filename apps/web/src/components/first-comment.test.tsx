import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Account, Post, PostTarget } from '@posthub/contract';
import { describe, expect, it } from 'vite-plus/test';
import { MantineProviders } from '../providers';
import type { Platform } from '../lib/platforms';
import { FirstCommentField, FirstCommentStatus, needsPin } from './first-comment';

function Field({ platforms }: { platforms: Platform[] }) {
  const [value, setValue] = useState('');
  const [pin, setPin] = useState(false);
  return (
    <FirstCommentField
      value={value}
      onChange={setValue}
      pin={pin}
      onPinChange={setPin}
      platforms={platforms}
    />
  );
}

describe('first comment field', () => {
  it('offers only a first comment when all selected platforms lack pinning', async () => {
    render(
      <MantineProviders>
        <Field platforms={['wordpress']} />
      </MantineProviders>,
    );
    await userEvent.type(screen.getByLabelText('First comment'), 'Read more');
    expect(screen.queryByRole('switch', { name: /Remind me to pin it/ })).toBeNull();
    expect(screen.getByText('WordPress: WordPress has no pinned comments.')).toBeTruthy();
  });

  it('excludes WordPress targets from pin controls and reminders on a mixed post', () => {
    const target = (id: string): PostTarget => ({
      id,
      postId: 'post',
      socialAccountId: id,
      status: 'published',
      attempts: 1,
      lastError: null,
      externalUrl: `https://example.com/${id}`,
      publishedAt: new Date(),
      nextAttemptAt: null,
      firstCommentStatus: 'posted',
      firstCommentError: null,
      pinnedAt: null,
    });
    const youtube = target('youtube');
    const wordpress = target('wordpress');
    const post: Post = {
      id: 'post',
      userId: 'owner',
      title: 'Hello',
      body: 'Hello',
      link: null,
      featuredMediaId: null,
      thumbnailMediaId: null,
      wordpressOptions: null,
      firstComment: 'Read more',
      pinFirstComment: true,
      status: 'published',
      scheduledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      accountIds: ['youtube', 'wordpress'],
      mediaIds: [],
      targets: [youtube, wordpress],
    };
    const accounts: Account[] = (['youtube', 'wordpress'] as const).map((platform) => ({
      id: platform,
      platform,
      externalId: platform,
      displayName: platform,
      status: 'active',
      tokenExpiresAt: null,
      createdAt: new Date(),
      reconnectFor: [],
      engagement: { reply: true, like: false, hide: true, delete: true },
    }));
    render(
      <MantineProviders>
        <QueryClientProvider client={new QueryClient()}>
          <FirstCommentStatus post={post} accounts={accounts} />
        </QueryClientProvider>
      </MantineProviders>,
    );
    expect(screen.getByRole('link', { name: 'Pin it on YouTube' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Pin it on WordPress' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Mark as pinned' })).toHaveLength(1);
    expect(needsPin(post, wordpress, 'wordpress')).toBe(false);
    expect(needsPin(post, youtube, 'youtube')).toBe(true);
  });

  it('explains per platform how pinning works, and where comments are skipped', async () => {
    render(
      <MantineProviders>
        <Field platforms={['youtube', 'wordpress', 'tiktok']} />
      </MantineProviders>,
    );
    const user = userEvent.setup();
    expect(screen.queryByRole('switch', { name: /Remind me to pin it/ })).toBeNull();
    await user.click(screen.getByLabelText('First comment'));
    await user.paste('Link in bio');
    expect(screen.getByText('Not posted on TikTok.')).toBeTruthy();

    await user.click(screen.getByRole('switch', { name: /Remind me to pin it/ }));
    expect(screen.getByText(/YouTube: Pin it in YouTube Studio/)).toBeTruthy();
    expect(screen.getByText('WordPress: WordPress has no pinned comments.')).toBeTruthy();
  });
});
