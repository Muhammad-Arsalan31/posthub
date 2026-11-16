import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vite-plus/test';
import { MantineProviders } from '../providers';
import type { Platform } from '../lib/platforms';
import { FirstCommentField } from './first-comment';

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
