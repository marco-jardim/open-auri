// Consumer of ACCESS_LOG_QUEUE (Marco Civil art. 15 access log; plan §3.8 and T3.3 item 7).
//
// Each message is an encrypted record from the web Worker (web/src/lib/server/security/
// access-log.ts). The consumer opens it, groups the batch by UTC hour (S6 records: by day only),
// encrypts each group (./access-log-crypto.js, AES-256-GCM, key id in the header for rotation) and
// writes `access-log/YYYY/MM/DD/HH-<id>.ndjson.enc` (S6: `.../DD/s6-<id>.ndjson.enc`) to MEDIA,
// then indexes the object in D1 (`access_log_objects`) for the operator tool. The bucket's
// lifecycle rule deletes `access-log/` after 180 days; access-log-retention.ts is the backstop.
//
// S6: the stored timestamp is the day only and the lines are shuffled; the producer already sent
// the message with a random delay, so the object's write time does not reveal the request time.
//
// Ack/retry: a group's messages are acknowledged only after its object and index row are written;
// on an R2 or D1 failure they are retried with a delay (the object id is derived from the message
// ids, so a retried group overwrites the same object instead of duplicating it). Messages that
// cannot be opened (unknown key id, tampering, malformed) are retried and end in the dead-letter
// queue, never silently dropped. Logs carry counts and error codes only.
import { AccessLogCryptoError, createAccessLogCrypto } from './access-log-crypto.js';
import type { AccessLogCrypto } from './access-log-crypto.js';
import type { QueueJob } from './registry.ts';

export const OBJECT_PREFIX = 'access-log/';
export const S6_GROUP = 's6';
const RETRY_DELAY_SECONDS = 60;

/** Record as produced by the web Worker. */
export interface AccessRecord {
  v: 1;
  ts: number;
  ip: string;
  port: number | null;
  user_id: string | null;
  route_group: string;
  status: number;
}

/** One NDJSON line of a stored object. `ts` is ISO 8601 UTC, or `YYYY-MM-DD` for S6. */
export interface StoredLine {
  ts: string;
  ip: string;
  port: number | null;
  user_id: string | null;
  route_group: string;
  status: number;
}

export interface Bucket {
  day: string;
  /** UTC hour, or `null` for day-only (S6) batches. */
  hour: number | null;
}

export function parseRecord(value: unknown): AccessRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { v, ts, ip, port, user_id: userId, route_group: group, status } = record;
  if (v !== 1) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return null;
  if (typeof ip !== 'string' || ip.length === 0 || ip.length > 64) return null;
  if (port !== null && (typeof port !== 'number' || !Number.isInteger(port))) return null;
  if (userId !== null && typeof userId !== 'string') return null;
  if (typeof group !== 'string' || group.length === 0 || group.length > 128) return null;
  if (typeof status !== 'number' || !Number.isInteger(status)) return null;
  return { v, ts, ip, port, user_id: userId, route_group: group, status };
}

export function bucketOf(record: AccessRecord): Bucket {
  const iso = new Date(record.ts).toISOString();
  const day = iso.slice(0, 10);
  return record.route_group === S6_GROUP
    ? { day, hour: null }
    : { day, hour: Number(iso.slice(11, 13)) };
}

export function toStoredLine(record: AccessRecord): StoredLine {
  const s6 = record.route_group === S6_GROUP;
  return {
    ts: s6 ? new Date(record.ts).toISOString().slice(0, 10) : new Date(record.ts).toISOString(),
    ip: record.ip,
    port: record.port,
    user_id: s6 ? null : record.user_id,
    route_group: record.route_group,
    status: record.status,
  };
}

export function objectKeyFor(bucket: Bucket, id: string): string {
  const [year, month, day] = bucket.day.split('-');
  const name = bucket.hour === null ? `s6-${id}` : `${String(bucket.hour).padStart(2, '0')}-${id}`;
  return `${OBJECT_PREFIX}${year}/${month}/${day}/${name}.ndjson.enc`;
}

/** Deterministic UUID-shaped id of a group: SHA-256 of its sorted message ids. */
export async function groupId(messageIds: readonly string[]): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode([...messageIds].sort().join('\n')),
    ),
  );
  const hex = [...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0'));
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
}

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const [random = 0] = crypto.getRandomValues(new Uint32Array(1));
    const swap = random % (index + 1);
    const current = items[index] as T;
    items[index] = items[swap] as T;
    items[swap] = current;
  }
  return items;
}

export function renderNdjson(bucket: Bucket, records: readonly AccessRecord[]): string {
  const lines = records.map(toStoredLine);
  if (bucket.hour === null) shuffle(lines);
  else lines.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
}

const cryptoCache = new Map<string, AccessLogCrypto>();

function cryptoFor(secret: string): AccessLogCrypto {
  let instance = cryptoCache.get(secret);
  if (!instance) {
    instance = createAccessLogCrypto(secret);
    cryptoCache.clear();
    cryptoCache.set(secret, instance);
  }
  return instance;
}

export interface ConsumeResult {
  objects: number;
  records: number;
  undecodable: number;
  failedGroups: number;
}

export async function consumeAccessLog(
  batch: MessageBatch<unknown>,
  env: { MEDIA: Pick<R2Bucket, 'put'>; DB: D1Database; ACCESS_LOG_KEY: string },
): Promise<ConsumeResult> {
  // A missing or malformed keyring throws here: the whole batch is retried.
  const cipher = cryptoFor(env.ACCESS_LOG_KEY);
  const groups = new Map<
    string,
    { bucket: Bucket; items: { message: Message<unknown>; record: AccessRecord }[] }
  >();
  const result: ConsumeResult = { objects: 0, records: 0, undecodable: 0, failedGroups: 0 };
  const codes = new Set<string>();

  for (const message of batch.messages) {
    let record: AccessRecord | null = null;
    try {
      record = parseRecord(await cipher.openMessage(message.body));
      if (!record) codes.add('record');
    } catch (error) {
      codes.add(error instanceof AccessLogCryptoError ? error.code : 'unknown');
    }
    if (!record) {
      result.undecodable += 1;
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      continue;
    }
    const bucket = bucketOf(record);
    const id = `${bucket.day}/${bucket.hour ?? 's6'}`;
    const group = groups.get(id) ?? { bucket, items: [] };
    group.items.push({ message, record });
    groups.set(id, group);
  }

  for (const { bucket, items } of groups.values()) {
    try {
      const key = objectKeyFor(bucket, await groupId(items.map(({ message }) => message.id)));
      const plaintext = new TextEncoder().encode(
        renderNdjson(
          bucket,
          items.map(({ record }) => record),
        ),
      );
      const body = await cipher.sealObject(key, plaintext);
      await env.MEDIA.put(key, body, {
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { format: 'oal1', kid: cipher.currentKid },
      });
      await env.DB.prepare(
        'INSERT OR REPLACE INTO access_log_objects (object_key, day, hour, key_id) VALUES (?, ?, ?, ?)',
      )
        .bind(key, bucket.day, bucket.hour, cipher.currentKid)
        .run();
      for (const { message } of items) message.ack();
      result.objects += 1;
      result.records += items.length;
    } catch {
      codes.add('write');
      result.failedGroups += 1;
      for (const { message } of items) message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }

  const level = result.undecodable || result.failedGroups ? 'error' : 'log';
  console[level](JSON.stringify({ event: 'job.access_log', ...result, codes: [...codes].sort() }));
  return result;
}

export const accessLogConsumerJob: QueueJob = {
  name: 'access-log-consumer',
  async run(batch, env) {
    await consumeAccessLog(batch, env);
  },
};
