import { describe, expect, it } from 'vitest';

import { parseStatusSearch } from './router';

describe('status route search', () => {
  it('preserves a supported panel', () => {
    expect(parseStatusSearch({ panel: 'runtime' })).toEqual({ panel: 'runtime' });
  });

  it('normalizes an unsupported panel', () => {
    expect(parseStatusSearch({ panel: 'unknown' })).toEqual({ panel: 'api' });
  });
});
