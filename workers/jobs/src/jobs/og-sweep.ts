// OG image sweep (FX4.3, LGPD): deletes the R2 objects `og/<curveId>-<versionId>.png` that must
// no longer exist. The web store (web/src/lib/server/og/store.ts) already refuses to serve them,
// but nothing else ever removes them: a version that turned private, hidden, retracted or
// gate-rejected, a lineage of a deleted or banned account, or an image of an older card layout
// (before FX4.3 the card showed the author's nickname) would otherwise stay in the bucket forever.
//
// An object is kept only when its key parses, it carries the current card layout
// (`customMetadata.card`) and its version is linkable for an anonymous viewer with that same curve:
// the exact read the store does (`getVersionForViewer` + ANONYMOUS_VIEWER from the web repository,
// imported by relative path like regate.ts and s6-aggregate.ts), under the same YOLO kill switch
// (`YOLO_PUBLICATION`, which must equal the web Worker's; absent or anything but `on` = `off`).
// While it is on, the image of an acknowledged YOLO version is linkable and kept; while it is off,
// the store refuses every YOLO version, so the sweep deletes their images too. Everything else
// under `og/` is deleted. A deleted image of a version that becomes linkable again is simply
// rendered again on its next request.
//
// Budget per run: at most `maxPages` list pages of `pageSize` objects (one D1 read per object with
// a current card) and `budgetMs` of wall time, checked between pages. The R2 list cursor is kept in
// KV `CONFIG` (`job:og-sweep:cursor`), written once at the end of the run (KV allows one write per
// second per key), so a large bucket is covered over several runs; after the last page the cursor
// is removed and the next run starts again from the top. Idempotent: deleting a missing key is a
// no-op and a re-check of a kept object keeps it. A run that dies halfway redoes its pages next time.
//
// Logs carry counts and timings only: no key, curve id, version id or user data.
import { isCurrentCard, OG_PREFIX, parseOgKey } from '../../../../web/src/lib/server/og/keys.ts';
import { getVersionForViewer } from '../../../../web/src/lib/server/social/repo.ts';
import {
  ANONYMOUS_VIEWER,
  type YoloPublication,
} from '../../../../web/src/lib/server/social/types.ts';
import type { ScheduledJob } from './registry.ts';

export const OG_SWEEP_JOB = 'og-sweep';

/** KV `CONFIG` key holding the R2 list cursor between runs. */
export const OG_SWEEP_CURSOR_KEY = 'job:og-sweep:cursor';

export interface OgSweepLimits {
  /** Objects per R2 list page (R2 caps it at 1000). */
  pageSize: number;
  /** List pages per run. */
  maxPages: number;
  /** Wall time per run, checked before each page. */
  budgetMs: number;
}

/** 200 × 10 = up to 2000 objects (and D1 reads) per daily run, within ~20 s. */
export const OG_SWEEP_LIMITS: Readonly<OgSweepLimits> = Object.freeze({
  pageSize: 200,
  maxPages: 10,
  budgetMs: 20_000,
});

export type OgLinkableCheck = (
  db: D1Database,
  curveId: string,
  versionId: string,
  yolo: YoloPublication,
) => Promise<boolean>;

/**
 * The kill switch as the web reads it: `on` only when the variable says exactly `on` (the web's
 * env schema accepts `off` and `on`); anything else is `off`, the side that deletes more.
 */
export function yoloPublicationOf(value: unknown): YoloPublication {
  return value === 'on' ? 'on' : 'off';
}

/**
 * Same read as the store: linkable for the anonymous viewer under the kill switch `yolo`, and the
 * key's curve is its curve.
 */
export async function isLinkableOg(
  db: D1Database,
  curveId: string,
  versionId: string,
  yolo: YoloPublication = 'off',
): Promise<boolean> {
  const view = await getVersionForViewer(db, versionId, ANONYMOUS_VIEWER, yolo);
  return view !== null && view.curve.id === curveId;
}

