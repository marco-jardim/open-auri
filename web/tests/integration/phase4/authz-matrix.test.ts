// T4.T authorization matrix: anonymous × banned × unverified × verified × admin × owner for EVERY
// `/api/v1` endpoint, through the real `+server.ts` exports, plus `/og/[id].png`, the `/c/[id]`
// and `/u/[apelido]` loads.
//
// Self-checking: the route files are enumerated with `import.meta.glob`; a route file (or an
// exported method) missing from TABLE, or a TABLE entry without a file, fails the first test, so a
// new endpoint cannot skip the matrix.
//
// Rules asserted (handler kit, social/README.md):
// - `user`/`verified` routes: anonymous → 401 AUTH_REQUIRED, banned → 403 BANNED, unverified on
//   `verified` routes → 403 EMAIL_NOT_VERIFIED;
// - `public` routes: a banned session is treated as signed out (never an auth error);
// - owner-scoped routes: everyone but the owner (admins included: the admin flag is never
//   inferred) → 404 NOT_FOUND, the owner gets the success status;
// - every other persona that passes the guards never sees an auth error code nor a 5xx.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ogResponse } from '#lib/server/og/route.ts';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import { publishCurve, retractCurve, type PublishedInfo } from '#lib/server/social/curves.ts';
import { createOwnPack } from '#lib/server/social/packs.ts';
import { createTrade } from '#lib/server/social/repo.ts';
import { createShareFor } from '#lib/server/social/shares.ts';
import { envelopeOf, presetCurve } from '../social/curves/helpers.ts';
import {
	ANONYMOUS,
	errorCode,
	exportedMethods,
	invoke,
	loadStatus,
	member,
	missingId,
	PERSONAS,
	randomIp,
	syntheticEvent,
	type CallInit,
	type Member,
	type Method,
	type PersonaName
} from './helpers.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const ROUTE_FILES = import.meta.glob('../../../src/routes/api/v1/**/+server.ts');

function routeIdOf(file: string): string {
	return /\/api\/v1\/(.+)\/\+server\.ts$/.exec(file)?.[1] ?? file;
}

const MODULES = new Map(
	Object.entries(ROUTE_FILES).map(([file, load]) => [routeIdOf(file), load] as const)
);

// ---- Fixtures --------------------------------------------------------------------------------

interface Fixtures {
	owner: Member;
	trader: Member;
	others: Record<'banned' | 'unverified' | 'verified' | 'admin', Member>;
	lineage: PublishedInfo;
	privateLineage: PublishedInfo;
	versions: PublishedInfo;
	retract: PublishedInfo;
	restore: PublishedInfo;
	visibility: PublishedInfo;
	packGet: string;
	packPut: string;
	packDelete: string;
	share: string;
	trade: string;
}

let fx: Fixtures;

async function publishOwn(
	owner: Member,
	visibility: 'public' | 'unlisted' | 'private' = 'public'
): Promise<PublishedInfo> {
	return publishCurve(env.DB, owner.user.id, {
		envelope: envelopeOf(presetCurve(0)),
		visibility
	});
}

beforeAll(async () => {
	const owner = await member({ prefix: 'p4own' });
	const trader = await member({ prefix: 'p4trd' });
	const others = {
		banned: await member({ banned: true, prefix: 'p4ban' }),
		unverified: await member({ verified: false, prefix: 'p4unv' }),
		verified: await member({ prefix: 'p4ver' }),
		admin: await member({ admin: true, prefix: 'p4adm' })
	};
	const lineage = await publishOwn(owner);
	const privateLineage = await publishOwn(owner, 'private');
	const versions = await publishOwn(owner);
	const retract = await publishOwn(owner);
	const restore = await publishOwn(owner);
	await retractCurve(env.DB, owner.user.id, restore.lineageId);
	const visibility = await publishOwn(owner, 'private');
	const now = Date.now();
	const pack = async (name: string, packVisibility: 'public' | 'private') =>
		(await createOwnPack(env.DB, owner.user.id, { name, visibility: packVisibility }, now)).id;
	const share = await createShareFor(env.DB, owner.user.id, { lineageId: lineage.lineageId });

	// The trade's owner is unverified in D1 right after joining: it can never be a pairing
	// candidate for trades of other test files (pairing counts verified users only), while its
	// `locals` (what the route guards read) stay verified.
	const tradeId = crypto.randomUUID();
	const created = await createTrade(env.DB, {
		id: tradeId,
		userId: trader.user.id,
		lineageId: lineage.lineageId,
		versionId: lineage.versionId,
		now
	});
	await env.DB.prepare('UPDATE "user" SET "emailVerified" = 0 WHERE "id" = ?')
		.bind(trader.user.id)
		.run();
	if (!created.ok) throw new Error(`trade fixture failed: ${created.code}`);

	fx = {
		owner,
		trader,
		others,
		lineage,
		privateLineage,
		versions,
		retract,
		restore,
		visibility,
		packGet: await pack('Matrix public pack', 'public'),
		packPut: await pack('Matrix pack to edit', 'private'),
		packDelete: await pack('Matrix pack to delete', 'private'),
		share: share.shareId,
		trade: tradeId
	};
});

