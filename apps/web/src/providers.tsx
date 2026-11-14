import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/charts/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/tiptap/styles.css';
import '@mantine/dropzone/styles.css';
import '@mantine/emoji/styles.css';
import { createTheme, MantineProvider } from '@mantine/core';
import { DatesProvider } from '@mantine/dates';
import { ModalsProvider } from '@mantine/modals';
import { Notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';

export const theme = createTheme({ primaryColor: 'blue' });

/** Mantine providers shared by the app and tests. */
export function MantineProviders({ children }: { children: ReactNode }) {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <DatesProvider settings={{ firstDayOfWeek: 1 }}>
        <ModalsProvider>
          <Notifications position="top-right" layout="stacked" />
          {children}
        </ModalsProvider>
      </DatesProvider>
    </MantineProvider>
  );
}
