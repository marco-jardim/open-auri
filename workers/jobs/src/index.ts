// Entry point of the jobs Worker: cron triggers (daily 00:05 UTC, hourly, every 15 minutes) and the
// access-log queue consumer, both routed through the typed registry in ./jobs/registry.ts.
import { dispatchQueue, dispatchScheduled } from './jobs/registry.ts';

export default {
  async scheduled(controller, env, ctx) {
    await dispatchScheduled(controller, env, ctx);
  },
  async queue(batch, env, ctx) {
    await dispatchQueue(batch, env, ctx);
  },
} satisfies ExportedHandler<Env>;
