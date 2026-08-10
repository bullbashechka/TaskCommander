import { api } from './api';
import { hasLocalRuntimeConfiguration } from './runtime/configuration';

export { api };

const worker: ExportedHandler<Env> = {
  fetch(request, env, context) {
    return api.fetch(request, env, context);
  },
  scheduled(controller, env) {
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
  },
};

export default worker;
