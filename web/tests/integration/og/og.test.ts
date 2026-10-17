// T4.7: OG card SVG (determinism, escaping), R2 store (key, metadata, cache, visibility) and the
// /og/[id].png handler. The renderer is injected (a fake, deterministic PNG): the real resvg path
// is covered by png.test.ts. Ids are unique per test (the D1/R2 state is shared between files).
import { env } from 'cloudflare:workers';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { curveId, encodeS1 } from 'open-auri/share';
import { describe, expect, it } from 'vitest';
import { getServerEnv } from '#lib/server/env.ts';
import { isCurrentCard, OG_CARD_VERSION, parseOgKey } from '#lib/server/og/keys.ts';
import { ogResponse } from '#lib/server/og/route.ts';
import {
	getOrCreateOg,
	OG_CACHE_CONTROL,
	ogKey,
	warmOg,
	type OgEnv
} from '#lib/server/og/store.ts';
import { NAME_MAX_CHARS, ogSvg, type OgSvgInput } from '#lib/server/og/svg.ts';
import { gateVersion } from '#lib/server/social/gate.ts';
import { randomIp, signedOut } from '../api/helpers.ts';
import { curveInput, publish, seedUser, type Published } from '../social/repo/helpers.ts';

const ORIGIN = 'http://localhost';

/** A valid, practically unique S1: one peaking band on top of the neutral bands. */
function randomS1(): string {
	const [a, b] = crypto.getRandomValues(new Uint32Array(2));
	const freqHz = 100 + ((a ?? 0) % 9900);
	const gain = 1 + ((b ?? 0) % 6);
	const gainDb = (b ?? 0) % 2 === 0 ? gain : -gain;
	const peak = { kind: 'PK', freqHz, gainDb, qFactor: 1 } as const;
	return encodeS1({ bands: NEUTRAL_BANDS.map((band, i) => (i === 0 ? peak : band)), preampDb: 0 });
}

function card(overrides: Partial<OgSvgInput> = {}): OgSvgInput {
	return {
		name: 'Warm vocal',
		license: 'CC-BY-4.0',
		s1: encodeS1({ bands: NEUTRAL_BANDS, preampDb: 0 }),
		lang: 'pt-BR',
		...overrides
	};
}

function serverEnv() {
	return getServerEnv({ env });
}

function ogEnv(): OgEnv {
	const server = serverEnv();
	return { db: server.db, media: server.media, publicOrigin: ORIGIN, assets: null };
}

function context() {
	const pending: Promise<unknown>[] = [];
	return {
		ctx: { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) },
		async settle(): Promise<void> {
			while (pending.length > 0) await pending.shift();
		}
	};
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Deterministic fake renderer that counts its calls and records the SVGs. */
function fakeRenderer() {
	const svgs: string[] = [];
	return {
		svgs,
		render: async (svg: string): Promise<Uint8Array> => {
			svgs.push(svg);
			const digest = new Uint8Array(
				await crypto.subtle.digest('SHA-256', new TextEncoder().encode(svg))
			);
			return new Uint8Array([...PNG_SIGNATURE, ...digest]);
		}
	};
}

async function published(
	visibility: 'public' | 'unlisted' | 'private' = 'public'
): Promise<Published> {
	const owner = await seedUser({});
	const s1 = randomS1();
	// Cached under the current gate version: the store re-gates stale verdicts (FX4.9).
	const curve = curveInput({ id: await curveId(s1), s1, gateVer: await gateVersion() });
	return publish(owner.id, { visibility, curve });
}

async function setLineage(
	lineageId: string,
	column: 'moderation' | 'status' | 'visibility',
	value: string
) {
	await env.DB.prepare(`UPDATE lineages SET ${column} = ? WHERE id = ?`)
		.bind(value, lineageId)
		.run();
}

function event(
	id: string,
	headers: Record<string, string> = {},
	waitUntil?: (p: Promise<unknown>) => void
) {
	return {
		request: new Request(`${ORIGIN}/og/${id}.png`, {
			headers: { 'cf-connecting-ip': randomIp(), ...headers }
		}),
		params: { id },
		locals: signedOut(),
		platform: {
			env,
			ctx: { waitUntil: waitUntil ?? ((promise: Promise<unknown>) => void promise) }
		}
	};
}

