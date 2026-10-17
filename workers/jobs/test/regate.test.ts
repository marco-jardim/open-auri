// T4.12 regate job: re-gates curves cached under another gate version (daily, up to 200 per run),
// logs counts only. Runs on the jobs Worker's D1 (web migrations), with the web's repository used
// for fixtures (same relative import path the job uses).
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
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
