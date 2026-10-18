// Weekly public dump (T5.3, docs/lgpd.md operation 23): the open collection of public curves as
// gzip JSON in the R2 bucket MEDIA, at `public/dump/<YYYY-MM-DD>.json.gz` (UTC day of the run) and
// `public/dump/latest.json.gz`.
//
// Content: the publicly LISTABLE lineages (`publicLineageSql` of the web repository, imported by
// relative path like the other jobs: public, active, visible, head passed the gate, owner not
// banned), their versions whose curve currently passes the gate (S1, name, description, license,
// language, parent), the public aggregates (favorites and installs counted from verified, not
// banned accounts, as everywhere else) and the materialized rankings restricted to those lineages.
// The author's public nickname appears ONLY on CC-BY-4.0 versions, because the license requires
// attribution ("autor removido" after an anonymized account closure). Never included: e-mails,
// user ids, nominal activity (who favorited or installed), hashes, IPs, recipes, private or
// unlisted content, moderation data. A fork points to its origin only when the origin version is
// itself in the dump. The `readme` field explains the licenses. A version with filter labels
// (open-auri/preset@2, migration 0012) carries them as `labels` (ten entries by wire index of its
// S1, null = automatic name); the field is additive and absent otherwise, so `formatVersion`
// stays 1. Curves are S1 strings as stored (S1 v1 or v2, bands up to 32 kHz); nothing here decodes
// them.
//
// YOLO (migration 0013) stays OUT of the dump for now: `publicLineageSql` needs a STANDARD head
// (`gate_ok = 1`), and only versions whose own curve is standard are exported, so neither a YOLO
// lineage nor an older YOLO version of a standard lineage is ever in it.
//
// Idempotent: a re-run on the same day overwrites the same two objects. Logs carry counts only.
import { countedUserSql, publicLineageSql } from '../../../../web/src/lib/server/social/repo.ts';
import type { ScheduledJob } from './registry.ts';

export const PUBLIC_DUMP_JOB = 'public-dump';
export const PUBLIC_DUMP_PREFIX = 'public/dump/';
export const PUBLIC_DUMP_LATEST_KEY = `${PUBLIC_DUMP_PREFIX}latest.json.gz`;
export const PUBLIC_DUMP_FORMAT = 'open-auri-public-dump';
export const AUTHOR_REMOVED = 'autor removido';

/** Lineages per page (their ids are bound parameters: D1 allows 100 per statement). */
const PAGE_SIZE = 90;

export const PUBLIC_DUMP_README = {
  'pt-BR':
    'Acervo público de curvas do open-auri. Cada versão traz a sua licença: CC0-1.0 (domínio ' +
    'público, uso livre sem atribuição; https://creativecommons.org/publicdomain/zero/1.0/) ou ' +
    'CC-BY-4.0 (uso livre com atribuição ao autor indicado em "author"; ' +
    'https://creativecommons.org/licenses/by/4.0/). O apelido do autor só aparece nas versões ' +
    'CC-BY-4.0, porque a licença exige a atribuição. Não há e-mails, identificadores de conta nem ' +
    'atividade individual. Contagens e rankings são agregados.',
  'en-US':
    'Public collection of open-auri curves. Each version carries its own license: CC0-1.0 ' +
    '(public domain, free use without attribution; https://creativecommons.org/publicdomain/zero/1.0/) ' +
    'or CC-BY-4.0 (free use with attribution to the author given in "author"; ' +
    'https://creativecommons.org/licenses/by/4.0/). The author nickname appears only on CC-BY-4.0 ' +
    'versions, because that license requires attribution. No e-mails, account identifiers or ' +
    'individual activity. Counts and rankings are aggregates.',
} as const;

export type DumpLicense = 'CC0-1.0' | 'CC-BY-4.0';

export interface DumpVersion {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  license: DumpLicense;
  lang: string;
  createdAt: string;
  curve: { id: string; s1: string };
  /** Only on versions with filter labels: ten entries by wire index of `curve.s1`. */
  labels?: (string | null)[];
  /** Only on CC-BY-4.0 versions: the public nickname, or "autor removido". */
  author?: string;
}

