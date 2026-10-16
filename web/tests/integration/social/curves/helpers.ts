// Fixtures of the curves service tests (T4.2): users with their `locals`, S5 envelopes built from
// the official presets (real gate) or unique curves, and calls to the real `+server.ts` exports
// with synthetic events. Every id and nickname is unique, so the files can share the database.
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { gateForWrite } from 'open-auri/safety';
import { decodeS1, encodeS1 } from 'open-auri/share';
import type { ApiErrorCode } from '#lib/server/api/index.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { publishCurve, type PublishedInfo } from '#lib/server/social/curves.ts';
import type { LineageVisibility } from '#lib/server/social/types.ts';
import reference from '../../../../../test/fixtures/eq0xcb.reference.json';
import { count, locals, nick, seedUser, uid, type SeededUser } from '../../account/helpers.ts';

export { count };

export const ORIGIN: string = env.PUBLIC_ORIGIN;

type Curve = Parameters<typeof encodeS1>[0];
type Band = Curve['bands'][number];

const PRESETS: Curve[] = Object.values(reference.presets).map((preset) => ({
	bands: preset.eqBands as Band[],
	preampDb: preset.preampDb
}));

export function presetCurve(index = 0): Curve {
	const curve = PRESETS[index % PRESETS.length];
	if (!curve) throw new Error('no presets in the reference fixture');
	return curve;
}

function randomInt(min: number, max: number): number {
	const [value = 0] = crypto.getRandomValues(new Uint32Array(1));
	return min + (value % (max - min + 1));
}

/** A unique curve the real gate refuses (HS shelves are not allowed: `k:kind-not-allowed`). */
export function uniqueRejectedCurve(): Curve {
	const base = presetCurve(0);
	const shelf = (): Band => ({
		kind: 'HS',
		freqHz: randomInt(1000, 15999),
		gainDb: -randomInt(1, 60) / 10,
		qFactor: 0.71
	});
	return { bands: [shelf(), shelf(), ...base.bands.slice(2)], preampDb: base.preampDb };
}

/** The real gate with its verdict forced to "accepted" (unique accepted curves for tests). */
export const acceptAll: typeof gateForWrite = (bands, preampDb, options) => ({
	...gateForWrite(bands, preampDb, options),
	ok: true,
	reasons: []
});

/** A valid S5 envelope of `curve` (S1 and bands taken from the codec, so they always agree). */
export function envelopeOf(
	curve: Curve,
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	const code = encodeS1(curve);
	const decoded = decodeS1(code);
	return {
		format: 'open-auri/preset@1',
		name: 'Vocal quente',
		description: 'Realce suave em 3 kHz.',
		source: 'custom',
		license: 'CC0-1.0',
		code,
		preampDb: decoded.preampDb,
		bands: decoded.bands,
		lang: 'pt-BR',
		createdAt: '2026-10-16T12:00:00Z',
		...overrides
	};
}

export interface Actor {
	user: SeededUser;
	locals: AuthLocals;
}

export async function actor(
	options: { verified?: boolean; banned?: boolean } = {}
): Promise<Actor> {
	const verified = options.verified ?? true;
	const banned = options.banned ?? false;
	const user = await seedUser({ username: nick('cv'), verified, banned });
	return { user, locals: locals(user, uid('session'), { emailVerified: verified, banned }) };
}

export const ANON: AuthLocals = { user: null, session: null };

// ---- Route calls ----------------------------------------------------------------------------

export interface RouteEvent {
	request: Request;
	locals: AuthLocals;
	platform: { env: unknown };
	route: { id: string };
	params: Record<string, string>;
	url: URL;
}

type Handler = (event: RouteEvent) => Promise<Response>;

export interface RouteModule {
	GET?: Handler;
	POST?: Handler;
	PUT?: Handler;
	prerender?: boolean;
}

const ROUTES_DIR = '../../../../src/routes/';

/** Imports `web/src/routes/api/v1/<path>/+server.ts` (computed specifier, like phase3). */
export async function route(path: string): Promise<RouteModule> {
	const specifier = `${ROUTES_DIR}api/v1/${path}+server.ts`;
	return (await import(/* @vite-ignore */ specifier)) as RouteModule;
}

export interface CallInit {
	locals?: AuthLocals;
	id?: string;
	body?: unknown;
	query?: string;
	headers?: Record<string, string>;
}

function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 1}`;
}

export async function call(
	module: RouteModule,
	method: 'GET' | 'POST' | 'PUT',
	init: CallInit = {}
): Promise<Response> {
	const handler = module[method];
	if (!handler) throw new Error(`route has no ${method}`);
	const unsafe = method !== 'GET';
	const url = new URL(`${ORIGIN}/api/v1/test${init.query ?? ''}`);
	const headers: Record<string, string> = {
		'cf-connecting-ip': randomIp(),
		...(unsafe ? { origin: ORIGIN } : {}),
		...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
		...init.headers
	};
	return handler({
		request: new Request(url, {
			method,
			headers,
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
		}),
		locals: init.locals ?? ANON,
		platform: { env },
		route: { id: '/api/v1/test' },
		params: init.id === undefined ? {} : { id: init.id },
		url
	});
}

export async function expectError(
	response: Response,
	status: number,
	code: ApiErrorCode
): Promise<{ code: string; details?: unknown }> {
	expect(response.status).toBe(status);
	const body = (await response.json()) as { error: { code: string; details?: unknown } };
	expect(body.error.code).toBe(code);
	return body.error;
}

/** Publishes through the service (real gate unless `gate` is given). */
export async function published(
	owner: Actor,
	options: {
		visibility?: LineageVisibility;
		envelope?: Record<string, unknown>;
		gate?: typeof gateForWrite;
	} = {}
): Promise<PublishedInfo> {
	return publishCurve(
		env.DB,
		owner.user.id,
		{
			envelope: options.envelope ?? envelopeOf(presetCurve(0)),
			visibility: options.visibility ?? 'public'
		},
		options.gate ? { gate: options.gate } : {}
	);
}
