// T4.T general protections: read-only mode over every /api/v1 route (writes 503 READ_ONLY, reads
// pass), user text with HTML/JS stored and returned verbatim as data (JSON, never markup) and
// refused when URL-like, nickname confusables, and a per-user daily quota of the API kit.
//
// Read-only: the KV switch is NOT flipped (the KV namespace is shared with every other file); the
// write middleware of hooks.server.ts (`enforceWritable`, wired in auth/compose.ts) gets a view of
// the CONFIG namespace whose `mode:read-only` reads '1'.
import type { KVNamespace } from '@cloudflare/workers-types';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { enforceWritable, READ_ONLY_CODE, READ_ONLY_KEY } from '#lib/server/admin/read-only.ts';
import { checkUsername, usernameSkeleton } from '#lib/server/auth/username.ts';
import { createOwnPack, viewPack } from '#lib/server/social/packs.ts';
import { loadSharedCurve } from '#lib/server/social/shares.ts';
import { envelopeOf, presetCurve } from '../social/curves/helpers.ts';
import { seedUser } from '../account/helpers.ts';
import {
	ANONYMOUS,
	concretePath,
	errorCode,
	exportedMethods,
	invoke,
	member,
	ORIGIN,
	syntheticEvent,
	textOf
} from './helpers.ts';

const ROUTE_FILES = import.meta.glob('../../../src/routes/api/v1/**/+server.ts');

function routeIdOf(file: string): string {
	return /\/api\/v1\/(.+)\/\+server\.ts$/.exec(file)?.[1] ?? file;
}

