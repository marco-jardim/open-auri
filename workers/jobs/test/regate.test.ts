// T4.12 regate job: re-gates curves cached under another gate version (daily, up to 200 per run),
// logs counts only. Runs on the jobs Worker's D1 (web migrations), with the web's repository used
// for fixtures (same relative import path the job uses).
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { gateForWrite } from 'open-auri/safety';
import { curveId, encodeS1 } from 'open-auri/share';
import { gateVersion, regateStale } from '../../../web/src/lib/server/social/gate.ts';
import {
  getCurve,
  listCurvesWithStaleGate,
  saveCurveGate,
} from '../../../web/src/lib/server/social/repo.ts';
import {
  createRegateJob,
  REGATE_BUDGET_MS,
  REGATE_JOB,
  REGATE_LIMIT,
  regateJob,
  type RegateRunner,
} from '../src/jobs/regate.ts';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A curve cached under an old gate version as accepted; its S1 does not decode. */
async function seedStaleCurve(): Promise<string> {
  const id = Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (byte) => BASE32[byte % 32],
  ).join('');
  const saved = await saveCurveGate(
    env.DB,
    {
      id,
      s1: `S1-${crypto.randomUUID()}`.padEnd(68, 'x'),
      canonKey: `v1;0;PK,1000,30,100;${id}`,
      gateVer: 'v0:stale',
      gateOk: true,
      gateReasons: [],
      levelDb: -3,
    },
    // Oldest first: an early creation time puts it at the head of the stale list.
    1,
  );
  if (!saved.ok) throw new Error(`seed failed: ${saved.code}`);
  return id;
}

type Curve = Parameters<typeof encodeS1>[0];
type Band = Curve['bands'][number];

/** Two random bytes (no modulo: callers mask them to a power-of-two range). */
function bytes(): [number, number] {
  const [a = 0, b = 0] = crypto.getRandomValues(new Uint8Array(2));
  return [a, b];
}

function neutralWith(bands: readonly Band[], preampDb: number): Curve {
  return { bands: NEUTRAL_BANDS.map((neutral, i) => bands[i] ?? neutral) as Band[], preampDb };
}

const YOLO_GAINS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2];

/**
 * A YOLO curve: one small PK boost above 16 kHz (`d7:pk-boost-above-16k`, waivable) with every
 * hard check far inside the limits. Frequency 16200–17223 Hz and gain on a grid: practically
 * unique, every value equally likely.
 */
function yoloCurve(): Curve {
  const [a, b] = bytes();
  const freqHz = 16_200 + (((a << 8) | b) & 1023);
  const gainDb = YOLO_GAINS[b & 7] ?? 1;
  return neutralWith([{ kind: 'PK', freqHz, gainDb, qFactor: 1 }], -7.5);
}

/** A curve every profile refuses: two +12 dB peaks at a 0 dB preamp (`e:output-audible`, hard). */
function hardCurve(): Curve {
  const [a, b] = bytes();
  const peak = (freqHz: number): Band => ({ kind: 'PK', freqHz, gainDb: 12, qFactor: 1 });
  return neutralWith([peak(800 + (a << 3)), peak(3000 + (b << 2))], 0);
}

/** Caches `curve` under an old gate version (as standard, so the re-gate changes its verdict). */
async function seedStale(curve: Curve): Promise<string> {
  const s1 = encodeS1(curve);
  const id = await curveId(s1);
  const saved = await saveCurveGate(
    env.DB,
    {
      id,
      s1,
      canonKey: `regate-runs;${id}`,
      gateVer: 'v0:stale',
      gateOk: true,
      gateReasons: [],
      levelDb: null,
    },
    1,
  );
  if (!saved.ok) throw new Error(`seed failed: ${saved.code}`);
  return id;
}

function controllerAt(scheduledTime: number): ScheduledController {
  return createScheduledController({ cron: '5 0 * * *', scheduledTime: new Date(scheduledTime) });
}

