import { useEffect, useState, type ReactNode } from 'react';

import { ru } from '@/locales/ru';

const desktopMediaQuery = '(min-width: 1024px)';
function getDesktopState() {
  return typeof window === 'undefined' || !window.matchMedia
    ? true
    : window.matchMedia(desktopMediaQuery).matches;
}

export function ViewportGuard({ children }: { children: ReactNode }) {
  const [isDesktop, setIsDesktop] = useState(getDesktopState);

  useEffect(() => {
    const mediaQuery = window.matchMedia(desktopMediaQuery);
    const update = () => setIsDesktop(mediaQuery.matches);

    update();
    mediaQuery.addEventListener('change', update);
    return () => {
      mediaQuery.removeEventListener('change', update);
    };
  }, []);

  if (isDesktop) {
    return children;
  }

  return (
    <main className="viewport-notice">
      <section className="max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm">
        <h1 className="text-xl font-semibold">{ru.viewport.title}</h1>
        <p className="mt-2 text-muted-foreground">{ru.viewport.description}</p>
      </section>
    </main>
  );
}