// ---- Matrix table ----------------------------------------------------------------------------

type Level = 'public' | 'user' | 'verified';

/** Expected result; without `status`, any status below 500 that is not an auth error. */
interface Outcome {
	status?: readonly number[];
	code?: string;
}

interface Spec {
	auth: Level;
	/** Owner-scoped: only this fixture member succeeds; everyone else gets 404. */
	owner?: 'owner' | 'trader';
	/** Owner's outcome (default 2xx). */
	ownerOutcome?: Outcome;
	/** Outcome of every persona that passes the guards (default 2xx). */
	allowed?: Outcome;
	request: (fixtures: Fixtures) => CallInit;
}

const OK: Outcome = { status: [200, 201, 202, 204] };
const NOT_FOUND: Outcome = { status: [404], code: 'NOT_FOUND' };
const AUTH_CODES = ['AUTH_REQUIRED', 'EMAIL_NOT_VERIFIED', 'BANNED', 'BAD_ORIGIN'];

const onLineage = (f: Fixtures): CallInit => ({ params: { id: f.lineage.lineageId } });

const TABLE: Record<string, Partial<Record<Method, Spec>>> = {
	curves: {
		POST: {
			auth: 'verified',
			request: () => ({
				body: { envelope: envelopeOf(presetCurve(2)), visibility: 'private' }
			})
		}
	},
	'curves/[id]': { GET: { auth: 'public', request: onLineage } },
	'curves/[id]/activity': {
		POST: {
			auth: 'verified',
			request: (f) => ({
				params: { id: f.lineage.lineageId },
				body: { kind: 'installed', eventId: crypto.randomUUID() }
			})
		}
	},
	'curves/[id]/audience': { GET: { auth: 'user', owner: 'owner', request: onLineage } },
	'curves/[id]/favorite': {
		PUT: { auth: 'verified', request: onLineage },
		DELETE: { auth: 'verified', request: onLineage }
	},
	feed: { GET: { auth: 'public', request: () => ({}) } },
	'lineages/[id]': { GET: { auth: 'public', request: onLineage } },
	'lineages/[id]/fork': {
		POST: { auth: 'verified', request: (f) => ({ ...onLineage(f), body: {} }) }
	},
	'lineages/[id]/restore': {
		POST: {
			auth: 'verified',
			owner: 'owner',
			request: (f) => ({ params: { id: f.restore.lineageId } })
		}
	},
	'lineages/[id]/retract': {
		POST: {
			auth: 'user',
			owner: 'owner',
			request: (f) => ({ params: { id: f.retract.lineageId } })
		}
	},
	'lineages/[id]/versions': {
		POST: {
			auth: 'verified',
			owner: 'owner',
			request: (f) => ({
				params: { id: f.versions.lineageId },
				body: { parentVersionId: f.versions.versionId, envelope: envelopeOf(presetCurve(3)) }
			})
		}
	},
	'lineages/[id]/visibility': {
		PUT: {
			auth: 'verified',
			owner: 'owner',
			request: (f) => ({
				params: { id: f.visibility.lineageId },
				body: { visibility: 'unlisted' }
			})
		}
	},
	'me/activity': {
		GET: { auth: 'user', request: () => ({}) },
		DELETE: { auth: 'user', request: () => ({}) }
	},
	'me/activity/outbox': {
		POST: {
			auth: 'verified',
			request: (f) => ({
				body: {
					events: [
						{ kind: 'installed', eventId: crypto.randomUUID(), lineageId: f.lineage.lineageId }
					]
				}
			})
		}
	},
	'me/library': { GET: { auth: 'user', request: () => ({ query: '?shelf=created' }) } },
	'me/library/merge': {
		// An empty batch: the guards are what this row checks (merge itself: library/merge.test.ts).
		POST: {
			auth: 'verified',
			allowed: { status: [400], code: 'INVALID_BODY' },
			request: () => ({ body: { items: [] } })
		}
	},
	'me/packs': { GET: { auth: 'user', request: () => ({}) } },
	'me/shares': { GET: { auth: 'user', request: () => ({}) } },
	packs: {
		POST: {
			auth: 'verified',
			request: () => ({ body: { name: 'Matrix pack', visibility: 'private' } })
		}
	},
	'packs/[id]': {
		GET: { auth: 'public', request: (f) => ({ params: { id: f.packGet } }) },
		PUT: {
			auth: 'verified',
			owner: 'owner',
			request: (f) => ({ params: { id: f.packPut }, body: { name: 'Renamed matrix pack' } })
		},
		DELETE: { auth: 'user', owner: 'owner', request: (f) => ({ params: { id: f.packDelete } }) }
	},
	rankings: { GET: { auth: 'public', request: () => ({}) } },
	reports: {
		// No Turnstile token: past the guards the next refusal is TURNSTILE_FAILED (403).
		POST: {
			auth: 'verified',
			allowed: { status: [403], code: 'TURNSTILE_FAILED' },
			request: (f) => ({
				body: { targetKind: 'lineage', targetId: f.lineage.lineageId, reason: 'spam' }
			})
		}
	},
	// S6 is anonymous by design (no user stored); without a token or consent it is refused for
	// everyone alike, never with an auth code.
	's6/batches': { POST: { auth: 'public', allowed: {}, request: () => ({ body: {} }) } },
	's6/batches/[receipt]': {
		DELETE: { auth: 'public', request: () => ({ params: { receipt: 'not-a-receipt' } }) }
	},
	's6/preferences': {
		GET: { auth: 'public', allowed: { status: [200, 404] }, request: () => ({}) }
	},
	shares: {
		POST: {
			auth: 'verified',
			request: (f) => ({ body: { lineageId: f.lineage.lineageId, channel: 'link' } })
		}
	},
	'shares/[id]/open': { POST: { auth: 'public', request: (f) => ({ params: { id: f.share } }) } },
	'shares/[id]/stats': {
		GET: { auth: 'user', owner: 'owner', request: (f) => ({ params: { id: f.share } }) }
	},
	trades: {
		// A missing lineage: no trade is ever created by the matrix at the real clock.
		POST: {
			auth: 'verified',
			allowed: NOT_FOUND,
			request: () => ({ body: { lineageId: missingId() } })
		}
	},
	'trades/me': { GET: { auth: 'verified', request: () => ({}) } },
	// The fixture trade is waiting: scoring it is a 409 CONFLICT for its owner (not matched).
	'trades/[id]/score': {
		POST: {
			auth: 'verified',
			owner: 'trader',
			ownerOutcome: { status: [409], code: 'CONFLICT' },
			request: (f) => ({ params: { id: f.trade }, body: { score: 3 } })
		}
	},
	'trades/[id]': {
		DELETE: { auth: 'verified', owner: 'trader', request: (f) => ({ params: { id: f.trade } }) }
	},
	'users/[apelido]': {
		GET: { auth: 'public', request: (f) => ({ params: { apelido: f.owner.user.username } }) }
	}
};

