import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccessLogCrypto } from '../src/jobs/access-log-crypto.js';
import {
  accessLogConsumerJob,
  consumeAccessLog,
  objectKeyFor,
  parseRecord,
  type AccessRecord,
} from '../src/jobs/access-log-consumer.ts';

const cipher = createAccessLogCrypto(env.ACCESS_LOG_KEY);
const KEY_PATTERN =
  /^access-log\/2026\/10\/16\/(\d{2}|s6)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ndjson\.enc$/;

function record(overrides: Partial<AccessRecord> = {}): AccessRecord {
  return {
    v: 1,
    ts: Date.parse('2026-10-16T13:04:05.123Z'),
    ip: '203.0.113.9',
    port: 51234,
    user_id: 'user_1',
    route_group: '/biblioteca',
    status: 200,
    ...overrides,
  };
}

async function messages(records: readonly AccessRecord[]) {
  return Promise.all(
    records.map(async (item, index) => ({
      id: `msg-${index}`,
      timestamp: new Date(),
      attempts: 1,
      body: await cipher.sealMessage(item),
    })),
  );
}

async function listObjects(): Promise<string[]> {
  const page = await env.MEDIA.list({ prefix: 'access-log/' });
  return page.objects.map((object) => object.key).sort();
}

async function readLines(key: string): Promise<Record<string, unknown>[]> {
  const object = await env.MEDIA.get(key);
  if (!object) throw new Error('missing object');
  const plain = await cipher.openObject(key, new Uint8Array(await object.arrayBuffer()));
  return new TextDecoder()
    .decode(plain)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('access-log consumer', () => {
  beforeEach(async () => {
    const keys = await listObjects();
    if (keys.length) await env.MEDIA.delete(keys);
    await env.DB.prepare('DELETE FROM access_log_objects').run();
  });

  it('groups by UTC hour, encrypts each batch and indexes the objects', async () => {
    const batch = createMessageBatch(
      env.ACCESS_LOG_QUEUE_NAME,
      await messages([
        record(),
        record({ ts: Date.parse('2026-10-16T13:59:59.999Z'), user_id: null, status: 404 }),
        record({ ts: Date.parse('2026-10-16T14:00:00.000Z'), ip: '2001:db8::1', port: null }),
      ]),
    );
    const ctx = createExecutionContext();
    await accessLogConsumerJob.run(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(['msg-0', 'msg-1', 'msg-2']);
    expect(result.retryMessages).toEqual([]);

    const keys = await listObjects();
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(KEY_PATTERN);
    const thirteen = keys.find((key) => key.includes('/16/13-')) ?? '';
    const fourteen = keys.find((key) => key.includes('/16/14-')) ?? '';

    expect(await readLines(thirteen)).toEqual([
      {
        ts: '2026-10-16T13:04:05.123Z',
        ip: '203.0.113.9',
        port: 51234,
        user_id: 'user_1',
        route_group: '/biblioteca',
        status: 200,
      },
      {
        ts: '2026-10-16T13:59:59.999Z',
        ip: '203.0.113.9',
        port: 51234,
        user_id: null,
        route_group: '/biblioteca',
        status: 404,
      },
    ]);
    expect((await readLines(fourteen))[0]).toMatchObject({ ip: '2001:db8::1', port: null });

    const rows = await env.DB.prepare(
      'SELECT object_key, day, hour, key_id FROM access_log_objects ORDER BY hour',
    ).all<{ object_key: string; day: string; hour: number | null; key_id: string }>();
    expect(rows.results).toEqual([
      { object_key: thirteen, day: '2026-10-16', hour: 13, key_id: 'k1' },
      { object_key: fourteen, day: '2026-10-16', hour: 14, key_id: 'k1' },
    ]);
  });

  it('stores ciphertext only: no IP or user id in the R2 bytes', async () => {
    const batch = createMessageBatch(env.ACCESS_LOG_QUEUE_NAME, await messages([record()]));
    await accessLogConsumerJob.run(batch, env, createExecutionContext());
    const [key = ''] = await listObjects();
    const object = await env.MEDIA.get(key);
    const bytes = new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0));
    const raw = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
    expect(raw.startsWith('OAL1')).toBe(true);
    expect(raw).not.toContain('203.0.113.9');
    expect(raw).not.toContain('user_1');
  });

  it('keeps only the day for S6 records, without user id, in an s6 object', async () => {
    const batch = createMessageBatch(
      env.ACCESS_LOG_QUEUE_NAME,
      await messages([
        record({ route_group: 's6', user_id: 'should-not-survive' }),
        record({ route_group: 's6', ts: Date.parse('2026-10-16T23:59:00Z') }),
      ]),
    );
    await accessLogConsumerJob.run(batch, env, createExecutionContext());
    const keys = await listObjects();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/\/2026\/10\/16\/s6-/);
    const lines = await readLines(keys[0] ?? '');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.ts).toBe('2026-10-16');
      expect(line.user_id).toBeNull();
      expect(line.route_group).toBe('s6');
    }
    const row = await env.DB.prepare('SELECT hour FROM access_log_objects').first<{
      hour: number | null;
    }>();
    expect(row?.hour).toBeNull();
  });

  it('binds an object to its key: moving it to another hour fails authentication', async () => {
    const plaintext = new TextEncoder().encode('{"ip":"x"}\n');
    const key = objectKeyFor({ day: '2026-10-16', hour: 13 }, 'id');
    const sealed = await cipher.sealObject(key, plaintext);
    expect(new TextDecoder().decode(await cipher.openObject(key, sealed))).toBe('{"ip":"x"}\n');
    const moved = objectKeyFor({ day: '2026-10-16', hour: 12 }, 'id');
    await expect(cipher.openObject(moved, sealed)).rejects.toMatchObject({
      code: 'authentication',
    });
  });

  it('retries undecodable messages (to the DLQ) and acks the rest', async () => {
    const good = await messages([record()]);
    const tampered = await cipher.sealMessage(record());
    // Deliberately malformed bodies: the consumer must reject what the queue type does not allow.
    const malformed = [
      { id: 'bad-1', timestamp: new Date(), attempts: 1, body: { ...tampered, ct: tampered.iv } },
      { id: 'bad-2', timestamp: new Date(), attempts: 1, body: 'plain text' },
      {
        id: 'bad-3',
        timestamp: new Date(),
        attempts: 1,
        body: await cipher.sealMessage({ v: 1, ip: 'missing fields' }),
      },
    ] as unknown as typeof good;
    const batch = createMessageBatch(env.ACCESS_LOG_QUEUE_NAME, [...good, ...malformed]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    await accessLogConsumerJob.run(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(['msg-0']);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(['bad-1', 'bad-2', 'bad-3']);
    const logged = errors.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('job.access_log');
    expect(logged).not.toContain('203.0.113.9');
    errors.mockRestore();
  });

  it('retries the whole group when R2 fails and does not index it', async () => {
    const failingEnv = {
      MEDIA: { put: () => Promise.reject(new Error('r2 down')) },
      DB: env.DB,
      ACCESS_LOG_KEY: env.ACCESS_LOG_KEY,
    };
    const batch = createMessageBatch(
      env.ACCESS_LOG_QUEUE_NAME,
      await messages([record(), record({ status: 500 })]),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = createExecutionContext();
    const outcome = await consumeAccessLog(batch, failingEnv);
    expect(outcome.failedGroups).toBe(1);
    const result = await getQueueResult(batch, ctx);
    errors.mockRestore();
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(['msg-0', 'msg-1']);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM access_log_objects').first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it('writes the same object key when a group is retried (no duplicates)', async () => {
    const items = await messages([record(), record({ status: 201 })]);
    await accessLogConsumerJob.run(
      createMessageBatch(env.ACCESS_LOG_QUEUE_NAME, items),
      env,
      createExecutionContext(),
    );
    await accessLogConsumerJob.run(
      createMessageBatch(env.ACCESS_LOG_QUEUE_NAME, [...items].reverse()),
      env,
      createExecutionContext(),
    );
    expect(await listObjects()).toHaveLength(1);
  });

  it('validates record shape', () => {
    expect(parseRecord(record())).toEqual(record());
    expect(parseRecord({ ...record(), v: 2 })).toBeNull();
    expect(parseRecord({ ...record(), ts: 'yesterday' })).toBeNull();
    expect(parseRecord({ ...record(), port: 1.5 })).toBeNull();
    expect(parseRecord(null)).toBeNull();
  });
});
