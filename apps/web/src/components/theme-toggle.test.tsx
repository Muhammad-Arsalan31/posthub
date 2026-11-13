import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vite-plus/test';
import { MantineProviders } from '../providers';
import { ThemeToggle } from './theme-toggle';

describe('ThemeToggle', () => {
  it('flips between light and dark', async () => {
    localStorage.removeItem('mantine-color-scheme-value');
    render(
      <MantineProviders>
        <ThemeToggle />
      </MantineProviders>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark');
    expect(localStorage.getItem('mantine-color-scheme-value')).toBe('dark');

    fireEvent.click(await screen.findByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('light');
  });
});