export interface DumpLineage {
  id: string;
  headVersionId: string | null;
  forkedFromVersionId: string | null;
  curated: boolean;
  createdAt: string;
  favorites: number;
  installs: number;
  versions: DumpVersion[];
}

export interface DumpRanking {
  metric: string;
  window: string;
  rank: number;
  score: number;
  lineageId: string;
}

export interface PublicDump {
  format: typeof PUBLIC_DUMP_FORMAT;
  formatVersion: 1;
  generatedAt: string;
  readme: typeof PUBLIC_DUMP_README;
  licenses: Record<DumpLicense, string>;
  totals: { lineages: number; versions: number };
  lineages: DumpLineage[];
  rankings: DumpRanking[];
}

interface LineageRow {
  id: string;
  head_version: string | null;
  forked_from_version: string | null;
  curated: number;
  created_at: number;
  author: string | null;
}

interface VersionRow {
  id: string;
  lineage_id: string;
  parent_id: string | null;
  name: string;
  description: string;
  license: DumpLicense;
  lang: string;
  created_at: number;
  curve_id: string;
  s1: string;
  labels: string | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** `versions.labels` JSON → ten entries with at least one label; null for anything else. */
function dumpLabels(text: string | null): (string | null)[] | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (
      !Array.isArray(value) ||
      value.length !== 10 ||
      !value.every((label) => label === null || typeof label === 'string')
    ) {
      return null;
    }
    const labels: (string | null)[] = value.map((label) =>
      typeof label === 'string' ? label : null,
    );
    return labels.some((label) => label !== null) ? labels : null;
  } catch {
    return null;
  }
}

async function countsBy(
  db: D1Database,
  sql: string,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(sql)
    .bind(...ids)
    .all<{ lineage_id: string; n: number }>();
  return new Map(results.map((row) => [row.lineage_id, row.n]));
}

