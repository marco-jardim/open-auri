// Daily S6 aggregation (T4.9): reads every anonymous preference pair (keyset pages of the web
// repository's `listS6Pairs`), runs Bradley–Terry (MM iteration, largest strongly connected
// component only) and publishes the "Comunidade prefere" JSON to R2 MEDIA at
// `s6/preferences.json`, served by `GET /api/v1/s6/preferences`.
//
// The logic is the web's (`web/src/lib/server/social/s6.ts`), imported by relative path; its own
// `#lib/*` imports resolve through web/package.json "imports" (nearest package.json of the
// importing file). Registered in the daily cron by T4.12, not here.
//
// Logs carry counts and timings only: no curve id, no day, no receipt.
import { aggregate, S6_PREFERENCES_KEY } from '../../../../web/src/lib/server/social/s6.ts';
import type { ScheduledJob } from './registry.ts';

export const S6_CACHE_CONTROL = 'public, max-age=300';

export interface S6AggregateResult {
  pairs: number;
  items: number;
  bytes: number;
}

/** Aggregates and writes the public JSON; returns counts for the log line. */
export async function publishS6Preferences(
  db: D1Database,
  media: Pick<R2Bucket, 'put'>,
  now: Date,
): Promise<S6AggregateResult> {
  const preferences = await aggregate(db, now);
  const body = JSON.stringify(preferences);
  await media.put(S6_PREFERENCES_KEY, body, {
    httpMetadata: { contentType: 'application/json', cacheControl: S6_CACHE_CONTROL },
  });
  return {
    pairs: preferences.pairs,
    items: preferences.items.length,
    bytes: new TextEncoder().encode(body).byteLength,
  };
}

export const s6AggregateJob: ScheduledJob = {
  name: 's6-aggregate',
  async run(controller, env) {
    const started = Date.now();
    const result = await publishS6Preferences(
      env.DB,
      env.MEDIA,
      new Date(controller.scheduledTime),
    );
    console.log(
      JSON.stringify({
        event: 'job.s6_aggregate',
        pairs: result.pairs,
        items: result.items,
        bytes: result.bytes,
        ms: Date.now() - started,
      }),
    );
  },
};
