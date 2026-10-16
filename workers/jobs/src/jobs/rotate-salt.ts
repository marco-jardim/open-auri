// Daily rotation of the IP-hash salt (plan §3.8, T3.3 item 3). Format shared with
// web/src/lib/server/security/iphash.ts: KV CONFIG key `salt:YYYY-MM-DD` (UTC day), value =
// base64url of 32 random bytes, absolute expiration 3 days after the day starts.
//
// Each run (cron 00:05 UTC) makes sure today's and tomorrow's salts exist, so the web Worker
// almost never has to create one (which avoids the creation race described in iphash.ts), and
// deletes every salt older than yesterday: once a salt is gone, no hash computed with it can be
// recomputed, even with the pepper. Worst case a salt lives until the end of the day after next
// (≤ 48 h after its day ends), the same bound as its KV expiration.
import { isDay, utcDay } from './dates.ts';
import type { ScheduledJob } from './registry.ts';

export const SALT_PREFIX = 'salt:';
export const SALT_BYTES = 32;
export const SALT_TTL_DAYS = 3;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function saltExpiration(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + SALT_TTL_DAYS * 86_400;
}

export interface RotationResult {
  created: string[];
  deleted: string[];
}

export async function rotateSalts(
  kv: Pick<KVNamespace, 'get' | 'put' | 'delete' | 'list'>,
  now: Date,
): Promise<RotationResult> {
  const created: string[] = [];
  for (const day of [utcDay(now), utcDay(now, 1)]) {
    const key = `${SALT_PREFIX}${day}`;
    if ((await kv.get(key, 'text')) !== null) continue;
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    await kv.put(key, toBase64Url(salt), { expiration: saltExpiration(day) });
    created.push(day);
  }

  const yesterday = utcDay(now, -1);
  const deleted: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: SALT_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const { name } of page.keys) {
      const day = name.slice(SALT_PREFIX.length);
      if (!isDay(day) || day < yesterday) {
        await kv.delete(name);
        deleted.push(day);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { created, deleted };
}

export const rotateSaltJob: ScheduledJob = {
  name: 'rotate-salt',
  async run(controller, env) {
    const result = await rotateSalts(env.CONFIG, new Date(controller.scheduledTime));
    console.log(
      JSON.stringify({
        event: 'job.rotate_salt',
        created: result.created.length,
        deleted: result.deleted.length,
      }),
    );
  },
};