/** Builds the dump object (no write). */
export async function buildPublicDump(db: D1Database, now: Date): Promise<PublicDump> {
  const lineages: DumpLineage[] = [];
  let after = '';
  for (;;) {
    const page = await db
      .prepare(
        'SELECT l.id, l.head_version, l.forked_from_version, l.curated, l.created_at, ' +
          'COALESCE(u."displayUsername", u."username") AS author ' +
          'FROM lineages l LEFT JOIN "user" u ON u."id" = l.owner_user_id ' +
          `WHERE ${publicLineageSql('l')} AND l.id > ? ORDER BY l.id LIMIT ?`,
      )
      .bind(after, PAGE_SIZE)
      .all<LineageRow>();
    const rows = page.results;
    if (rows.length === 0) break;
    const ids = rows.map((row) => row.id);
    const marks = ids.map(() => '?').join(', ');
    const versions = await db
      .prepare(
        'SELECT v.id, v.lineage_id, v.parent_id, v.name, v.description, v.license, v.lang, ' +
          'v.created_at, v.labels, c.id AS curve_id, c.s1 FROM versions v ' +
          'JOIN curves c ON c.id = v.curve_id ' +
          `WHERE v.lineage_id IN (${marks}) AND c.gate_ok = 1 ORDER BY v.lineage_id, v.created_at, v.id`,
      )
      .bind(...ids)
      .all<VersionRow>();
    const favorites = await countsBy(
      db,
      'SELECT f.lineage_id, COUNT(*) AS n FROM favorites f JOIN "user" u ON u."id" = f.user_id ' +
        `WHERE f.lineage_id IN (${marks}) AND ${countedUserSql('u')} GROUP BY f.lineage_id`,
      ids,
    );
    const installs = await countsBy(
      db,
      'SELECT a.lineage_id, COUNT(*) AS n FROM activity a JOIN "user" u ON u."id" = a.user_id ' +
        `WHERE a.kind = 'installed' AND a.lineage_id IN (${marks}) AND ${countedUserSql('u')} ` +
        'GROUP BY a.lineage_id',
      ids,
    );
    const byLineage = new Map<string, DumpVersion[]>();
    const authorOf = new Map(rows.map((row) => [row.id, row.author]));
    for (const version of versions.results) {
      const entry: DumpVersion = {
        id: version.id,
        parentId: version.parent_id,
        name: version.name,
        description: version.description,
        license: version.license,
        lang: version.lang,
        createdAt: iso(version.created_at),
        curve: { id: version.curve_id, s1: version.s1 },
      };
      const labels = dumpLabels(version.labels);
      if (labels) entry.labels = labels;
      if (version.license === 'CC-BY-4.0') {
        entry.author = authorOf.get(version.lineage_id) ?? AUTHOR_REMOVED;
      }
      const list = byLineage.get(version.lineage_id) ?? [];
      list.push(entry);
      byLineage.set(version.lineage_id, list);
    }
    for (const row of rows) {
      lineages.push({
        id: row.id,
        headVersionId: row.head_version,
        forkedFromVersionId: row.forked_from_version,
        curated: row.curated === 1,
        createdAt: iso(row.created_at),
        favorites: favorites.get(row.id) ?? 0,
        installs: installs.get(row.id) ?? 0,
        versions: byLineage.get(row.id) ?? [],
      });
    }
    after = ids[ids.length - 1] ?? after;
    if (rows.length < PAGE_SIZE) break;
  }

  // A fork's origin (and a head) is shown only when that version is itself in the dump: a private,
  // unlisted, retracted or hidden origin must not leak even its id.
  const published = new Set(lineages.flatMap((lineage) => lineage.versions.map((v) => v.id)));
  for (const lineage of lineages) {
    if (lineage.forkedFromVersionId !== null && !published.has(lineage.forkedFromVersionId)) {
      lineage.forkedFromVersionId = null;
    }
    if (lineage.headVersionId !== null && !published.has(lineage.headVersionId)) {
      lineage.headVersionId = null;
    }
  }

  const listed = new Set(lineages.map((lineage) => lineage.id));
  const ranked = await db
    .prepare(
      'SELECT metric, "window" AS win, rank, score, lineage_id FROM rankings ' +
        'ORDER BY metric, "window", rank',
    )
    .all<{ metric: string; win: string; rank: number; score: number; lineage_id: string }>();
  const rankings = ranked.results
    .filter((row) => listed.has(row.lineage_id))
    .map((row) => ({
      metric: row.metric,
      window: row.win,
      rank: row.rank,
      score: row.score,
      lineageId: row.lineage_id,
    }));

  return {
    format: PUBLIC_DUMP_FORMAT,
    formatVersion: 1,
    generatedAt: now.toISOString(),
    readme: PUBLIC_DUMP_README,
    licenses: {
      'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
      'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
    },
    totals: { lineages: lineages.length, versions: published.size },
    lineages,
    rankings,
  };
}

async function gzipJson(value: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(value)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface PublicDumpResult {
  key: string;
  lineages: number;
  versions: number;
  bytes: number;
}

/** Builds the dump and writes the dated object and `latest.json.gz`. */
export async function publishPublicDump(
  db: D1Database,
  bucket: Pick<R2Bucket, 'put'>,
  now: Date,
): Promise<PublicDumpResult> {
  const dump = await buildPublicDump(db, now);
  const body = await gzipJson(dump);
  const key = `${PUBLIC_DUMP_PREFIX}${now.toISOString().slice(0, 10)}.json.gz`;
  // An opaque `.json.gz` download: no Content-Encoding, so no client decompresses it in transit.
  const options: R2PutOptions = { httpMetadata: { contentType: 'application/gzip' } };
  await bucket.put(key, body, options);
  await bucket.put(PUBLIC_DUMP_LATEST_KEY, body, options);
  return {
    key,
    lineages: dump.totals.lineages,
    versions: dump.totals.versions,
    bytes: body.byteLength,
  };
}

export const publicDumpJob: ScheduledJob = {
  name: PUBLIC_DUMP_JOB,
  async run(controller, env) {
    const started = Date.now();
    const result = await publishPublicDump(env.DB, env.MEDIA, new Date(controller.scheduledTime));
    console.log(
      JSON.stringify({
        event: 'job.public-dump',
        lineages: result.lineages,
        versions: result.versions,
        bytes: result.bytes,
        ms: Date.now() - started,
      }),
    );
  },
};
