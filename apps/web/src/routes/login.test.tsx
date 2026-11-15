import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vite-plus/test';
import { renderRoute } from '../test/render';

vi.mock('../lib/auth-client', () => ({
  authClient: {
    getSession: vi.fn(async () => ({ data: null, error: null })),
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
  },
}));

describe('auth guard', () => {
  it('redirects signed-out users to /login', async () => {
    const { router } = await renderRoute('/');

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });

  it('shows the name field when creating an account', async () => {
    await renderRoute('/login');
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByLabelText(/Name/)).toBeNull();

    await userEvent.click(screen.getByText('Create account'));

    expect(await screen.findByLabelText(/Name/)).toBeTruthy();
  });
});
