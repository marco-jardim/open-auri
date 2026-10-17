// T5.3 public dump: weekly gzip JSON of the publicly listable lineages, their versions, S1,
// licenses and aggregates, written to `public/dump/<date>.json.gz` and `latest.json.gz`. The
// author's nickname appears only on CC-BY-4.0 versions; no e-mail, user id, IP-like string, hash
// or nominal activity; private, unlisted, retracted and hidden lineages are left out.
import { createExecutionContext, createScheduledController } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { publishLineage } from '../../../web/src/lib/server/social/repo.ts';
import {
  AUTHOR_REMOVED,
  buildPublicDump,
  PUBLIC_DUMP_JOB,
  PUBLIC_DUMP_LATEST_KEY,
  publicDumpJob,
  publishPublicDump,
  type PublicDump,
} from '../src/jobs/public-dump.ts';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

interface SeededUser {
  id: string;
  email: string;
  nickname: string;
}

async function seedUser(): Promise<SeededUser> {
  const id = uid('user');
  const email = `${id}@example.com`;
  const nickname = `Nick${crypto.randomUUID().slice(0, 8)}`;
  const at = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt", ' +
      '"username", "displayUsername", "usernameSkeleton", "role", "banned") ' +
      'VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0)',
  )
    .bind(id, 'Private Name', email, at, at, nickname.toLowerCase(), nickname, uid('skel'), 'user')
    .run();
  return { id, email, nickname };
}

interface Published {
  lineageId: string;
  versionId: string;
  curveId: string;
}

async function publish(
  owner: SeededUser,
  visibility: 'public' | 'unlisted' | 'private',
  license: 'CC0-1.0' | 'CC-BY-4.0',
): Promise<Published> {
  const curveId = Array.from(
    crypto.getRandomValues(new Uint8Array(12)),
    (b) => BASE32[b % 32],
  ).join('');
  const lineageId = uid('lin');
  const versionId = uid('ver');
  const result = await publishLineage(env.DB, {
    lineageId,
    ownerUserId: owner.id,
    visibility,
    curve: {
      id: curveId,
      s1: `S1-${crypto.randomUUID()}`.padEnd(68, 'x'),
      canonKey: `v1;0;PK,1000,30,100;${curveId}`,
      gateVer: 'v2:test',
      gateOk: true,
      gateReasons: [],
      levelDb: -3,
    },
    version: {
      id: versionId,
      name: 'Dump fixture',
      description: 'Public dump fixture.',
      license,
      recipe: null,
      lang: 'pt-BR',
    },
    now: Date.now(),
  });
  if (!result.ok) throw new Error(`publish failed: ${result.code}`);
  return { lineageId, versionId, curveId };
}

async function gunzipJson(bytes: ArrayBuffer): Promise<PublicDump> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as PublicDump;
}

