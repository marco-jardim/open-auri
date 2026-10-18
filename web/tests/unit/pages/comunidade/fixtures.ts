// Shared fixtures of the Comunidade component tests (T4.13): feed items, published curves and a
// routed fake `fetch` for `createSocialApi`.
import { vi } from 'vitest';
import { encodeS1 } from 'open-auri/share';
import { neutralCurve } from '#lib/state/model.ts';
import { createSocialApi, type SocialFetch } from '#lib/social/index.ts';
import type { SessionView } from '#lib/components/pages/comunidade/model.ts';

export const NEUTRAL = neutralCurve();
export const S1_NEUTRAL = encodeS1(NEUTRAL);
export const S1_BOOST = encodeS1({
	preampDb: -3,
	bands: [
		{ kind: 'PK' as const, freqHz: 1000, gainDb: -3, qFactor: 1.41 },
		...NEUTRAL.bands.slice(1)
	]
});

export const ANONYMOUS: SessionView = {
	known: true,
	signedIn: false,
	verified: false,
	nickname: null
};
export const VERIFIED: SessionView = {
	known: true,
	signedIn: true,
	verified: true,
	nickname: 'geoff'
};

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

export function apiError(code: string, status: number, details?: unknown): Response {
	return json({ error: details === undefined ? { code } : { code, details } }, status);
}

export function feedItem(
	overrides: { id?: string; name?: string; s1?: string; author?: unknown; license?: string } = {}
) {
	const id = overrides.id ?? 'lin-aaaaaaaaaaaa';
	const s1 = overrides.s1 ?? S1_NEUTRAL;
	return {
		lineage: {
			id,
			ownerUserId: null,
			forkedFromVersion: null,
			headVersion: `ver-${id}`,
			visibility: 'public',
			status: 'active',
			moderation: 'visible',
			curated: false,
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
			author:
				overrides.author === undefined
					? { username: 'geoff', displayUsername: 'Geoff' }
					: overrides.author,
			head: {
				id: `ver-${id}`,
				lineageId: id,
				parentId: null,
				curveId: `c${id.slice(-11)}`,
				name: overrides.name ?? 'Rádio de madrugada',
				description: '',
				license: overrides.license ?? 'CC-BY-4.0',
				recipe: null,
				lang: 'pt-BR',
				createdAt: 1_700_000_000_000
			},
			curve: {
				id: `c${id.slice(-11)}`,
				s1,
				canonKey: 'k',
				gateVer: 'v2:test',
				gateOk: true,
				gateReasons: [],
				levelDb: null,
				createdAt: 1_700_000_000_000
			}
		},
		rank: null,
		score: null
	};
}

export function feedPage(items: unknown[], nextCursor: string | null = null) {
	return { sort: 'new', window: null, computedAt: null, items, nextCursor };
}

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;

/** A fake `fetch` answering by route; unknown routes answer 404 NOT_FOUND. */
export function fakeFetch(route: Route) {
	return vi.fn<SocialFetch>(async (input, init) => {
		const url = new URL(input, 'https://example.test');
		const answer = await route(url, init);
		return answer ?? apiError('NOT_FOUND', 404);
	});
}

export function apiWith(fetch: SocialFetch, online = true) {
	return createSocialApi({ fetch, online: () => online });
}

export function headerOf(init: RequestInit | undefined, name: string): string | null {
	return new Headers(init?.headers).get(name);
}

/** The text of everything an element's aria-describedby points to (the Button's reason). */
export function reasonOf(element: Element): string {
	const ids = element.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
	return ids
		.map((value) => document.getElementById(value)?.textContent?.trim() ?? '')
		.join(' ')
		.trim();
}

/** Visible notes with exactly this text (the reason tooltip may hold the same words). */
export function notesWith(text: string): Element[] {
	return Array.from(document.querySelectorAll('p.note')).filter(
		(node) => node.textContent?.trim() === text
	);
}

/** The panel's live status line (`<p class="note" role="status">`), or null when not rendered. */
export function statusOf(testId: string): string | null {
	const node = document.querySelector(`[data-testid="${testId}"] p.note[role="status"]`);
	return node ? (node.textContent?.trim() ?? '') : null;
}

/** A promise the test settles by hand (a request still running). */
export function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Activates a control the way a script would, past the browser's actionability checks. */
export function domClick(element: Element) {
	if (element instanceof HTMLElement) element.click();
}
