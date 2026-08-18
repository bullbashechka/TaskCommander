import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';
import { applySecurityHeaders } from '../src/http/security';

describe('local runtime probe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not expose the local probe through a non-loopback Worker origin', async () => {
    const response = await SELF.fetch('https://example.test/api/_runtime/probe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://example.test',
        'sec-fetch-site': 'same-origin',
        'x-task-commander-probe-token': 'test-runtime-probe-token-0000000001',
      },
      body: '{}',
    });

    expect(response.status).toBe(404);
  });

  it('keeps Queue consumption out of the API Worker', () => {
    expect((worker as ExportedHandler).queue).toBeUndefined();
  });

  it('adds the browser security policy to static assets', async () => {
    const response = applySecurityHeaders(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
      env,
    );

    expect(response.headers.get('content-security-policy')).toContain(
      'frame-ancestors https://portal.bitrix24.ru',
    );
    expect(response.headers.get('content-security-policy')).toContain("style-src-attr 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('registers a scheduled handler for the isolated runtime', () => {
    expect((worker as ExportedHandler).scheduled).toBeTypeOf('function');
  });

  it('runs the cron probe without writing an R2 artifact', async () => {
    const context = createExecutionContext();

    await worker.scheduled!(createScheduledController(), env, context);
    await waitOnExecutionContext(context);

    await expect(env.REPORTS_BUCKET.list()).resolves.toMatchObject({ objects: [] });
  });

  it('skips the cron probe when its base configuration is unavailable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const context = createExecutionContext();

    await worker.scheduled!(createScheduledController(), {} as ApiEnvironment, context);
    await waitOnExecutionContext(context);

    expect(error).toHaveBeenCalledWith(
      JSON.stringify({ event: 'runtime_cron_probe_configuration_error' }),
    );
  });
});
