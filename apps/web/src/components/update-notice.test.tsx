import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { APP_VERSION, RELEASE_NOTES_URL } from '../lib/version';
import { renderRoute } from '../test/render';

vi.mock('../lib/auth-client', () => ({
  authClient: {
    getSession: vi.fn(async () => ({
      data: { user: { id: 'u1', email: 'owner@example.com' }, session: { id: 's1' } },
      error: null,
    })),
    signOut: vi.fn(),
  },
}));

describe('version and release notes', () => {
  beforeEach(() => localStorage.clear());

  it('links the sidebar version to its GitHub release', async () => {
    renderRoute('/media');
    const link = await screen.findByRole('link', { name: `v${APP_VERSION} · Release notes` });
    expect(link.getAttribute('href')).toBe(RELEASE_NOTES_URL);
    expect(RELEASE_NOTES_URL).toMatch(/^https:\/\/github\.com\/.+\/releases\/tag\/v\d+\.\d+\.\d+$/);
  });

  it('announces an update once', async () => {
    localStorage.setItem('posthub:last-seen-version', '0.0.0-old');
    renderRoute('/media');
    expect(await screen.findByText(`PostHub updated to v${APP_VERSION}`)).toBeTruthy();
    expect(localStorage.getItem('posthub:last-seen-version')).toBe(APP_VERSION);
  });
});
