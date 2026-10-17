// Dev-only job trigger (POST /api/dev/jobs/[name]): same guard as the dev mailbox. Outside a local
// capture env (production transport, a non-loopback request) every method and every job name gets
// the same empty 404; capture on a non-local PUBLIC_ORIGIN is refused by getServerEnv itself.
//
// Inside the local capture env only the wiring is checked here (unknown name → 404, wrong method →
// 405): running a real job would touch state shared with the other test files (the rankings keep
// only the newest run, re-gate and trade pairing are global). The jobs themselves run for real in
// the social e2e (tests/e2e/social.spec.ts) and are tested in tests/integration/social/** and in
// workers/jobs.
import { describe, expect, it } from 'vitest';
import { platform, type TestPlatform } from '../phase3/helpers.ts';

interface DevJobEvent {
	request: Request;
	url: URL;
	params: { name: string };
	platform: TestPlatform;
}

type Handler = (event: DevJobEvent) => Promise<Response>;

interface DevJobRoute {
	POST: Handler;
	fallback: Handler;
}

const ROUTE = '../../../src/routes/api/dev/jobs/[name]/+server.ts';
const JOBS = ['rankings', 's6-aggregate', 'trades-expire', 'regate'] as const;
const LOCAL = 'http://localhost:4174';

/** Computed specifier, like the phase-3 route tests (not followed by `check:int`). */
async function route(): Promise<DevJobRoute> {
	return (await import(/* @vite-ignore */ ROUTE)) as DevJobRoute;
}

function event(p: TestPlatform, origin: string, name: string, method: string): DevJobEvent {
	const url = new URL(`/api/dev/jobs/${encodeURIComponent(name)}`, origin);
	return {
		request: new Request(url, { method, headers: { 'cf-connecting-ip': '10.201.0.1' } }),
		url,
		params: { name },
		platform: p
	};
}

async function call(
	handlers: DevJobRoute,
	p: TestPlatform,
	origin: string,
	name: string,
	method: string
): Promise<Response> {
	const handler = method === 'POST' ? handlers.POST : handlers.fallback;
	return handler(event(p, origin, name, method));
}

describe('/api/dev/jobs/[name]', () => {
	it('is an empty 404 for every job and method with the production transport', async () => {
		const handlers = await route();
		const production = platform({ EMAIL_TRANSPORT: 'resend' });
		const productionLocal = platform({ EMAIL_TRANSPORT: 'resend', PUBLIC_ORIGIN: LOCAL });
		for (const p of [production, productionLocal]) {
			const origin = String(p.env.PUBLIC_ORIGIN);
			for (const name of [...JOBS, 'unknown']) {
				for (const method of ['POST', 'GET', 'PUT', 'DELETE']) {
					const response = await call(handlers, p, origin, name, method);
					expect(response.status, `${origin} ${method} ${name}`).toBe(404);
					expect(await response.text()).toBe('');
					expect(response.headers.get('cache-control')).toBe('no-store');
				}
			}
		}
	});

	it('is a 404 in a local capture env when the request is not made to a loopback host', async () => {
		const handlers = await route();
		const local = platform({ EMAIL_TRANSPORT: 'capture', PUBLIC_ORIGIN: LOCAL });
		for (const origin of [
			'https://open-auri.example.org',
			'https://localhost.evil.example',
			'https://127.0.0.1.nip.io',
			'http://10.0.0.1:4174'
		]) {
			for (const name of JOBS) {
				for (const method of ['POST', 'GET']) {
					const response = await call(handlers, local, origin, name, method);
					expect(response.status, `${origin} ${method} ${name}`).toBe(404);
					expect(await response.text()).toBe('');
				}
			}
		}
	});

	it('refuses to start at all with capture on a non-local origin', async () => {
		const handlers = await route();
		const forged = platform({
			EMAIL_TRANSPORT: 'capture',
			PUBLIC_ORIGIN: 'https://open-auri.example.org'
		});
		for (const origin of [LOCAL, 'https://open-auri.example.org']) {
			await expect(call(handlers, forged, origin, 'rankings', 'POST')).rejects.toThrow(
				/EMAIL_TRANSPORT/
			);
		}
	});

	it('in a local capture env on loopback: unknown job → 404, other methods → 405', async () => {
		const handlers = await route();
		for (const publicOrigin of [LOCAL, 'http://127.0.0.1:8787']) {
			const local = platform({ EMAIL_TRANSPORT: 'capture', PUBLIC_ORIGIN: publicOrigin });
			for (const name of ['unknown', 'rotate-salt', 'access-log-retention', '__proto__', '']) {
				const response = await call(handlers, local, publicOrigin, name, 'POST');
				expect(response.status, name).toBe(404);
			}
			for (const name of JOBS) {
				for (const method of ['GET', 'PUT', 'DELETE']) {
					const response = await call(handlers, local, publicOrigin, name, method);
					expect(response.status, `${method} ${name}`).toBe(405);
					expect(response.headers.get('allow')).toBe('POST');
				}
			}
		}
	});
});
