// Order of the server hooks and the read-only step (src/hooks.server.ts uses these). Kit's
// `sequence` needs its request store, so a minimal chain with the same resolve semantics stands in.
import type { Handle } from '@sveltejs/kit/hooks';
import { describe, expect, it } from 'vitest';
import { READ_ONLY_CODE, type ReadOnlyEnv } from '#lib/server/admin/read-only.ts';
import { createReadOnlyHandle, HOOK_ORDER, orderedHandles } from '#lib/server/auth/compose.ts';

type Event = Parameters<Handle>[0]['event'];

function chain(handles: Handle[], final: () => Response): (event: Event) => Promise<Response> {
	const run = async (index: number, event: Event): Promise<Response> => {
		const handle = handles[index];
		if (!handle) return final();
		return handle({ event, resolve: (next) => run(index + 1, next) });
	};
	return (event) => run(0, event);
}

function kv(value: string | null): ReadOnlyEnv {
	return { config: { get: async () => value } } as unknown as ReadOnlyEnv;
}

function event(method: string, path: string, platform: unknown = { env: {} }): Event {
	return {
		request: new Request(`https://example.org${path}`, { method }),
		platform
	} as unknown as Event;
}

function recording(names: string[], name: string): Handle {
	return async ({ event: current, resolve }) => {
		names.push(name);
		return resolve(current);
	};
}

describe('hook composition', () => {
	it('runs the read-only step first', () => {
		expect(HOOK_ORDER).toEqual(['readOnly', 'paraglide', 'auth', 'securityHeaders', 'accessLog']);
		const marks = Object.fromEntries(HOOK_ORDER.map((name) => [name, recording([], name)]));
		const handles = orderedHandles(marks as Record<(typeof HOOK_ORDER)[number], Handle>);
		expect(handles[0]).toBe(marks.readOnly);
		expect(handles).toHaveLength(5);
	});

	it('answers 503 READ_ONLY before any later step runs, when the switch is on', async () => {
		const ran: string[] = [];
		const readOnly = createReadOnlyHandle({ building: false, env: () => kv('1') });
		const later = (['paraglide', 'auth', 'securityHeaders', 'accessLog'] as const).map((name) =>
			recording(ran, name)
		);
		const handle = chain([readOnly, ...later], () => new Response('page'));
		const response = await handle(event('POST', '/api/auth/sign-up/email'));
		expect(response.status).toBe(503);
		expect(((await response.json()) as { code: string }).code).toBe(READ_ONLY_CODE);
		expect(ran).toEqual([]);
	});

	it('lets reads, allowlisted writes and everything while off go through the whole chain', async () => {
		const onRan: string[] = [];
		const on = chain(
			[
				createReadOnlyHandle({ building: false, env: () => kv('1') }),
				recording(onRan, 'paraglide')
			],
			() => new Response('ok')
		);
		expect((await on(event('GET', '/conta'))).status).toBe(200);
		expect((await on(event('POST', '/api/auth/sign-in/email'))).status).toBe(200);
		expect(onRan).toEqual(['paraglide', 'paraglide']);

		const off = chain(
			[createReadOnlyHandle({ building: false, env: () => kv(null) })],
			() => new Response('ok')
		);
		expect((await off(event('POST', '/api/auth/sign-up/email'))).status).toBe(200);
	});

	it('steps aside while building or without a platform', async () => {
		const neverCalled = () => {
			throw new Error('env must not be read');
		};
		const building = chain(
			[createReadOnlyHandle({ building: true, env: neverCalled })],
			() => new Response('ok')
		);
		expect((await building(event('POST', '/x'))).status).toBe(200);
		const noPlatform = chain(
			[createReadOnlyHandle({ building: false, env: neverCalled })],
			() => new Response('ok')
		);
		expect((await noPlatform(event('POST', '/x', null))).status).toBe(200);
	});
});