export interface OgSweepDeps {
  media: Pick<R2Bucket, 'list' | 'delete'>;
  cursors: Pick<KVNamespace, 'get' | 'put' | 'delete'>;
  db: D1Database;
  /** The web's YOLO kill switch (`YOLO_PUBLICATION`); absent = `off`. */
  yoloPublication?: YoloPublication;
  isLinkable?: OgLinkableCheck;
  limits?: Readonly<OgSweepLimits>;
  /** Milliseconds clock for the time budget (default `Date.now`). */
  clock?: () => number;
}

export interface OgSweepResult {
  /** List pages read by this run. */
  pages: number;
  /** Objects examined. */
  checked: number;
  /** Objects deleted. */
  deleted: number;
  /** True when the run reached the end of `og/` (the next run starts from the top). */
  done: boolean;
}

/** One bounded pass of the sweep (see the file header). */
export async function sweepOgImages(deps: OgSweepDeps): Promise<OgSweepResult> {
  const limits = deps.limits ?? OG_SWEEP_LIMITS;
  const clock = deps.clock ?? Date.now;
  const isLinkable = deps.isLinkable ?? isLinkableOg;
  const yolo = deps.yoloPublication ?? 'off';
  const started = clock();
  const stored = await deps.cursors.get(OG_SWEEP_CURSOR_KEY);
  let cursor: string | undefined = stored === null || stored === '' ? undefined : stored;
  const result: OgSweepResult = { pages: 0, checked: 0, deleted: 0, done: false };

  const keep = async (object: R2Object): Promise<boolean> => {
    const ids = parseOgKey(object.key);
    if (ids === null || !isCurrentCard(object.customMetadata)) return false;
    return isLinkable(deps.db, ids.curveId, ids.versionId, yolo);
  };

  while (result.pages < limits.maxPages && clock() - started < limits.budgetMs) {
    let page: R2Objects;
    try {
      page = await deps.media.list({
        prefix: OG_PREFIX,
        limit: limits.pageSize,
        cursor,
        include: ['customMetadata'],
      });
    } catch (error) {
      // A stored cursor may have expired or become invalid: forget it so the next run restarts
      // from the top instead of failing forever, and still report this run as failed.
      if (cursor !== undefined) await deps.cursors.delete(OG_SWEEP_CURSOR_KEY);
      throw error;
    }
    result.pages += 1;

    const doomed: string[] = [];
    for (const object of page.objects) {
      result.checked += 1;
      if (!(await keep(object))) doomed.push(object.key);
    }
    if (doomed.length > 0) {
      await deps.media.delete(doomed);
      result.deleted += doomed.length;
    }

    if (!page.truncated) {
      cursor = undefined;
      result.done = true;
      break;
    }
    cursor = page.cursor;
  }

  if (cursor === undefined) await deps.cursors.delete(OG_SWEEP_CURSOR_KEY);
  else if (cursor !== stored) await deps.cursors.put(OG_SWEEP_CURSOR_KEY, cursor);
  return result;
}

/** The `og-sweep` scheduled job (options injectable for tests). Not registered here. */
export function createOgSweepJob(
  options: Pick<OgSweepDeps, 'isLinkable' | 'limits' | 'clock'> = {},
): ScheduledJob {
  return {
    name: OG_SWEEP_JOB,
    async run(_controller, env) {
      const started = Date.now();
      const result = await sweepOgImages({
        media: env.MEDIA,
        cursors: env.CONFIG,
        db: env.DB,
        yoloPublication: yoloPublicationOf(env.YOLO_PUBLICATION),
        ...options,
      });
      console.log(
        JSON.stringify({
          event: 'job.og-sweep',
          pages: result.pages,
          checked: result.checked,
          deleted: result.deleted,
          done: result.done,
          ms: Date.now() - started,
        }),
      );
    },
  };
}

export const ogSweepJob: ScheduledJob = createOgSweepJob();
