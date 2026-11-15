import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { MantineProviders } from '../providers';
import { routeTree } from '../routeTree.gen';

/** Render the real route tree at `path`, with fresh providers. */
export async function renderRoute(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  // Finish auth guards and lazy imports before assertions start their DOM timeout.
  await router.load();

  const result = render(
    <MantineProviders>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MantineProviders>,
  );
  return { ...result, router };
}