describe('regate job', () => {
  it('is named regate and re-gates up to 200 curves per run', () => {
    expect(regateJob.name).toBe('regate');
    expect(REGATE_JOB).toBe('regate');
    expect(REGATE_LIMIT).toBe(200);
  });

  it('passes the D1 binding, limit, scheduled time and budget; logs counts only', async () => {
    const calls: { limit: number; now: number; budgetMs: number; sameDb: boolean }[] = [];
    const runner: RegateRunner = async (db, limit, now, options) => {
      calls.push({ limit, now, budgetMs: options.budgetMs, sameDb: db === env.DB });
      return { checked: 3, changed: 1 };
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const at = Date.UTC(2026, 9, 16, 0, 5);
    await createRegateJob(runner).run(controllerAt(at), env, createExecutionContext());
    await createRegateJob(async () => ({ checked: 1, changed: 0, timedOut: true }), 5).run(
      controllerAt(at),
      env,
      createExecutionContext(),
    );
    const lines = log.mock.calls.map((call) => String(call[0]));
    log.mockRestore();

    expect(REGATE_BUDGET_MS).toBe(20_000);
    expect(calls).toEqual([
      { limit: REGATE_LIMIT, now: at, budgetMs: REGATE_BUDGET_MS, sameDb: true },
    ]);
    const parsed = lines
      .filter((text) => text.includes('job.regate'))
      .map((text) => JSON.parse(text) as Record<string, unknown>);
    expect(parsed).toHaveLength(2);
    expect(Object.keys(parsed[0] ?? {}).sort()).toEqual([
      'changed',
      'checked',
      'event',
      'ms',
      'timedOut',
    ]);
    expect(parsed[0]).toMatchObject({
      event: 'job.regate',
      checked: 3,
      changed: 1,
      timedOut: false,
    });
    expect(parsed[1]).toMatchObject({ checked: 1, changed: 0, timedOut: true });
  });

  it('starts no curve once the time budget is spent and reports the stop', async () => {
    const id = await seedStaleCurve();
    // Zero budget: the run starts no curve at all; the stale row is left for the next run.
    const result = await regateStale(env.DB, REGATE_LIMIT, Date.now(), { budgetMs: 0 });
    expect(result).toEqual({ checked: 0, changed: 0, timedOut: true });
    expect((await getCurve(env.DB, id))?.gateVer).toBe('v0:stale');
  });

  it('counts every gate run: a YOLO curve is exactly 2, a hard rejection exactly 1', async () => {
    const yolo = await seedStale(yoloCurve());
    const hard = await seedStale(hardCurve());
    let runs = 0;
    const gate: typeof gateForWrite = (bands, preampDb, options) => {
      runs += 1;
      return gateForWrite(bands, preampDb, options);
    };
    const only =
      (id: string): typeof listCurvesWithStaleGate =>
      async (db, version, limit) =>
        (await listCurvesWithStaleGate(db, version, Math.max(limit ?? 0, 1000))).filter(
          (record) => record.id === id,
        );

    // The standard profile, then the YOLO profile on the same snapshot: both through `gate`.
    expect(await regateStale(env.DB, 50, Date.now(), { gate, list: only(yolo) })).toEqual({
      checked: 1,
      changed: 1,
    });
    expect(runs).toBe(2);
    expect(await getCurve(env.DB, yolo)).toMatchObject({ gateOk: false, gateYolo: true });
    expect((await getCurve(env.DB, yolo))?.gateReasons).toContain('d7:pk-boost-above-16k');

    // A hard reason: no YOLO run at all.
    runs = 0;
    expect(await regateStale(env.DB, 50, Date.now(), { gate, list: only(hard) })).toEqual({
      checked: 1,
      changed: 1,
    });
    expect(runs).toBe(1);
    expect(await getCurve(env.DB, hard)).toMatchObject({ gateOk: false, gateYolo: false });
    expect((await getCurve(env.DB, hard))?.gateReasons).toContain('e:output-audible');
  });

  it('updates stale verdicts to the current gate version and is idempotent', async () => {
    const id = await seedStaleCurve();
    const version = await gateVersion();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await regateJob.run(controllerAt(Date.now()), env, createExecutionContext());
    const first = log.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .find((entry) => entry.event === 'job.regate');

    const curve = await getCurve(env.DB, id);
    expect(curve?.gateVer).toBe(version);
    expect(curve?.gateOk).toBe(false);
    expect(curve?.gateReasons.length).toBeGreaterThan(0);
    expect(first?.checked).toBeGreaterThanOrEqual(1);
    expect(first?.changed).toBeGreaterThanOrEqual(1);

    // A second run never picks the re-gated curve again and leaves its verdict untouched.
    await regateJob.run(controllerAt(Date.now()), env, createExecutionContext());
    log.mockRestore();
    const stale = await listCurvesWithStaleGate(env.DB, version, 1000);
    expect(stale.map((record) => record.id)).not.toContain(id);
    expect(await getCurve(env.DB, id)).toEqual(curve);
  });
});
