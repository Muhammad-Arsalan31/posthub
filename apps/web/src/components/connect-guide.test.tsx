import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Provider } from '@posthub/contract';
import { describe, expect, it, vi } from 'vite-plus/test';
import { MantineProviders } from '../providers';
import { ConnectGuide, type GuideStart } from './connect-guide';

const meta: Provider = {
  id: 'meta',
  label: 'Facebook & Instagram',
  platforms: ['facebook', 'instagram'],
  kind: 'oauth',
  envVars: [],
  setupUrl: 'https://developers.facebook.com/apps',
  configured: false,
  source: null,
  clientId: null,
};

function renderGuide(provider: Provider, start: GuideStart) {
  render(
    <MantineProviders>
      <QueryClientProvider client={new QueryClient()}>
        <ConnectGuide provider={provider} start={start} onClose={vi.fn()} onChanged={vi.fn()} />
      </QueryClientProvider>
    </MantineProviders>,
  );
}

describe('ConnectGuide', () => {
  it('walks through creating the app, entering its details, preparing and connecting', async () => {
    renderGuide(meta, 'start');

    expect(await screen.findByText('Create a Meta developer app')).toBeTruthy();
    expect(screen.getByText(/\/connect\/meta\/callback$/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText(/App ID/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/Get Instagram ready/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Connect your Pages and Instagram accounts')).toBeTruthy();
    // No app saved yet, so there is nothing to connect with.
    expect(screen.queryByRole('link', { name: /Connect Facebook/ })).toBeNull();
  });

  it('offers the connect link once the app is configured', async () => {
    renderGuide({ ...meta, configured: true, source: 'database', clientId: '123' }, 'connect');

    const link = await screen.findByRole('link', { name: 'Connect Facebook & Instagram' });
    expect(link.getAttribute('href')).toBe('/connect/meta/start');
  });
});
