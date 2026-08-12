import { describe, expect, it } from 'vitest';

import {
  getRuntimeReadiness,
  hasLocalIdentityConfiguration,
  hasLocalRuntimeConfiguration,
} from '../src/runtime/configuration';

const validConfiguration = {
  APP_ENV: 'local',
  BITRIX_ADAPTER: 'mock',
  MOCK_LAUNCH_SIGNING_SECRET: 'test-mock-launch-signing-secret-0001',
  SESSION_SIGNING_SECRET: 'test-session-signing-secret-0000001',
};

describe('local identity configuration', () => {
  it('requires the local mock adapter and distinct signing keys', () => {
    const equivalentEncodedSecretA = '\ud800'.repeat(11);
    const equivalentEncodedSecretB = '\ud801'.repeat(11);
    const invalidConfigurations = [
      {},
      { ...validConfiguration, APP_ENV: 'production' },
      { ...validConfiguration, BITRIX_ADAPTER: 'oauth' },
      { ...validConfiguration, MOCK_LAUNCH_SIGNING_SECRET: undefined },
      {
        ...validConfiguration,
        SESSION_SIGNING_SECRET: validConfiguration.MOCK_LAUNCH_SIGNING_SECRET,
      },
      {
        ...validConfiguration,
        MOCK_LAUNCH_SIGNING_SECRET: equivalentEncodedSecretA,
        SESSION_SIGNING_SECRET: equivalentEncodedSecretB,
      },
    ];

    expect(hasLocalIdentityConfiguration(validConfiguration)).toBe(true);
    for (const configuration of invalidConfigurations) {
      expect(hasLocalIdentityConfiguration(configuration)).toBe(false);
      expect(getRuntimeReadiness(configuration).subsystems.bitrix).toBe('invalid_configuration');
    }
  });

  it('measures the minimum signing key length in UTF-8 bytes', () => {
    expect(
      hasLocalIdentityConfiguration({
        ...validConfiguration,
        MOCK_LAUNCH_SIGNING_SECRET: 'a'.repeat(31),
      }),
    ).toBe(false);
    expect(
      hasLocalIdentityConfiguration({
        ...validConfiguration,
        MOCK_LAUNCH_SIGNING_SECRET: 'a'.repeat(32),
      }),
    ).toBe(true);
    expect(
      hasLocalIdentityConfiguration({
        ...validConfiguration,
        MOCK_LAUNCH_SIGNING_SECRET: 'я'.repeat(15),
      }),
    ).toBe(false);
    expect(
      hasLocalIdentityConfiguration({
        ...validConfiguration,
        MOCK_LAUNCH_SIGNING_SECRET: 'я'.repeat(16),
      }),
    ).toBe(true);
  });

  it('keeps baseline runtime and cron readiness independent from identity secrets', () => {
    const baseline = { APP_ENV: 'local', BITRIX_ADAPTER: 'mock' };

    expect(hasLocalRuntimeConfiguration(baseline)).toBe(true);
    expect(hasLocalRuntimeConfiguration({ APP_ENV: 'production', BITRIX_ADAPTER: 'mock' })).toBe(
      false,
    );
    expect(hasLocalRuntimeConfiguration({ APP_ENV: 'local', BITRIX_ADAPTER: 'oauth' })).toBe(false);
    expect(getRuntimeReadiness(baseline).subsystems).toMatchObject({
      runtime: 'ready',
      cron: 'ready',
      bitrix: 'invalid_configuration',
    });
    expect(getRuntimeReadiness({ APP_ENV: 'local', BITRIX_ADAPTER: 'oauth' }).subsystems.cron).toBe(
      'invalid_configuration',
    );
  });

  it('does not expose invalid signing configuration through the health response', () => {
    const response = getRuntimeReadiness({
      ...validConfiguration,
      SESSION_SIGNING_SECRET: 'short-secret',
    });

    expect(JSON.stringify(response)).not.toContain('short-secret');
    expect(response.subsystems.bitrix).toBe('invalid_configuration');
  });
});