describe('ogSvg', () => {
	it('is deterministic and self-contained', () => {
		const first = ogSvg(card());
		expect(ogSvg(card())).toBe(first);
		expect(first).toContain('width="1200" height="630"');
		expect(first).toContain('open-auri');
		expect(first).toContain('stroke-dasharray');
		expect(first).not.toMatch(/<image|href=|url\(/);
		expect(ogSvg(card({ name: 'Other' }))).not.toBe(first);
		expect(ogSvg(card({ s1: randomS1() }))).not.toBe(first);
	});

	it('escapes markup, quotes and ampersands', () => {
		const svg = ogSvg(card({ name: `<script>&"'</script>`, license: '<b>&' }));
		expect(svg).toContain('&lt;script&gt;&amp;&quot;&apos;&lt;/script&gt;');
		expect(svg).toContain('&lt;b&gt;&amp;');
		expect(svg).not.toContain('<script');
		expect(svg).not.toContain('<b>');
	});

	it('strips bidi controls, XML-forbidden characters and lone surrogates', () => {
		const svg = ogSvg(card({ name: '\u202Eevil\u2066 \u0007name\uD800\u200F' }));
		expect(svg).toContain('evil name');
		expect(svg).not.toMatch(
			// eslint-disable-next-line no-control-regex -- the assertion is about control characters
			/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u0000-\u0008\uD800-\uDFFF]/
		);
	});

	it('truncates long names by code points', () => {
		const svg = ogSvg(card({ name: '🎧'.repeat(80) }));
		const kept = `${'🎧'.repeat(NAME_MAX_CHARS - 1)}…`;
		expect(svg).toContain(`>${kept}</text>`);
	});

	it('never shows an author (no nickname baked into the PNG)', () => {
		for (const lang of ['pt-BR', 'en-US'] as const) {
			const svg = ogSvg(card({ lang }));
			expect(svg).not.toMatch(/autor|author|@/i);
			// Only the mark, the license, the name, the axis labels and the legend are drawn.
			const texts = Array.from(svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g), (m) => m[1]);
			expect(texts.slice(0, 3)).toEqual(['open-auri', 'CC-BY-4.0', 'Warm vocal']);
		}
	});
});

describe('OG store', () => {
	it('uses og/<curveId>-<versionId>.png and parses it back', () => {
		expect(ogKey('abc', 'ver-1')).toBe('og/abc-ver-1.png');
		expect(parseOgKey('og/abc-ver-1.png')).toEqual({ curveId: 'abc', versionId: 'ver-1' });
		const invalid = [
			'og/abc.png',
			'og/-ver.png',
			'og/abc-ver.jpg',
			'x/abc-ver.png',
			'og/a/b-c.png'
		];
		for (const key of invalid) expect(parseOgKey(key)).toBeNull();
		expect(isCurrentCard({ card: OG_CARD_VERSION })).toBe(true);
		expect(isCurrentCard({ etag: '"x"' })).toBe(false);
		expect(isCurrentCard(undefined)).toBe(false);
	});

	it('renders once, stores PNG metadata (1-day cache, card) and then serves from R2', async () => {
		const pub = await published();
		const fake = fakeRenderer();
		const { ctx, settle } = context();
		let limited = 0;
		const deps = {
			render: fake.render,
			beforeRender: async () => {
				limited += 1;
			}
		};

		const first = await getOrCreateOg(ogEnv(), ctx, pub.versionId, deps);
		await settle();
		expect(first.ok && first.source).toBe('render');
		const key = ogKey(pub.curve.id, pub.versionId);
		const head = await serverEnv().media.head(key);
		expect(head?.httpMetadata?.contentType).toBe('image/png');
		expect(head?.httpMetadata?.cacheControl).toBe('public, max-age=86400');
		expect(head?.customMetadata?.card).toBe(OG_CARD_VERSION);

		const second = await getOrCreateOg(ogEnv(), ctx, pub.versionId, deps);
		expect(second.ok && second.source).toBe('r2');
		expect(fake.svgs).toHaveLength(1);
		expect(limited).toBe(1);
		if (!first.ok || !second.ok) throw new Error('expected both to succeed');
		expect(second.etag).toBe(first.etag);
		expect(new Uint8Array(second.body)).toEqual(new Uint8Array(first.body));
		expect(Array.from(new Uint8Array(second.body).slice(0, 8))).toEqual(PNG_SIGNATURE);
	});

	it('never serves an older card layout (author baked in): renders and overwrites', async () => {
		const pub = await published();
		const key = ogKey(pub.curve.id, pub.versionId);
		const legacy = new Uint8Array([...PNG_SIGNATURE, 1, 2, 3]);
		await serverEnv().media.put(key, legacy, {
			httpMetadata: { contentType: 'image/png' },
			customMetadata: { etag: '"legacy"' }
		});
		const fake = fakeRenderer();
		const { ctx, settle } = context();
		const result = await getOrCreateOg(ogEnv(), ctx, pub.versionId, { render: fake.render });
		await settle();
		if (!result.ok) throw new Error('expected the version to be linkable');
		expect(result.source).toBe('render');
		expect(result.etag).not.toBe('"legacy"');
		expect(fake.svgs).toHaveLength(1);
		const stored = await serverEnv().media.head(key);
		expect(stored?.customMetadata?.card).toBe(OG_CARD_VERSION);
		expect(stored?.customMetadata?.etag).toBe(result.etag);
	});

	it('renders the same bytes for concurrent misses', async () => {
		const pub = await published('unlisted');
		const fake = fakeRenderer();
		const { ctx, settle } = context();
		const [a, b] = await Promise.all([
			getOrCreateOg(ogEnv(), ctx, pub.versionId, { render: fake.render }),
			getOrCreateOg(ogEnv(), ctx, pub.versionId, { render: fake.render })
		]);
		await settle();
		if (!a.ok || !b.ok) throw new Error('expected both to succeed');
		expect(a.etag).toBe(b.etag);
		expect(fake.svgs.length).toBeLessThanOrEqual(2);
		expect(new Set(fake.svgs).size).toBe(1);
	});

	it.each([
		['private', (p: Published) => setLineage(p.lineageId, 'visibility', 'private')],
		['hidden', (p: Published) => setLineage(p.lineageId, 'moderation', 'hidden')],
		['retracted', (p: Published) => setLineage(p.lineageId, 'status', 'retracted')],
		[
			'gate-rejected',
			async (p: Published) => {
				await env.DB.prepare('UPDATE curves SET gate_ok = 0 WHERE id = ?').bind(p.curve.id).run();
			}
		]
	])('refuses a %s version without rendering or writing', async (_label, hide) => {
		const pub = await published();
		await hide(pub);
		const fake = fakeRenderer();
		const { ctx, settle } = context();
		const result = await getOrCreateOg(ogEnv(), ctx, pub.versionId, { render: fake.render });
		await settle();
		expect(result).toEqual({ ok: false, code: 'not-found' });
		expect(fake.svgs).toHaveLength(0);
		expect(await serverEnv().media.head(ogKey(pub.curve.id, pub.versionId))).toBeNull();
	});

	it('stops serving a stored image once the version is no longer linkable', async () => {
		const pub = await published();
		const { ctx, settle } = context();
		await getOrCreateOg(ogEnv(), ctx, pub.versionId, { render: fakeRenderer().render });
		await settle();
		await setLineage(pub.lineageId, 'visibility', 'private');
		expect(await getOrCreateOg(ogEnv(), ctx, pub.versionId)).toEqual({
			ok: false,
			code: 'not-found'
		});
	});

	it('refuses malformed and unknown ids without rendering', async () => {
		const fake = fakeRenderer();
		const { ctx } = context();
		for (const id of ['', '../etc', 'a'.repeat(200), 'ver-missing-0000']) {
			expect(await getOrCreateOg(ogEnv(), ctx, id, { render: fake.render })).toEqual({
				ok: false,
				code: 'not-found'
			});
		}
		expect(fake.svgs).toHaveLength(0);
	});

	it('warms the image in the background', async () => {
		const pub = await published();
		const { ctx, settle } = context();
		warmOg(ogEnv(), ctx, { versionId: pub.versionId }, { render: fakeRenderer().render });
		await settle();
		const stored = await serverEnv().media.head(ogKey(pub.curve.id, pub.versionId));
		expect(stored?.httpMetadata?.contentType).toBe('image/png');
	});
});

