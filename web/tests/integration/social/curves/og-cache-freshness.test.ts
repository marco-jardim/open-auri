// Issue #31: an OG cache hit must not bypass a stale curve's new gate rejection.
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { getServerEnv } from '#lib/server/env.ts';
import { getOrCreateOg, ogKey, type OgEnv } from '#lib/server/og/store.ts';
import { gateVersion } from '#lib/server/social/gate.ts';
import { getCurve } from '#lib/server/social/repo.ts';
import { acceptAll, actor, envelopeOf, published, uniqueRejectedCurve } from './helpers.ts';

it('refuses an existing R2 object after its stale curve is rejected, without rendering or writing', async () => {
	const pub = await published(await actor(), {
		envelope: envelopeOf(uniqueRejectedCurve()),
		gate: acceptAll
	});
	const server = getServerEnv({ env });
	const ogEnv: OgEnv = {
		db: server.db,
		media: server.media,
		publicOrigin: server.publicOrigin,
		assets: null
	};
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		}
	};
	const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	let renders = 0;
	let beforeRenders = 0;
	const deps = {
		render: async () => {
			renders++;
			return png;
		},
		beforeRender: async () => {
			beforeRenders++;
		}
	};
	const key = ogKey(pub.curveId, pub.versionId);
	try {
		const first = await getOrCreateOg(ogEnv, ctx, pub.versionId, deps);
		expect(first).toMatchObject({ ok: true, source: 'render', key });
		await Promise.all(pending.splice(0));
		expect(await env.MEDIA.head(key)).not.toBeNull();
		const hit = await getOrCreateOg(ogEnv, ctx, pub.versionId, deps);
		expect(hit).toMatchObject({ ok: true, source: 'r2', key });
		expect(renders).toBe(1);

		await env.DB.prepare('UPDATE curves SET gate_ver = ? WHERE id = ?')
			.bind('v2:issue-31-og', pub.curveId)
			.run();
		// No injected gate: the real gate rejects this unique HS curve.
		expect(await getOrCreateOg(ogEnv, ctx, pub.versionId, deps)).toEqual({
			ok: false,
			code: 'not-found'
		});
		expect(await getCurve(env.DB, pub.curveId)).toMatchObject({
			gateVer: await gateVersion(),
			gateOk: false
		});
		expect(renders).toBe(1);
		expect(beforeRenders).toBe(1);
		expect(pending).toHaveLength(0);
		const stored = await env.MEDIA.get(key);
		expect(stored).not.toBeNull();
		if (!stored) throw new Error('fixture must still be in R2');
		expect(new Uint8Array(await stored.arrayBuffer())).toEqual(png);
	} finally {
		await Promise.all(pending);
		await env.MEDIA.delete(key);
	}
});