/** CONFIG as the middleware sees it while the switch is on (the real KV is left untouched). */
function readOnlyConfig(): KVNamespace {
	const config: KVNamespace = env.CONFIG;
	return new Proxy(config, {
		get(target, property, receiver) {
			if (property === 'get') {
				return async (key: string) => (key === READ_ONLY_KEY ? '1' : target.get(key));
			}
			const value: unknown = Reflect.get(target, property, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
}

describe('read-only mode (KV mode:read-only = "1")', () => {
	it('every write of every /api/v1 route answers 503 READ_ONLY; every read passes', async () => {
		const config = readOnlyConfig();
		let writes = 0;
		let reads = 0;
		for (const [file, load] of Object.entries(ROUTE_FILES)) {
			const id = routeIdOf(file);
			const path = concretePath(id, { id: 'abcdefgh12', apelido: 'someone', receipt: 'r' });
			for (const method of exportedMethods(await load())) {
				const request = new Request(`${ORIGIN}${path}`, {
					method,
					headers: { origin: ORIGIN, 'content-type': 'application/json' },
					...(method === 'GET' ? {} : { body: '{}' })
				});
				const blocked = await enforceWritable(request, { config });
				if (method === 'GET') {
					expect(blocked, `${method} ${path}`).toBeNull();
					reads++;
					continue;
				}
				expect(blocked?.status, `${method} ${path}`).toBe(503);
				expect(blocked?.headers.get('x-error-code'), `${method} ${path}`).toBe(READ_ONLY_CODE);
				expect(blocked?.headers.get('retry-after')).not.toBeNull();
				writes++;
			}
		}
		expect(writes).toBeGreaterThanOrEqual(23);
		expect(reads).toBeGreaterThanOrEqual(14);
		// The OG image and the public pages stay readable.
		for (const path of ['/og/abcdefgh12.png', '/c/abcdefgh12', '/u/someone']) {
			expect(await enforceWritable(new Request(`${ORIGIN}${path}`), { config })).toBeNull();
		}
	});
});

// ---- User text: verbatim as data, never markup; URL-like refused -------------------------------

const HOSTILE_NAME = `<script>alert("x")</script> & 'q' ${crypto.randomUUID().slice(0, 6)}`;
const HOSTILE_DESCRIPTION = '<img src=x onerror=alert(1)>\n"quoted" </textarea><svg/onload=1>';

describe('XSS strings in user text', () => {
	it('curve name and description: stored and returned verbatim in JSON (API and /c data)', async () => {
		const author = await member({ prefix: 'p4xss' });
		const curves = await import('../../../src/routes/api/v1/curves/+server.ts');
		const created = await invoke(
			curves,
			'POST',
			syntheticEvent('curves', 'POST', author.locals, {
				body: {
					envelope: envelopeOf(presetCurve(4), {
						name: HOSTILE_NAME,
						description: HOSTILE_DESCRIPTION
					}),
					visibility: 'public'
				}
			})
		);
		expect(created.status).toBe(201);
		const { lineageId } = (await created.json()) as { lineageId: string };

		const read = await import('../../../src/routes/api/v1/curves/[id]/+server.ts');
		const response = await invoke(
			read,
			'GET',
			syntheticEvent('curves/[id]', 'GET', ANONYMOUS, { params: { id: lineageId } })
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');
		const body = (await response.json()) as { version: { name: string; description: string } };
		expect(body.version.name).toBe(HOSTILE_NAME);
		expect(body.version.description).toBe(HOSTILE_DESCRIPTION);

		const page = await loadSharedCurve(env.DB, { userId: null }, lineageId, null);
		if (page.kind !== 'ok') throw new Error(`expected the page data, got ${page.kind}`);
		expect(page.curve.name).toBe(HOSTILE_NAME);
		expect(page.curve.description).toBe(HOSTILE_DESCRIPTION);
	});

	it('pack name and description: verbatim as data', async () => {
		const owner = await member({ prefix: 'p4xsp' });
		const pack = await createOwnPack(
			env.DB,
			owner.user.id,
			{ name: HOSTILE_NAME, description: HOSTILE_DESCRIPTION, visibility: 'public' },
			Date.now()
		);
		const seen = await viewPack(env.DB, pack.id, { userId: null });
		expect(seen?.name).toBe(HOSTILE_NAME);
		expect(seen?.description).toBe(HOSTILE_DESCRIPTION);
	});

	it('URL-like names and descriptions are refused (curves 422 INVALID_CURVE, packs 400)', async () => {
		const author = await member({ prefix: 'p4url' });
		const curves = await import('../../../src/routes/api/v1/curves/+server.ts');
		const packs = await import('../../../src/routes/api/v1/packs/+server.ts');
		for (const overrides of [
			{ name: 'Veja https://evil.example/x' },
			{ description: 'Mais em http://evil.example/login' }
		]) {
			const response = await invoke(
				curves,
				'POST',
				syntheticEvent('curves', 'POST', author.locals, {
					body: { envelope: envelopeOf(presetCurve(4), overrides), visibility: 'public' }
				})
			);
			expect(response.status, JSON.stringify(overrides)).toBe(422);
			expect(await errorCode(response)).toBe('INVALID_CURVE');
		}
		for (const body of [
			{ name: 'https://evil.example/pack' },
			{ name: 'Pack', description: 'veja http://evil.example' }
		]) {
			const response = await invoke(
				packs,
				'POST',
				syntheticEvent('packs', 'POST', author.locals, { body })
			);
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect(await errorCode(response)).toBe('INVALID_BODY');
		}
		// Nothing of the refused text was stored anywhere visible to the author.
		const mine = await import('../../../src/routes/api/v1/me/library/+server.ts');
		const shelf = await invoke(
			mine,
			'GET',
			syntheticEvent('me/library', 'GET', author.locals, { query: '?shelf=created' })
		);
		expect(await textOf(shelf)).not.toContain('evil.example');
	});
});

// ---- Nicknames ---------------------------------------------------------------------------------

describe('nickname confusables', () => {
	it('look-alike spellings fold to one skeleton and resolve to the real profile (308), never another user', async () => {
		const hex = crypto
			.randomUUID()
			.replace(/-/g, '')
			.slice(0, 10)
			.replace(/[01il]/g, 'a');
		const real = `cx-rn0${hex}`;
		const lookAlike = `cx_mo${hex}`;
		expect(usernameSkeleton(lookAlike)).toBe(usernameSkeleton(real));
		await seedUser({ username: real });

		const users = await import('../../../src/routes/api/v1/users/[apelido]/+server.ts');
		const response = await invoke(
			users,
			'GET',
			syntheticEvent('users/[apelido]', 'GET', ANONYMOUS, { params: { apelido: lookAlike } })
		);
		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe(`/api/v1/users/${real}`);

		// Non-ASCII look-alikes never pass the format check; full-width forms fold by NFKC.
		expect(checkUsername(`cx-rn0${hex}`.replace('c', '\u0441'))).toBe('invalid');
		expect(checkUsername('\uff41\uff44\uff4d\uff49\uff4e')).toBe('reserved');
		expect(checkUsername('adm1n')).toBe('reserved');
		const cyrillic = await invoke(
			users,
			'GET',
			syntheticEvent('users/[apelido]', 'GET', ANONYMOUS, {
				params: { apelido: real.replace('c', '\u0441') }
			})
		);
		expect(cyrillic.status).toBe(404);
	});
});

// ---- Quotas --------------------------------------------------------------------------------------

describe('quotas and rate limits of the kit', () => {
	it('POST /api/v1/packs: the 51st pack of the day is refused with 429 and retry-after', async () => {
		const owner = await member({ prefix: 'p4quo' });
		const packs = await import('../../../src/routes/api/v1/packs/+server.ts');
		let refused: Response | null = null;
		for (let i = 0; i < 51 && refused === null; i++) {
			const response = await invoke(
				packs,
				'POST',
				syntheticEvent('packs', 'POST', owner.locals, { body: { name: `Pack ${i}` } })
			);
			if (response.status !== 201) refused = response;
		}
		expect(refused?.status).toBe(429);
		expect(['RATE_LIMITED', 'QUOTA_EXCEEDED']).toContain(
			await errorCode(refused ?? new Response())
		);
		expect(refused?.headers.get('retry-after')).not.toBeNull();
	});
});
