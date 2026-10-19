// FX4.3 og-sweep job: deletes the R2 OG images whose version is no longer linkable (or whose key or
// card layout is not the current one), keeps the others, is idempotent, bounded per run (pages and
// time, cursor kept in KV between runs) and logs counts only. Runs on the jobs Worker's D1 (web
// migrations), R2 and KV, with the web's repository used for fixtures (same relative import path
// the job uses). Every test seeds its own unique ids and never depends on global counts.
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OG_CARD_VERSION, ogKey } from '../../../web/src/lib/server/og/keys.ts';
import { publishLineage } from '../../../web/src/lib/server/social/repo.ts';
import {
  createOgSweepJob,
  OG_SWEEP_CURSOR_KEY,
  OG_SWEEP_JOB,
  OG_SWEEP_LIMITS,
  ogSweepJob,
  sweepOgImages,
  yoloPublicationOf,
  type OgSweepDeps,
} from '../src/jobs/og-sweep.ts';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function randomCurveId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => BASE32[byte % 32]).join('');
}

async function seedUser(): Promise<string> {
  const id = uid('user');
  const at = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", ' +
      '"username", "displayUsername", "usernameSkeleton", "role", "banned") ' +
      'VALUES (?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?, 0)',
  )
    .bind(id, 'Private Name', `${id}@example.com`, at, at, 'user')
    .run();
  return id;
}

interface Version {
  curveId: string;
  versionId: string;
}

/**
 * A lineage with one version. `yolo`: its curve is YOLO (`gate_yolo = 1`) and the owner's
 * acknowledgement is written in the same batch, as the web's publication path does.
 */
async function publish(
  visibility: 'public' | 'unlisted' | 'private',
  { yolo = false }: { yolo?: boolean } = {},
): Promise<Version> {
  const curveId = randomCurveId();
  const versionId = uid('ver');
  const result = await publishLineage(env.DB, {
    lineageId: uid('lin'),
    ownerUserId: await seedUser(),
    visibility,
    curve: {
      id: curveId,
      s1: `S1-${crypto.randomUUID()}`.padEnd(68, 'x'),
      canonKey: `v1;0;PK,1000,30,100;${curveId}`,
      gateVer: 'v2:test',
      gateOk: !yolo,
      gateYolo: yolo,
      gateReasons: yolo ? ['d7:pk-boost-above-16k'] : [],
      levelDb: -3,
    },
    yoloAck: yolo,
    version: {
      id: versionId,
      name: 'Sweep fixture',
      description: 'OG sweep fixture.',
      license: 'CC-BY-4.0',
      recipe: null,
      lang: 'en-US',
    },
    now: Date.now(),
  });
  if (!result.ok) throw new Error(`publish failed: ${result.code}`);
  return { curveId, versionId };
}

async function putOg(key: string, card: string | null = OG_CARD_VERSION): Promise<void> {
  await env.MEDIA.put(key, PNG, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata: card === null ? { etag: '"legacy"' } : { etag: '"x"', card },
  });
}

async function exists(key: string): Promise<boolean> {
  return (await env.MEDIA.head(key)) !== null;
}

function deps(overrides: Partial<OgSweepDeps> = {}): OgSweepDeps {
  return { media: env.MEDIA, cursors: env.CONFIG, db: env.DB, ...overrides };
}

/** Runs bounded passes until one reaches the end of `og/`. */
async function sweepToEnd(overrides: Partial<OgSweepDeps> = {}): Promise<number> {
  let deleted = 0;
  for (let run = 0; run < 100; run += 1) {
    const result = await sweepOgImages(deps(overrides));
    deleted += result.deleted;
    if (result.done) return deleted;
  }
  throw new Error('the sweep never reached the end of og/');
}

function controller(): ScheduledController {
  return createScheduledController({ cron: '5 0 * * *', scheduledTime: new Date() });
}

