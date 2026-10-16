// Fixtures of the personal library tests (T4.3): verified members with route locals, synthetic
// API events for the real `+server.ts` handlers, and S1 strings the real gate accepts (the official
// presets) or refuses (HS shelves, unique per call). Every user and lineage is unique per test, so
// the files can share the database.
import { env } from 'cloudflare:workers';
import { encodeS1 } from 'open-auri/share';
import type { ApiEvent } from '#lib/server/api/index.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import reference from '../../../../../test/fixtures/eq0xcb.reference.json';
import { locals, seedUser, type SeededUser } from '../../account/helpers.ts';
import { ban, count, curveInput, nick, publish, sid } from '../repo/helpers.ts';

export { ban, count, curveInput, publish, sid };

export const ORIGIN: string = env.PUBLIC_ORIGIN;

type Curve = Parameters<typeof encodeS1>[0];
type Band = Curve['bands'][number];

export const PRESETS: Curve[] = Object.values(reference.presets).map((preset) => ({
	bands: preset.eqBands as Band[],
	preampDb: preset.preampDb
}));

/** S1 of the official preset `index` (accepted by the gate). */
export function presetS1(index: number): string {
	const curve = PRESETS[index % PRESETS.length];
	if (!curve) throw new Error('no preset');
	return encodeS1(curve);
}

function randomInt(min: number, max: number): number {
	const [value] = crypto.getRandomValues(new Uint32Array(1));
	return min + ((value ?? 0) % (max - min + 1));
}

/** A unique curve the gate refuses (`k:kind-not-allowed`: HS shelves outside the lab layer). */
export function rejectedS1(): string {
	const base = PRESETS[0];
	if (!base) throw new Error('no preset');
	const shelf = (): Band => ({
		kind: 'HS',
		freqHz: randomInt(1000, 15999),
		gainDb: -randomInt(1, 60) / 10,
		qFactor: 0.71
	});
	return encodeS1({ bands: [shelf(), shelf(), ...base.bands.slice(2)], preampDb: base.preampDb });
}

export interface Member {
	user: SeededUser;
	locals: AuthLocals;
}

/** A user seeded in D1 plus the locals hooks.server.ts would build (verified unless told not). */
export async function member(options: { verified?: boolean } = {}): Promise<Member> {
	const verified = options.verified !== false;
	const user = await seedUser({ username: nick('lib'), verified });
	return { user, locals: locals(user, sid('session'), { emailVerified: verified }) };
}

export const SIGNED_OUT: AuthLocals = { user: null, session: null };

export interface EventInit {
	method?: string;
	path: string;
	locals: AuthLocals;
	body?: unknown;
	params?: Record<string, string>;
	headers?: Record<string, string>;
}

export interface RouteEvent extends ApiEvent {
	params: { id: string };
}

function randomIp(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(3));
	return `10.${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 1}`;
}

/** Synthetic event for a route handler (same origin, JSON body when given). */
export function routeEvent(init: EventInit): RouteEvent {
	const method = init.method ?? 'GET';
	const unsafe = method !== 'GET' && method !== 'HEAD';
	const headers: Record<string, string> = {
		'cf-connecting-ip': randomIp(),
		...(unsafe ? { origin: ORIGIN } : {}),
		...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
		...init.headers
	};
	return {
		request: new Request(`${ORIGIN}${init.path}`, {
			method,
			headers,
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
		}),
		locals: init.locals,
		platform: { env },
		route: { id: init.path.split('?')[0] ?? init.path },
		params: { id: init.params?.id ?? '' }
	};
}

export async function bodyOf<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

export async function errorCode(response: Response): Promise<string> {
	const body = await bodyOf<{ error?: { code?: string } }>(response);
	return body.error?.code ?? '';
}