describe('public dump', () => {
  it('lists only public content, credits CC-BY authors only and carries no personal data', async () => {
    const byAuthor = await seedUser();
    const zeroAuthor = await seedUser();
    const fan = await seedUser();
    const ccBy = await publish(byAuthor, 'public', 'CC-BY-4.0');
    const cc0 = await publish(zeroAuthor, 'public', 'CC0-1.0');
    const privateOne = await publish(await seedUser(), 'private', 'CC-BY-4.0');
    const unlisted = await publish(await seedUser(), 'unlisted', 'CC-BY-4.0');
    const retracted = await publish(await seedUser(), 'public', 'CC-BY-4.0');
    await env.DB.prepare("UPDATE lineages SET status = 'retracted' WHERE id = ?")
      .bind(retracted.lineageId)
      .run();
    const hidden = await publish(await seedUser(), 'public', 'CC-BY-4.0');
    await env.DB.prepare("UPDATE lineages SET moderation = 'hidden' WHERE id = ?")
      .bind(hidden.lineageId)
      .run();
    const anonymized = await publish(zeroAuthor, 'public', 'CC-BY-4.0');
    await env.DB.prepare('UPDATE lineages SET owner_user_id = NULL WHERE id = ?')
      .bind(anonymized.lineageId)
      .run();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO favorites (user_id, lineage_id, created_at) VALUES (?, ?, ?)',
      ).bind(fan.id, ccBy.lineageId, now),
      env.DB.prepare(
        "INSERT INTO activity (user_id, lineage_id, kind, first_at, last_at, count) VALUES (?, ?, 'installed', ?, ?, 1)",
      ).bind(fan.id, ccBy.lineageId, now, now),
    ]);

    const dump = await buildPublicDump(env.DB, new Date());
    const ids = new Set(dump.lineages.map((lineage) => lineage.id));
    expect(ids.has(ccBy.lineageId)).toBe(true);
    expect(ids.has(cc0.lineageId)).toBe(true);
    expect(ids.has(anonymized.lineageId)).toBe(true);
    for (const excluded of [privateOne, unlisted, retracted, hidden]) {
      expect(ids.has(excluded.lineageId)).toBe(false);
    }

    const byEntry = dump.lineages.find((lineage) => lineage.id === ccBy.lineageId);
    expect(byEntry?.favorites).toBe(1);
    expect(byEntry?.installs).toBe(1);
    expect(byEntry?.versions[0]).toMatchObject({
      id: ccBy.versionId,
      license: 'CC-BY-4.0',
      author: byAuthor.nickname,
      curve: { id: ccBy.curveId },
    });
    expect(byEntry?.versions[0]?.curve.s1).toHaveLength(68);
    const zeroEntry = dump.lineages.find((lineage) => lineage.id === cc0.lineageId);
    expect(zeroEntry?.versions[0]?.license).toBe('CC0-1.0');
    expect(zeroEntry?.versions[0]).not.toHaveProperty('author');
    const anonEntry = dump.lineages.find((lineage) => lineage.id === anonymized.lineageId);
    expect(anonEntry?.versions[0]?.author).toBe(AUTHOR_REMOVED);
    expect(dump.readme['pt-BR']).toMatch(/CC0-1\.0/);
    expect(dump.readme['pt-BR']).toMatch(/CC-BY-4\.0/);

    const json = JSON.stringify(dump);
    expect(json).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(json).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(json).not.toMatch(/\b[0-9a-f]{64}\b/);
    for (const user of [byAuthor, zeroAuthor, fan]) {
      expect(json).not.toContain(user.id);
      expect(json).not.toContain(user.email);
    }
    expect(json).not.toContain(zeroAuthor.nickname);
    expect(json).not.toContain(fan.nickname);
    expect(json).not.toContain(privateOne.versionId);
    expect(json).not.toContain('Private Name');
  });

  it('writes the dated object and latest.json.gz', async () => {
    const owner = await seedUser();
    const lineage = await publish(owner, 'public', 'CC0-1.0');
    const now = new Date('2031-03-03T03:00:00Z');
    const result = await publishPublicDump(env.DB, env.MEDIA, now);
    expect(result.key).toBe('public/dump/2031-03-03.json.gz');

    for (const key of [result.key, PUBLIC_DUMP_LATEST_KEY]) {
      const object = await env.MEDIA.get(key);
      expect(object, key).not.toBeNull();
      const dump = await gunzipJson((await object?.arrayBuffer()) ?? new ArrayBuffer(0));
      expect(dump.format).toBe('open-auri-public-dump');
      expect(dump.generatedAt).toBe(now.toISOString());
      expect(dump.lineages.some((entry) => entry.id === lineage.lineageId)).toBe(true);
    }
  });

  it('runs as the public-dump job and logs counts only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(publicDumpJob.name).toBe(PUBLIC_DUMP_JOB);
      await publicDumpJob.run(
        createScheduledController({ scheduledTime: Date.now(), cron: '0 3 * * 1' }),
        env,
        createExecutionContext(),
      );
      const line = log.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.includes('job.public-dump'));
      expect(line).toBeDefined();
      const parsed = JSON.parse(line ?? '{}') as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(['bytes', 'event', 'lineages', 'ms', 'versions']);
    } finally {
      log.mockRestore();
    }
  });
});