beforeEach(async () => {
  await env.CONFIG.delete(OG_SWEEP_CURSOR_KEY);
});

describe('og-sweep job', () => {
  it('is named og-sweep with bounded pages and time per run', () => {
    expect(ogSweepJob.name).toBe('og-sweep');
    expect(OG_SWEEP_JOB).toBe('og-sweep');
    expect(OG_SWEEP_LIMITS.pageSize).toBeGreaterThan(0);
    expect(OG_SWEEP_LIMITS.pageSize).toBeLessThanOrEqual(1000);
    expect(OG_SWEEP_LIMITS.maxPages).toBeGreaterThan(0);
    expect(OG_SWEEP_LIMITS.budgetMs).toBeLessThanOrEqual(60_000);
  });

  it('deletes images no longer linkable or valid, keeps the rest, idempotently', async () => {
    const live = await publish('public');
    const unlisted = await publish('unlisted');
    const hidden = await publish('private');
    const turnedPrivate = await publish('public');
    const legacy = await publish('public');
    const keys = {
      live: ogKey(live.curveId, live.versionId),
      unlisted: ogKey(unlisted.curveId, unlisted.versionId),
      hidden: ogKey(hidden.curveId, hidden.versionId),
      turnedPrivate: ogKey(turnedPrivate.curveId, turnedPrivate.versionId),
      legacy: ogKey(legacy.curveId, legacy.versionId),
      wrongCurve: ogKey(randomCurveId(), live.versionId),
      unknown: ogKey(randomCurveId(), uid('ver')),
      malformed: `og/nested/${uid('junk')}.png`,
    };
    await Promise.all([
      putOg(keys.live),
      putOg(keys.unlisted),
      putOg(keys.hidden),
      putOg(keys.turnedPrivate),
      putOg(keys.legacy, null),
      putOg(keys.wrongCurve),
      putOg(keys.unknown),
      putOg(keys.malformed),
    ]);
    await env.DB.prepare(
      "UPDATE lineages SET visibility = 'private' WHERE id = " +
        '(SELECT lineage_id FROM versions WHERE id = ?)',
    )
      .bind(turnedPrivate.versionId)
      .run();

    expect(await sweepToEnd()).toBeGreaterThanOrEqual(6);
    expect(await exists(keys.live)).toBe(true);
    expect(await exists(keys.unlisted)).toBe(true);
    for (const key of [
      keys.hidden,
      keys.turnedPrivate,
      keys.legacy,
      keys.wrongCurve,
      keys.unknown,
      keys.malformed,
    ]) {
      expect(await exists(key)).toBe(false);
    }
    expect(await env.CONFIG.get(OG_SWEEP_CURSOR_KEY)).toBeNull();

    // A second full pass finds nothing of ours to delete and keeps the linkable images.
    await sweepToEnd();
    expect(await exists(keys.live)).toBe(true);
    expect(await exists(keys.unlisted)).toBe(true);
  });

  it('reads at most maxPages pages per run and resumes from the cursor kept in KV', async () => {
    const keys = Array.from({ length: 5 }, () => ogKey(randomCurveId(), uid('ver')));
    await Promise.all(keys.map((key) => putOg(key)));
    const limits = { pageSize: 2, maxPages: 1, budgetMs: 60_000 };
    const linkable = vi.fn(async () => true);

    const first = await sweepOgImages(deps({ limits, isLinkable: linkable }));
    expect(first.pages).toBe(1);
    expect(first.checked).toBeLessThanOrEqual(2);
    expect(first.done).toBe(false);
    const cursor = await env.CONFIG.get(OG_SWEEP_CURSOR_KEY);
    expect(cursor).toBeTruthy();

    const second = await sweepOgImages(deps({ limits, isLinkable: linkable }));
    expect(second.pages).toBe(1);
    if (!second.done) expect(await env.CONFIG.get(OG_SWEEP_CURSOR_KEY)).not.toBe(cursor);

    // Everything is kept (all linkable); finishing the pass clears the cursor.
    await sweepToEnd({ limits, isLinkable: linkable });
    expect(await env.CONFIG.get(OG_SWEEP_CURSOR_KEY)).toBeNull();
    for (const key of keys) expect(await exists(key)).toBe(true);
    await Promise.all(keys.map((key) => env.MEDIA.delete(key)));
  });

  it('stops between pages once the time budget is spent', async () => {
    const keys = Array.from({ length: 3 }, () => ogKey(randomCurveId(), uid('ver')));
    await Promise.all(keys.map((key) => putOg(key)));
    let calls = 0;
    const clock = () => (calls++ < 2 ? 0 : 1_000_000);
    const result = await sweepOgImages(
      deps({
        limits: { pageSize: 1, maxPages: 50, budgetMs: 1000 },
        isLinkable: async () => true,
        clock,
      }),
    );
    expect(result.pages).toBe(1);
    expect(result.done).toBe(false);
    await Promise.all(keys.map((key) => env.MEDIA.delete(key)));
  });

  it('forgets a cursor that R2 refuses, and still fails the run', async () => {
    await env.CONFIG.put(OG_SWEEP_CURSOR_KEY, 'stale-cursor');
    const failing: OgSweepDeps['media'] = {
      list: async () => Promise.reject(new Error('invalid cursor')),
      delete: async () => undefined,
    };
    await expect(sweepOgImages(deps({ media: failing }))).rejects.toThrow('invalid cursor');
    expect(await env.CONFIG.get(OG_SWEEP_CURSOR_KEY)).toBeNull();
  });

  it('logs one JSON line with counts only (no key, id or user data)', async () => {
    const key = ogKey(randomCurveId(), uid('ver'));
    await putOg(key);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await createOgSweepJob({ isLinkable: async () => false }).run(
      controller(),
      env,
      createExecutionContext(),
    );
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();

    const line = lines.find((text) => text.includes('job.og-sweep'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? '{}') as Record<string, unknown>;
    const fields = ['checked', 'deleted', 'done', 'event', 'ms', 'pages'];
    expect(Object.keys(parsed).sort()).toEqual(fields);
    expect(parsed.deleted).toEqual(expect.any(Number));
    expect(line).not.toContain('og/');
    expect(line).not.toContain('ver-');
  });

  it('keeps the image of an acknowledged YOLO version while YOLO_PUBLICATION is on', async () => {
    const acked = await publish('public', { yolo: true });
    const key = ogKey(acked.curveId, acked.versionId);
    await putOg(key);
    // On: the store serves it (linkable), so every pass keeps it, run after run.
    await sweepToEnd({ yoloPublication: 'on' });
    expect(await exists(key)).toBe(true);
    await sweepToEnd({ yoloPublication: 'on' });
    expect(await exists(key)).toBe(true);
    // Off (the default): the store refuses every YOLO version, so the sweep deletes the image.
    await sweepToEnd();
    expect(await exists(key)).toBe(false);
  });

  it('the scheduled job reads YOLO_PUBLICATION from its env (anything but "on" is off)', async () => {
    const acked = await publish('public', { yolo: true });
    const key = ogKey(acked.curveId, acked.versionId);
    await putOg(key);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const on = { ...env, YOLO_PUBLICATION: 'on' };
      await createOgSweepJob().run(controller(), on, createExecutionContext());
      expect(await exists(key)).toBe(true);
      const odd = { ...env, YOLO_PUBLICATION: 'ON' };
      await createOgSweepJob().run(controller(), odd, createExecutionContext());
      expect(await exists(key)).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it('yoloPublicationOf: only "on" turns the switch on', () => {
    expect(yoloPublicationOf('on')).toBe('on');
    for (const value of ['off', 'ON', '', undefined, null, 1]) {
      expect(yoloPublicationOf(value)).toBe('off');
    }
  });
});