function expectation(spec: Spec, persona: PersonaName): Outcome {
	if (spec.auth !== 'public') {
		if (persona === 'anonymous') return { status: [401], code: 'AUTH_REQUIRED' };
		if (persona === 'banned') return { status: [403], code: 'BANNED' };
		if (persona === 'unverified' && spec.auth === 'verified') {
			return { status: [403], code: 'EMAIL_NOT_VERIFIED' };
		}
	}
	if (spec.owner) return persona === 'owner' ? (spec.ownerOutcome ?? OK) : NOT_FOUND;
	return spec.allowed ?? OK;
}

function localsOf(spec: Spec, persona: PersonaName): AuthLocals {
	if (persona === 'anonymous') return ANONYMOUS;
	if (persona === 'owner') return fx[spec.owner ?? 'owner'].locals;
	return fx.others[persona].locals;
}

// ---- Self-check --------------------------------------------------------------------------------

describe('matrix table × route files', () => {
	it('every /api/v1 route file is in the table and every table row has a file', () => {
		const files = [...MODULES.keys()].sort();
		expect(files.length).toBeGreaterThanOrEqual(33);
		expect(Object.keys(TABLE).sort()).toEqual(files);
	});

	it('every exported method has a row (and no row names a missing export); prerender = false', async () => {
		for (const [id, load] of MODULES) {
			const module = await load();
			const declared = Object.keys(TABLE[id] ?? {}).sort();
			expect(exportedMethods(module).sort(), id).toEqual(declared);
			expect(Reflect.get(module ?? {}, 'prerender'), id).toBe(false);
		}
	});
});

