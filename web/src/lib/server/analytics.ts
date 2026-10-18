// Simple Analytics (operator request): a privacy-first page-view counter with no cookies, no
// personal data and no fingerprinting, whose public dashboard the footer links. Loaded on the
// production site only: never on localhost, the Playwright servers (4173/4174), staging
// (workers.dev) or CI, so tests stay offline and staging adds no noise to the counters.
//
// Mechanism: app.html ends <body> with {@link ANALYTICS_PLACEHOLDER}; the `analytics` handle of
// hooks.server.ts replaces it through `transformPageChunk` with the provider's snippet, or with
// nothing. No inline script: the tag is the provider's external `<script async src>`. One rule
// covers both delivery paths:
//   - prerendered pages (static HTML served from Workers Static Assets): the handle runs while
//     prerendering, where there is no real host, so the decision is the PUBLIC_ORIGIN the build
//     embeds (`$app/env/public`, static). tools/deploy.mjs builds with PUBLIC_ORIGIN equal to its
//     PRODUCTION_ORIGIN only for `--env production`; staging builds with its workers.dev origin,
//     CI with its fixture origin and local builds with the .env value;
//   - SSR responses: the build value AND the origin of the request must both be the production
//     origin, so a build served on localhost never renders the tag, whatever the .env says.
// CSP (vite.config.ts and STATIC_DOCUMENT_CSP_DIRECTIVES in security/headers.ts): the script host
// is in `script-src`, the beacon host in `connect-src` and `img-src`. The tag carries no nonce:
// it is allowed by host, since the policy has no 'strict-dynamic'. The service worker handles
// same-origin requests only (lib/pwa/strategy.ts), so it never caches the script or the beacons.
import type { Handle } from '@sveltejs/kit/hooks';

/** The production origin; must equal PRODUCTION_ORIGIN of tools/deploy.mjs (unit test). */
export const PRODUCTION_ORIGIN = 'https://open-auri.com';
/** Serves latest.js (CSP `script-src`). */
export const ANALYTICS_SCRIPT_HOST = 'https://scripts.simpleanalyticscdn.com';
/** Receives the page-view beacons (CSP `connect-src` and `img-src`). */
export const ANALYTICS_BEACON_HOST = 'https://queue.simpleanalyticscdn.com';
/** Placeholder at the end of <body> in app.html, always replaced (by the snippet or by ''). */
export const ANALYTICS_PLACEHOLDER = '%analytics%';
/** The provider's snippet, unchanged: its comment, the official src and `async`. */
export const ANALYTICS_SNIPPET =
	'<!-- 100% privacy-first analytics -->\n' +
	`\t\t<script async src="${ANALYTICS_SCRIPT_HOST}/latest.js"></script>`;

function originOf(value: string): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

export interface AnalyticsGate {
	/** PUBLIC_ORIGIN embedded by the build (#lib/config/public.ts). */
	buildOrigin: string;
	/** Origin of the request being rendered; undefined while prerendering (no real host). */
	requestOrigin?: string;
}

/** Whether the page gets the analytics tag: only when it is served from the production origin. */
export function analyticsEnabled({ buildOrigin, requestOrigin }: AnalyticsGate): boolean {
	if (originOf(buildOrigin) !== PRODUCTION_ORIGIN) return false;
	return requestOrigin === undefined || originOf(requestOrigin) === PRODUCTION_ORIGIN;
}

/** Fills the app.html placeholder with the snippet (enabled) or removes it. */
export function injectAnalytics(html: string, enabled: boolean): string {
	return html.replace(ANALYTICS_PLACEHOLDER, () => (enabled ? ANALYTICS_SNIPPET : ''));
}

export interface AnalyticsHandleOptions {
	/** `building` from `$app/env`: true while prerendering. */
	building: boolean;
	/** PUBLIC_ORIGIN embedded by the build. */
	buildOrigin: string;
}

/** Handle factory for hooks.server.ts (kept here so it is unit-testable without `$app/*`). */
export function createAnalyticsHandle({ building, buildOrigin }: AnalyticsHandleOptions): Handle {
	return ({ event, resolve }) => {
		const enabled = analyticsEnabled({
			buildOrigin,
			requestOrigin: building ? undefined : event.url.origin
		});
		return resolve(event, { transformPageChunk: ({ html }) => injectAnalytics(html, enabled) });
	};
}
