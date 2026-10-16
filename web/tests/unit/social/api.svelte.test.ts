import { describe, expect, it } from 'vitest';
import { createSocialApi, SocialApiError, type SocialFetch } from '#lib/social/index.ts';

interface Call {
	url: string;
	init: RequestInit;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
	});
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response> = () => jsonResponse({})) {
	const calls: Call[] = [];
	const fetch: SocialFetch = async (url, init) => {
		const call = { url, init };
		calls.push(call);
		return respond(call);
	};
	return { calls, fetch };
}

function headersOf(call: Call | undefined): Record<string, string> {
	const raw = call?.init.headers;
	return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && !(raw instanceof Headers)
		? { ...raw }
		: {};
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
}

describe('createSocialApi: request shapes', () => {
	it('publishes with a same-origin JSON POST', async () => {
		const { calls, fetch } = fakeFetch(() =>
			jsonResponse({ lineageId: 'L1', versionId: 'V1', curveId: 'C1' }, 201)
		);
		const api = createSocialApi({ fetch });
		const envelope = { v: 1, s1: 'abc' };
		const published = await api.publishCurve({ envelope, visibility: 'public' });
		expect(published).toEqual({ lineageId: 'L1', versionId: 'V1', curveId: 'C1' });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('/api/v1/curves');
		expect(calls[0]?.init.method).toBe('POST');
		expect(calls[0]?.init.credentials).toBe('same-origin');
		expect(headersOf(calls[0])['content-type']).toBe('application/json');
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ envelope, visibility: 'public' });
	});

	it('builds query strings, skipping empty values, and encodes path segments', async () => {
		const { calls, fetch } = fakeFetch();
		const api = createSocialApi({ fetch, origin: 'https://auri.example/' });
		await api.feed({ sort: 'new', window: '7d', cursor: null, limit: 20 });
		await api.rankings({ metric: 'installs' });
		await api.getCurve('a/b', { versionId: 'v 1' });
		await api.getLineage('L1', { cursor: 'c1' });
		await api.myLibrary({ shelf: 'created', visibility: 'private' });
		await api.getUserList('Zé', 'packs', { limit: 5 });
		await api.deleteMyActivity({ lineageId: 'L1', kind: 'installed' });
		expect(calls.map((call) => call.url)).toEqual([
			'https://auri.example/api/v1/feed?sort=new&window=7d&limit=20',
			'https://auri.example/api/v1/rankings?metric=installs',
			'https://auri.example/api/v1/curves/a%2Fb?v=v+1',
			'https://auri.example/api/v1/lineages/L1?cursor=c1',
			'https://auri.example/api/v1/me/library?shelf=created&visibility=private',
			'https://auri.example/api/v1/users/Z%C3%A9?list=packs&limit=5',
			'https://auri.example/api/v1/me/activity?lineageId=L1&kind=installed'
		]);
		expect(calls.map((call) => call.init.method)).toEqual([
			'GET',
			'GET',
			'GET',
			'GET',
			'GET',
			'GET',
			'DELETE'
		]);
		expect(calls.every((call) => call.init.body === undefined)).toBe(true);
		expect(calls.every((call) => headersOf(call)['content-type'] === undefined)).toBe(true);
	});

	it('maps every write to its method and path', async () => {
		const { calls, fetch } = fakeFetch((call) =>
			call.init.method === 'DELETE' && call.url.includes('/packs/')
				? new Response(null, { status: 204 })
				: jsonResponse({})
		);
		const api = createSocialApi({ fetch });
		await api.appendVersion('L1', { parentVersionId: 'V1', envelope: {} });
		await api.forkLineage('L1');
		await api.retractLineage('L1');
		await api.restoreLineage('L1');
		await api.setVisibility('L1', 'unlisted');
		await api.favorite('L1', { shareId: 'S1' });
		await api.unfavorite('L1');
		await api.audience('L1');
		await api.mergeLibrary([{ localId: 'x', s1: 's1', name: 'n' }]);
		await api.createShare({ lineageId: 'L1', channel: 'qr' });
		await api.shareStats('S1');
		await api.createPack({ name: 'P' });
		await api.updatePack('P1', { items: ['L1'] });
		await expect(api.deletePack('P1')).resolves.toBeUndefined();
		await api.joinTrade({ lineageId: 'L1' });
		await api.myTrades({ limit: 10 });
		await api.scoreTrade('T1', 4);
		await api.cancelTrade('T1');
		expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
			'POST /api/v1/lineages/L1/versions',
			'POST /api/v1/lineages/L1/fork',
			'POST /api/v1/lineages/L1/retract',
			'POST /api/v1/lineages/L1/restore',
			'PUT /api/v1/lineages/L1/visibility',
			'PUT /api/v1/curves/L1/favorite?s=S1',
			'DELETE /api/v1/curves/L1/favorite',
			'GET /api/v1/curves/L1/audience',
			'POST /api/v1/me/library/merge',
			'POST /api/v1/shares',
			'GET /api/v1/shares/S1/stats',
			'POST /api/v1/packs',
			'PUT /api/v1/packs/P1',
			'DELETE /api/v1/packs/P1',
			'POST /api/v1/trades',
			'GET /api/v1/trades/me?limit=10',
			'POST /api/v1/trades/T1/score',
			'DELETE /api/v1/trades/T1'
		]);
		expect(JSON.parse(String(calls[1]?.init.body))).toEqual({});
		expect(JSON.parse(String(calls[4]?.init.body))).toEqual({ visibility: 'unlisted' });
		expect(JSON.parse(String(calls[8]?.init.body))).toEqual({
			items: [{ localId: 'x', s1: 's1', name: 'n' }]
		});
		expect(JSON.parse(String(calls[16]?.init.body))).toEqual({ score: 4 });
	});

	it('sends activity and the outbox batch', async () => {
		const { calls, fetch } = fakeFetch(() => jsonResponse({ results: [] }));
		const api = createSocialApi({ fetch });
		const eventId = '00000000-0000-4000-8000-000000000001';
		await api.postActivity('L1', { kind: 'installed', eventId });
		await api.postActivityOutbox([{ lineageId: 'L1', kind: 'installed', eventId, at: 5 }]);
		expect(calls[0]?.url).toBe('/api/v1/curves/L1/activity');
		expect(calls[1]?.url).toBe('/api/v1/me/activity/outbox');
		expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
			events: [{ lineageId: 'L1', kind: 'installed', eventId, at: 5 }]
		});
	});

	it('puts the Turnstile token in x-turnstile-token', async () => {
		const { calls, fetch } = fakeFetch((call) =>
			call.init.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse({})
		);
		const api = createSocialApi({ fetch });
		await api.report({ targetKind: 'lineage', targetId: 'L1', reason: 'spam' }, 'tok-1');
		await api.postS6Batch(
			{
				consentVersion: '1',
				receipt: 'r'.repeat(43),
				pairs: [{ a: 'x', b: 'y', choice: 'tie', levelMatched: true }]
			},
			'tok-2'
		);
		await api.deleteS6Batch('rec/1');
		await api.s6Preferences();
		expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
			'POST /api/v1/reports',
			'POST /api/v1/s6/batches',
			'DELETE /api/v1/s6/batches/rec%2F1',
			'GET /api/v1/s6/preferences'
		]);
		expect(headersOf(calls[0])['x-turnstile-token']).toBe('tok-1');
		expect(headersOf(calls[1])['x-turnstile-token']).toBe('tok-2');
		expect(headersOf(calls[2])['x-turnstile-token']).toBeUndefined();
	});

	it('opens a share with an empty 204 and builds OG URLs without a request', async () => {
		const { calls, fetch } = fakeFetch(() => new Response(null, { status: 204 }));
		const api = createSocialApi({ fetch, origin: 'https://auri.example' });
		await expect(api.openShare('S1')).resolves.toBeUndefined();
		expect(api.ogImageUrl('V 1')).toBe('https://auri.example/og/V%201.png');
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe('https://auri.example/api/v1/shares/S1/open');
	});

	it('forwards the abort signal', async () => {
		const { calls, fetch } = fakeFetch();
		const api = createSocialApi({ fetch });
		const controller = new AbortController();
		await api.getUser('ana', { signal: controller.signal });
		expect(calls[0]?.init.signal).toBe(controller.signal);
	});
});