// ---- The matrix ----------------------------------------------------------------------------------

describe('/api/v1 × personas', () => {
	for (const [id, methods] of Object.entries(TABLE)) {
		for (const [method, spec] of Object.entries(methods) as [Method, Spec][]) {
			it(`${method} /api/v1/${id}`, async () => {
				const load = MODULES.get(id);
				if (!load) throw new Error(`no route file for ${id}`);
				const module = await load();
				for (const persona of PERSONAS) {
					const label = `${method} /api/v1/${id} as ${persona}`;
					const event = syntheticEvent(id, method, localsOf(spec, persona), spec.request(fx));
					const response = await invoke(module, method, event);
					const code = await errorCode(response);
					const outcome = expectation(spec, persona);
					if (outcome.status) expect(outcome.status, label).toContain(response.status);
					expect(response.status, label).toBeLessThan(500);
					if (outcome.code) expect(code, label).toBe(outcome.code);
					const guarded = outcome.code !== undefined && AUTH_CODES.includes(outcome.code);
					if (!guarded) expect(AUTH_CODES, label).not.toContain(code);
				}
			});
		}
	}
});

// ---- Public pages and the OG image ---------------------------------------------------------------

interface PageModule {
	load: (event: unknown) => Promise<unknown>;
}

async function pageModule(path: string): Promise<PageModule> {
	const module: unknown = await import(/* @vite-ignore */ `../../../src/routes/${path}`);
	const load: unknown = typeof module === 'object' && module ? Reflect.get(module, 'load') : null;
	if (typeof load !== 'function') throw new Error(`${path} has no load`);
	return { load: async (event) => Reflect.apply(load, undefined, [event]) };
}

function pageEvent(path: string, who: AuthLocals, params: Record<string, string>) {
	const url = new URL(path, env.PUBLIC_ORIGIN);
	return {
		params,
		url,
		request: new Request(url, { headers: { 'cf-connecting-ip': randomIp() } }),
		locals: who,
		platform: { env }
	};
}

function personaLocals(persona: PersonaName): AuthLocals {
	if (persona === 'anonymous') return ANONYMOUS;
	if (persona === 'owner') return fx.owner.locals;
	return fx.others[persona].locals;
}

const fakePng = async (svg: string): Promise<Uint8Array> => new TextEncoder().encode(svg);

describe('/c/[id], /u/[apelido] and /og/[id].png × personas', () => {
	it('/c/[id]: public for everyone; a private lineage only for its owner (404 otherwise)', async () => {
		const page = await pageModule('c/[id]/+page.server.ts');
		for (const persona of PERSONAS) {
			const who = personaLocals(persona);
			const open = pageEvent(`/c/${fx.lineage.lineageId}`, who, { id: fx.lineage.lineageId });
			expect(await loadStatus(() => page.load(open)), persona).toBe(200);
			const hidden = fx.privateLineage.lineageId;
			const closed = pageEvent(`/c/${hidden}`, who, { id: hidden });
			const status = await loadStatus(() => page.load(closed));
			expect(status, persona).toBe(persona === 'owner' ? 200 : 404);
		}
	});

	it('/u/[apelido]: the same profile for every persona; a banned user is 404 for everyone', async () => {
		const page = await pageModule('u/[apelido]/+page.server.ts');
		for (const persona of PERSONAS) {
			const who = personaLocals(persona);
			const nickname = fx.owner.user.username;
			const own = pageEvent(`/u/${nickname}`, who, { apelido: nickname });
			expect(await loadStatus(() => page.load(own)), persona).toBe(200);
			const banned = fx.others.banned.user.username;
			const gone = pageEvent(`/u/${banned}`, who, { apelido: banned });
			expect(await loadStatus(() => page.load(gone)), persona).toBe(404);
		}
	});

	it('/og/[id].png: public version for everyone; private version 404 for everyone, owner too', async () => {
		const route = await import('../../../src/routes/og/[id].png/+server.ts');
		expect(route.prerender).toBe(false);
		expect(typeof route.GET).toBe('function');
		for (const persona of PERSONAS) {
			const who = personaLocals(persona);
			const event = (id: string) => ({
				...pageEvent(`/og/${id}.png`, who, { id }),
				platform: { env, ctx: { waitUntil: (promise: Promise<unknown>) => void promise } }
			});
			const open = await ogResponse(event(fx.lineage.versionId), { render: fakePng });
			expect(open.status, persona).toBe(200);
			const hidden = await ogResponse(event(fx.privateLineage.versionId), { render: fakePng });
			expect(hidden.status, persona).toBe(404);
		}
	});
});
