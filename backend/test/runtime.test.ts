import {
  createExecutionContext,
  createScheduledController,
  env,
  SELF,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from '../src/index';

describe('local runtime probe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a local probe request', async () => {
    const response = await SELF.fetch('https://example.test/api/_runtime/probe', {
      method: 'POST',
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      messageId: expect.any(String),
      artifactKey: expect.stringMatching(/^v1\/runtime-probe\/json\/.+\.json$/),
    });
  });

  it('keeps Queue consumption out of the API Worker', () => {
    expect((worker as ExportedHandler).queue).toBeUndefined();
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

    await worker.scheduled!(createScheduledController(), {} as Env, context);
    await waitOnExecutionContext(context);

    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: 'runtime_cron_probe_configuration_error' }));
  });
});
