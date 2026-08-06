import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ViewportGuard } from './viewport-guard';

describe('ViewportGuard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the desktop-only notice below the supported width', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    render(
      <ViewportGuard>
        <p>Приложение</p>
      </ViewportGuard>,
    );

    expect(screen.getByRole('heading', { name: 'Нужен экран большего размера' })).not.toBeNull();
    expect(screen.queryByText('Приложение')).toBeNull();
  });
});
