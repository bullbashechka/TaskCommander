import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { AppBootstrap } from '@/app/app-bootstrap';
import { AppAccessProvider, type AppAccessSnapshot } from '@/app/app-context';
import { router } from '@/app/router';
import { ViewportGuard } from '@/app/viewport-guard';
import '@/styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false },
  },
});

function RoutedApplication({ snapshot }: { snapshot: AppAccessSnapshot }) {
  useEffect(() => {
    void router.invalidate();
  }, [snapshot.accessManagement, snapshot.generation, snapshot.access.permissions]);
  return (
    <AppAccessProvider value={snapshot}>
      <RouterProvider context={{ queryClient, app: snapshot }} router={router} />
    </AppAccessProvider>
  );
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Не найден контейнер приложения.');
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ViewportGuard>
        <AppBootstrap queryClient={queryClient}>
          {(snapshot) => <RoutedApplication snapshot={snapshot} />}
        </AppBootstrap>
      </ViewportGuard>
    </QueryClientProvider>
  </StrictMode>,
);