describe('createSocialApi: errors', () => {
	it('maps the API error body to SocialApiError', async () => {
		const { fetch } = fakeFetch(() =>
			jsonResponse({ error: { code: 'GATE_REJECTED', details: { reasons: ['gain'] } } }, 422)
		);
		const api = createSocialApi({ fetch });
		const error = await caught(api.publishCurve({ envelope: {}, visibility: 'public' }));
		expect(error).toBeInstanceOf(SocialApiError);
		if (!(error instanceof SocialApiError)) return;
		expect(error.status).toBe(422);
		expect(error.code).toBe('GATE_REJECTED');
		expect(error.details).toEqual({ reasons: ['gain'] });
		expect(error.unreachable).toBe(false);
	});

	it('reads retry-after in milliseconds', async () => {
		const { fetch } = fakeFetch(() =>
			jsonResponse({ error: { code: 'RATE_LIMITED' } }, 429, { 'retry-after': '30' })
		);
		const error = await caught(createSocialApi({ fetch }).feed());
		expect(error).toBeInstanceOf(SocialApiError);
		expect(error instanceof SocialApiError ? error.retryAfterMs : null).toBe(30_000);
	});

	it('falls back to the status code for unknown codes and non-JSON bodies', async () => {
		const bodies: Response[] = [
			jsonResponse({ error: { code: 'SOMETHING_NEW' } }, 404),
			new Response('<html>bad gateway</html>', { status: 502 }),
			new Response('nope', { status: 401 }),
			new Response('', { status: 409 })
		];
		const { fetch } = fakeFetch(() => bodies.shift() ?? new Response('', { status: 500 }));
		const api = createSocialApi({ fetch });
		const codes: unknown[] = [];
		for (let index = 0; index < 4; index += 1) {
			const error = await caught(api.getPack('P1'));
			codes.push(error instanceof SocialApiError ? [error.status, error.code] : error);
		}
		expect(codes).toEqual([
			[404, 'NOT_FOUND'],
			[502, 'INTERNAL'],
			[401, 'AUTH_REQUIRED'],
			[409, 'CONFLICT']
		]);
	});

	it('tells NETWORK from OFFLINE when no response arrives', async () => {
		const fetch: SocialFetch = () => Promise.reject(new TypeError('Failed to fetch'));
		let online = true;
		const api = createSocialApi({ fetch, online: () => online });
		const network = await caught(api.feed());
		online = false;
		const offline = await caught(api.feed());
		expect(network instanceof SocialApiError ? [network.status, network.code] : network).toEqual([
			0,
			'NETWORK'
		]);
		expect(offline instanceof SocialApiError ? offline.code : offline).toBe('OFFLINE');
		expect(offline instanceof SocialApiError && offline.unreachable).toBe(true);
	});

	it('rethrows aborts untouched', async () => {
		const fetch: SocialFetch = () => Promise.reject(new DOMException('aborted', 'AbortError'));
		const error = await caught(createSocialApi({ fetch }).myActivity());
		expect(error).toBeInstanceOf(DOMException);
		expect(error instanceof DOMException ? error.name : null).toBe('AbortError');
	});

	it('reports a 2xx answer that is not JSON as INTERNAL', async () => {
		const { fetch } = fakeFetch(() => new Response('not json', { status: 200 }));
		const error = await caught(createSocialApi({ fetch }).getUser('ana'));
		expect(error instanceof SocialApiError ? [error.status, error.code] : error).toEqual([
			200,
			'INTERNAL'
		]);
	});
});
