import { Anchor } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect } from 'react';
import { APP_VERSION, RELEASE_NOTES_URL } from '../lib/version';

const STORAGE_KEY = 'posthub:last-seen-version';

/** After the app updates, points the owner at the GitHub release notes once. */
export function UpdateNotice() {
  useEffect(() => {
    let lastSeen: string | null = null;
    try {
      lastSeen = localStorage.getItem(STORAGE_KEY);
      localStorage.setItem(STORAGE_KEY, APP_VERSION);
    } catch {
      return; // Storage blocked: skip the notice.
    }
    // First visit has nothing to compare against.
    if (!lastSeen || lastSeen === APP_VERSION) return;
    notifications.show({
      id: 'app-updated',
      title: `PostHub updated to v${APP_VERSION}`,
      message: (
        <Anchor href={RELEASE_NOTES_URL} target="_blank" rel="noreferrer" size="sm">
          See what&apos;s new
        </Anchor>
      ),
      autoClose: 10_000,
    });
  }, []);
  return null;
}