describe('GET /og/[id].png', () => {
	it('answers 200 with a 1-day public cache and ETag, then 304 on If-None-Match', async () => {
		const pub = await published();
		const pending: Promise<unknown>[] = [];
		const fake = fakeRenderer();
		const miss = await ogResponse(
			event(pub.versionId, {}, (p) => void pending.push(p)),
			{
				render: fake.render
			}
		);
		await Promise.all(pending);
		expect(miss.status).toBe(200);
		expect(miss.headers.get('content-type')).toBe('image/png');
		expect(miss.headers.get('cache-control')).toBe('public, max-age=86400');
		expect(miss.headers.get('cache-control')).not.toContain('immutable');
		const etag = miss.headers.get('etag');
		expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);

		// Served from R2: no renderer given, and the fake is not called again.
		const hit = await ogResponse(event(pub.versionId));
		expect(hit.status).toBe(200);
		expect(hit.headers.get('etag')).toBe(etag);
		expect(new Uint8Array(await hit.arrayBuffer())).toEqual(
			new Uint8Array(await miss.arrayBuffer())
		);
		expect(fake.svgs).toHaveLength(1);

		const notModified = await ogResponse(event(pub.versionId, { 'if-none-match': etag ?? '' }));
		expect(notModified.status).toBe(304);
		expect(notModified.headers.get('cache-control')).toBe(OG_CACHE_CONTROL);
	});

	it('answers 404 no-store for private and unknown versions', async () => {
		const pub = await published('private');
		const fake = fakeRenderer();
		for (const id of [pub.versionId, 'ver-unknown-0000']) {
			const response = await ogResponse(event(id), { render: fake.render });
			expect(response.status).toBe(404);
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
		expect(fake.svgs).toHaveLength(0);
		expect(await serverEnv().media.head(ogKey(pub.curve.id, pub.versionId))).toBeNull();
	});
});
