// T4.12: the curves routes warm the OG image of a new version in the background through
// `platform.ctx.waitUntil`, only for public or unlisted publications (POST /curves and fork decide
// from the body; a new version is always handed over, and the warm-up refuses private versions
// before rendering). The response never waits for the warm-up.
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { ogKey } from '#lib/server/og/store.ts';
import { scheduleOgWarm } from '#lib/server/og/warm.ts';
import {
	actor,
	envelopeOf,
	ORIGIN,
	presetCurve,
	published,
	route,
	type RouteModule
} from './helpers.ts';

const curves = await route('curves/');
const versions = await route('lineages/[id]/versions/');
const fork = await route('lineages/[id]/fork/');

interface FakeCtx {
	ctx: { waitUntil(promise: Promise<unknown>): void };
	/** Promises handed to `waitUntil` and not drained yet. */
	pending: Promise<unknown>[];
	/** Every `waitUntil` call so far (drained or not). */
	calls: number;
}

function fakeCtx(): FakeCtx {
	const fake: FakeCtx = {
		pending: [],
		calls: 0,
		ctx: {
			waitUntil(promise) {
				fake.calls++;
				fake.pending.push(promise);
			}
		}
	};
	return fake;
}

/** Awaits every background promise, including the ones scheduled while draining (R2 writes). */
async function drain(fake: FakeCtx): Promise<void> {
	while (fake.pending.length > 0) await Promise.allSettled(fake.pending.splice(0));
}

function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 1}`;
}

/** POST to a route with a fake execution context in `platform.ctx`. */
async function post(
	module: RouteModule,
	fake: FakeCtx,
	init: { locals: AuthLocals; body: unknown; id?: string }
): Promise<Response> {
	const handler = module.POST;
	if (!handler) throw new Error('route has no POST');
	const url = new URL(`${ORIGIN}/api/v1/test`);
	const platform = { env, ctx: fake.ctx };
	return handler({
		request: new Request(url, {
			method: 'POST',
			headers: {
				'cf-connecting-ip': randomIp(),
				origin: ORIGIN,
				'content-type': 'application/json'
			},
			body: JSON.stringify(init.body)
		}),
		locals: init.locals,
		platform,
		route: { id: '/api/v1/test' },
		params: init.id === undefined ? {} : { id: init.id },
		url
	});
}

/** Background errors are logged by the store; keep the run quiet and return the events. */
async function drainLogged(fake: FakeCtx): Promise<string[]> {
	const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	try {
		await drain(fake);
		return errors.mock.calls.map((call) => String(call[0]));
	} finally {
		errors.mockRestore();
	}
}

describe('OG warm-up on publication', () => {
	it('POST /curves schedules a warm-up for public and unlisted, never for private', async () => {
		for (const [visibility, expected] of [
			['public', 1],
			['unlisted', 1],
			['private', 0]
		] as const) {
			const owner = await actor();
			const fake = fakeCtx();
			const response = await post(curves, fake, {
				locals: owner.locals,
				body: { envelope: envelopeOf(presetCurve(0)), visibility }
			});
			expect(response.status).toBe(201);
			// Scheduled synchronously during the request, still pending when the response is out.
			expect(fake.calls).toBe(expected);
			await drainLogged(fake);
		}
	});

	it('fork schedules a warm-up only when the fork is not private (private by default)', async () => {
		const source = await published(await actor(), { visibility: 'public' });
		const cases: [unknown, number][] = [
			[{}, 0],
			[{ visibility: 'private' }, 0],
			[{ visibility: 'unlisted' }, 1],
			[{ visibility: 'public' }, 1]
		];
		for (const [body, expected] of cases) {
			const forker = await actor();
			const fake = fakeCtx();
			const response = await post(fork, fake, {
				locals: forker.locals,
				id: source.lineageId,
				body
			});
			expect(response.status).toBe(201);
			expect(fake.calls).toBe(expected);
			await drainLogged(fake);
		}
	});

	it('a new version is handed over, and a private one is refused before rendering', async () => {
		const owner = await actor();
		const info = await published(owner, { visibility: 'private' });
		const fake = fakeCtx();
		const response = await post(versions, fake, {
			locals: owner.locals,
			id: info.lineageId,
			body: { parentVersionId: info.versionId, envelope: envelopeOf(presetCurve(2)) }
		});
		expect(response.status).toBe(201);
		const appended = (await response.json()) as { versionId: string; curveId: string };
		expect(fake.calls).toBe(1);

		const logged = await drainLogged(fake);
		// Not linkable: no render, no R2 write (one waitUntil only), nothing logged, no object.
		expect(fake.calls).toBe(1);
		expect(logged.filter((line) => line.includes('og.'))).toEqual([]);
		expect(await env.MEDIA.head(ogKey(appended.curveId, appended.versionId))).toBeNull();
	});

	it('schedules nothing without an execution context', () => {
		expect(scheduleOgWarm({ platform: { env } }, { versionId: 'v-none' })).toBe(false);
		expect(scheduleOgWarm({ platform: undefined }, { versionId: 'v-none' })).toBe(false);
	});
});
