import { describe, expect, it } from 'vitest';

import { parsePreflightSearch, parseStatusSearch, parseSubjectsSearch } from './router';

describe('status route search', () => {
  it('preserves a supported panel', () => {
    expect(parseStatusSearch({ panel: 'runtime' })).toEqual({ panel: 'runtime' });
  });

  it('normalizes an unsupported panel', () => {
    expect(parseStatusSearch({ panel: 'unknown' })).toEqual({ panel: 'api' });
  });
});

describe('access management route search', () => {
  it('normalizes and bounds selected employee ids', () => {
    const ids = Array.from({ length: 105 }, (_, index) => String(index + 1)).join(',');
    expect(parseSubjectsSearch({ subjects: ids }).subjects.split(',')).toHaveLength(100);
    expect(parseSubjectsSearch({ subjects: '10,,20' })).toEqual({ subjects: '10,20' });
  });

  it('does not coerce invalid preflight values', () => {
    expect(parsePreflightSearch({ preflight: 42 })).toEqual({ preflight: '' });
    expect(parsePreflightSearch({ preflight: 'preflight-id' })).toEqual({
      preflight: '',
    });
    expect(
      parsePreflightSearch({ preflight: '123e4567-e89b-42d3-a456-426614174000' }),
    ).toEqual({ preflight: '123e4567-e89b-42d3-a456-426614174000' });
  });
});
