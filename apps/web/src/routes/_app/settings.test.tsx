import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { renderRoute } from '../../test/render';

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), test: vi.fn() }));

vi.mock('../../lib/auth-client', () => ({
  authClient: {
    getSession: async () => ({ data: { user: { email: 'owner@example.com' } } }),
  },
}));

vi.mock('../../lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/api')>();
  const settings = original.api.settings;
  return {
    ...original,
    api: {
      ...original.api,
      settings: {
        ...settings,
        mediaHost: {
          ...settings.mediaHost,
          queryOptions: () => ({ queryKey: settings.mediaHost.key(), queryFn: mocks.get }),
        },
        saveMediaHost: {
          ...settings.saveMediaHost,
          mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.save }),
        },
        testMediaHost: {
          ...settings.testMediaHost,
          mutationOptions: (options: object) => ({ ...options, mutationFn: mocks.test }),
        },
      },
    },
  };
});

const saved = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'media',
  accessKeyId: 'key-id',
  publicBaseUrl: null,
};

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(null);
  mocks.save.mockReset().mockImplementation(async () => {
    mocks.get.mockResolvedValue(saved);
    return saved;
  });
  mocks.test.mockReset().mockResolvedValue({ ok: true });
});

describe('settings: media host', () => {
  it('saves a new media host', async () => {
    await renderRoute('/settings');
    expect(await screen.findByText('Not set up')).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Endpoint'));
    await user.paste(saved.endpoint);
    await user.click(screen.getByLabelText('Bucket'));
    await user.paste('media');
    await user.click(screen.getByLabelText('Access key ID'));
    await user.paste('key-id');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Required the first time you save')).toBeTruthy();
    expect(mocks.save).not.toHaveBeenCalled();

    await user.click(screen.getByLabelText('Secret access key'));
    await user.paste('secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalled());
    expect(mocks.save.mock.calls[0]![0]).toEqual({ ...saved, secretAccessKey: 'secret' });
    expect(await screen.findByText('Set up')).toBeTruthy();
  });

  it('tests saved settings without asking for the secret again', async () => {
    mocks.get.mockResolvedValue(saved);
    await renderRoute('/settings');
    expect(await screen.findByDisplayValue('key-id')).toBeTruthy();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/It works/)).toBeTruthy();
    expect(mocks.test.mock.calls[0]![0]).toMatchObject({ bucket: 'media', secretAccessKey: '' });
  });
});
