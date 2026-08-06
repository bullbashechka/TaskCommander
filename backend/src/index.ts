import { api } from './api';

export { api };

export default {
  fetch(request, env, context) {
    return api.fetch(request, env, context);
  },
} satisfies ExportedHandler;
