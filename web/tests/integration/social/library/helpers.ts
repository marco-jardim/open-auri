// Fixtures of the personal library tests (T4.3): verified members with route locals, synthetic
// API events for the real `+server.ts` handlers, and S1 strings the real gate accepts (the official
// presets), classifies as YOLO or refuses in every profile (unique per call). Every user and
// lineage is unique per test, so
// the files can share the database.
import { env } from 'cloudflare:workers';
import { NEUTRAL_BANDS } from 'open-auri/dsp';
import { encodeS1 } from 'open-auri/share';
import type { ApiEvent } from '#lib/server/api/index.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import reference from '../../../../../test/fixtures/eq0xcb.reference.json';
import { locals, seedUser, type SeededUser } from '../../account/helpers.ts';
import { randomInt, randomTenths } from '../../random.ts';
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

/**
 * A unique curve the gate refuses in every profile: two +12 dB peaks at a 0 dB preamp
 * (`e:output-audible`, hard). HS shelves are standard on the server since GATE_IMPL 2.
 */
export function rejectedS1(): string {
	const base = PRESETS[0];
	if (!base) throw new Error('no preset');
	const peak = (): Band => ({
		kind: 'PK',
		freqHz: randomInt(800, 4000),
		gainDb: 12,
		qFactor: 1
	});
	return encodeS1({ bands: [peak(), peak(), ...base.bands.slice(2)], preampDb: 0 });
}

/**
 * A unique YOLO curve: neutral bands with one small PK boost above 16 kHz
 * (`d7:pk-boost-above-16k`, waived by the YOLO profile) and every hard check far inside the limits.
 */
export function yoloS1(): string {
	const boost: Band = {
		kind: 'PK',
		freqHz: randomInt(16_200, 19_800),
		gainDb: randomTenths(5, 15),
		qFactor: 1
	};
	const bands = NEUTRAL_BANDS.map((neutral, i) => (i === 0 ? boost : neutral)) as Band[];
	return encodeS1({ bands, preampDb: randomTenths(-90, -60) });
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
