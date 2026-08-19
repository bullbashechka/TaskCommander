import { dispatchPendingAccessCommands } from './access-management/dispatch';
import { runAutomaticAccessReconciliation } from './access-management/automatic-revocation';
import { api } from './api';
import { hasLocalRuntimeConfiguration } from './runtime/configuration';
import { applySecurityHeaders } from './http/security';

export { api };

const worker: ExportedHandler<ApiEnvironment> = {
  async fetch(request, env, context) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return api.fetch(request, env, context);
    }
    return applySecurityHeaders(await env.ASSETS.fetch(request), env);
  },
  scheduled(controller, env, context) {
    if (!hasLocalRuntimeConfiguration(env)) {
      console.error(JSON.stringify({ event: 'runtime_cron_probe_configuration_error' }));
      return;
    }

    console.info(
      JSON.stringify({
        event: 'runtime_cron_probe',
        scheduledTime: controller.scheduledTime,
      }),
    );
    context.waitUntil(
      Promise.allSettled([
        dispatchPendingAccessCommands(env),
        runAutomaticAccessReconciliation(env),
      ]).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error(
              JSON.stringify({
                event: 'scheduled_access_maintenance_failed',
                errorName: result.reason instanceof Error ? result.reason.name : 'unknown',
              }),
            );
          }
        }
      }),
    );
  },
};

export default worker;
