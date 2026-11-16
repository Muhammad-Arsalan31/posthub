import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { MediaItem } from '../../lib/platforms';
import { renderRoute } from '../../test/render';

const mocks = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));

vi.mock('../../lib/auth-client', () => ({
  authClient: {
    getSession: async () => ({ data: { user: { email: 'owner@example.com' } } }),
  },
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  return {
    ...original,
    client: { ...original.client, media: { ...original.client.media, delete: mocks.remove } },
    api: {
      ...original.api,
      media: {
        ...original.api.media,
        list: {
          ...original.api.media.list,
          queryOptions: () => ({ queryKey: original.api.media.list.key(), queryFn: mocks.list }),
        },
      },
    },
  };
});

const files: MediaItem[] = ['first', 'second', 'third'].map((name) => ({
  id: name,
  fileName: `${name}.png`,
  mimeType: 'image/png',
  sizeBytes: 100,
  width: null,
  height: null,
  durationMs: null,
  createdAt: new Date('2026-11-01'),
}));

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue(files);
  mocks.remove.mockReset().mockImplementation(async ({ id }: { id: string }) => {
    mocks.list.mockResolvedValue(files.filter((file) => file.id !== id));
    return { id };
  });
});

describe('media selection', () => {
  it('selects all, clears all, and confirms before deleting only selected files', async () => {
    const user = userEvent.setup();
    await renderRoute('/media');
    const all = await screen.findByRole('checkbox', { name: 'Select all' });
    await user.click(all);
    expect(screen.getByText('3 selected')).toBeTruthy();
    await user.click(all);
    expect(screen.getByText('0 selected')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Select first.png' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select third.png' }));
    expect((all as HTMLInputElement).indeterminate).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Delete selected (2)' }));
    expect(mocks.remove).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Delete 2 files?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2));
    expect(mocks.remove).toHaveBeenCalledWith({ id: 'first' });
    expect(mocks.remove).toHaveBeenCalledWith({ id: 'third' });
  });

  it('preserves failed selections and continues deleting the remaining files', async () => {
    const user = userEvent.setup();
    mocks.remove.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'second') throw new Error('This file is used by a scheduled post.');
      mocks.list.mockResolvedValue(files.filter((file) => file.id === 'second'));
      return { id };
    });
    await renderRoute('/media');
    await user.click(await screen.findByRole('checkbox', { name: 'Select all' }));
    await user.click(screen.getByRole('button', { name: 'Delete selected (3)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete 3 files?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(3));
    expect(await screen.findByText('1 selected')).toBeTruthy();
    expect(
      (screen.getByRole('checkbox', { name: 'Select second.png' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      await screen.findByText(/second.png: This file is used by a scheduled post/),
    ).toBeTruthy();
  });
});
