// Security headers of plan §3.8, for every response the Worker produces (T3.5 applies them in
// hooks.server.ts with `applySecurityHeaders`), plus the same set for files served directly by
// Workers Static Assets (prerendered pages and /_app assets never reach the Worker): see
// `renderStaticHeadersFile`, whose output must be the content of web/_headers (adapter-cloudflare
// reads `_headers` from the project root, refuses one in static/, and appends its cache rules).
//
// CSP coordination with SvelteKit: Kit owns the document CSP (`csp` in vite.config.ts, mode
// 'auto': a header with nonces on SSR responses, a <meta> tag with hashes on prerendered pages).
// This module never replaces that policy. `frame-ancestors` is ignored inside <meta>, so it is
// enforced by (a) X-Frame-Options: DENY, (b) an extra, separate `frame-ancestors 'none'` policy
// appended when the response's CSP lacks one (multiple policies are all enforced, so this only
// tightens), and (c) the static policy of web/_headers for prerendered pages. Non-HTML
// responses get a locked-down `default-src 'none'` policy.
//
// T5.4: the document policy has no 'unsafe-inline' for scripts or <style> elements (Kit adds
// nonces or hashes); only style="" attributes are allowed, through `style-src-attr`. Prerendered
// pages carry that policy in a <meta>, which the browser applies only from where it is parsed
// and which cannot hold `frame-ancestors`. So web/_headers adds, from the first byte, a second
// policy with every document directive that does not depend on per-page hashes
// ({@link STATIC_DOCUMENT_CSP}). It has no `default-src`, `script-src` or `style-src*`: those
// would block the hashed inline scripts (all enforced policies must allow a resource). The same
// header reaches /_app scripts, where it is the policy of dedicated workers: they only compute,
// so `connect-src 'self'` and the rest fit them too.
//
// Simple Analytics (../analytics.ts): its beacon host is in `img-src` and `connect-src` here as
// in vite.config.ts, since every enforced policy must allow the beacons; its script host is in
// Kit's `script-src` only (this policy has none).

export const HSTS = 'max-age=63072000; includeSubDomains';
export const FRAME_ANCESTORS_POLICY = "frame-ancestors 'none'";
export const NON_HTML_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Document directives repeated in web/_headers, in SvelteKit's notation (keywords unquoted). Must
 * match the `csp.directives` of vite.config.ts (unit test). `frame-ancestors` comes first so the
 * header still starts with {@link FRAME_ANCESTORS_POLICY}.
 */
export const STATIC_DOCUMENT_CSP_DIRECTIVES: ReadonlyArray<readonly [string, readonly string[]]> = [
	['frame-ancestors', ['none']],
	['object-src', ['none']],
	['base-uri', ['self']],
	['form-action', ['self']],
	['img-src', ['self', 'data:', 'blob:', 'https://queue.simpleanalyticscdn.com']],
	['font-src', ['self']],
	['connect-src', ['self', 'https://queue.simpleanalyticscdn.com']],
	['media-src', ['self', 'blob:']],
	['worker-src', ['self']],
	['frame-src', ['https://challenges.cloudflare.com']],
	['manifest-src', ['self']]
];

const CSP_KEYWORDS = new Set(['none', 'self', 'unsafe-inline', 'strict-dynamic', 'unsafe-eval']);

/** Renders Kit-style source lists as a CSP string (keywords quoted, like Kit does). */
export function renderCsp(directives: ReadonlyArray<readonly [string, readonly string[]]>): string {
	return directives
		.map(([name, sources]) =>
			[name, ...sources.map((source) => (CSP_KEYWORDS.has(source) ? `'${source}'` : source))].join(
				' '
			)
		)
		.join('; ');
}

/** The extra CSP of web/_headers (prerendered pages and /_app files). */
export const STATIC_DOCUMENT_CSP = renderCsp(STATIC_DOCUMENT_CSP_DIRECTIVES);

/**
 * `hid=(self)` for the cable (WebHID). Audio previews use Web Audio started by a user gesture, so
 * `autoplay=(self)` keeps same-origin playback working and blocks frames; the clipboard is used by
 * share/export buttons. Every other powerful feature is off, including inside the Turnstile frame.
 * The app never calls getUserMedia (audio comes from files the user picks), so the microphone and
 * the camera stay off.
 */
export const PERMISSIONS_POLICY = [
	'hid=(self)',
	'autoplay=(self)',
	'clipboard-write=(self)',
	'accelerometer=()',
	'ambient-light-sensor=()',
	'bluetooth=()',
	'browsing-topics=()',
	'camera=()',
	'display-capture=()',
	'encrypted-media=()',
	'fullscreen=()',
	'geolocation=()',
	'gyroscope=()',
	'idle-detection=()',
	'local-fonts=()',
	'magnetometer=()',
	'microphone=()',
	'midi=()',
	'otp-credentials=()',
	'payment=()',
	'publickey-credentials-create=()',
	'publickey-credentials-get=()',
	'screen-wake-lock=()',
	'serial=()',
	'usb=()',
	'window-management=()',
	'xr-spatial-tracking=()'
].join(', ');

export interface SecurityHeaderOptions {
	/** PUBLIC_ORIGIN; HSTS is only sent when it is https. */
	origin: string;
	/** HTML documents keep Kit's CSP; other responses get {@link NON_HTML_CSP}. */
	isHtml: boolean;
	/** Override for resources meant to be embedded cross-origin (e.g. OG images). */
	crossOriginResourcePolicy?: 'same-origin' | 'same-site' | 'cross-origin';
}

function isHttps(origin: string): boolean {
	try {
		return new URL(origin).protocol === 'https:';
	} catch {
		return false;
	}
}

/** Header names are lowercase. HTML responses carry no CSP here (see the module comment). */
export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
	const headers: Record<string, string> = {
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'strict-origin-when-cross-origin',
		'permissions-policy': PERMISSIONS_POLICY,
		'cross-origin-opener-policy': 'same-origin',
		'cross-origin-resource-policy': options.crossOriginResourcePolicy ?? 'same-origin',
		'x-frame-options': 'DENY'
	};
	if (isHttps(options.origin)) headers['strict-transport-security'] = HSTS;
	if (!options.isHtml) headers['content-security-policy'] = NON_HTML_CSP;
	return headers;
}

function contentType(response: Response): string {
	return (response.headers.get('content-type') ?? '').toLowerCase();
}

/**
 * Adds the security headers to `response` (headers already set by a route win, e.g. a CORP
 * override) and makes sure framing is denied by the CSP. Returns the same response when its
 * headers are mutable, otherwise a copy.
 */
export function applySecurityHeaders(response: Response, options: { origin: string }): Response {
	const type = contentType(response);
	const isHtml = type.startsWith('text/html');
	// Worker scripts take the CSP of their own response: never lock them down here.
	const isScript = type.includes('javascript');
	let target = response;
	try {
		target.headers.set('x-content-type-options', 'nosniff');
	} catch {
		target = new Response(response.body, response);
	}
	const headers = target.headers;
	for (const [name, value] of Object.entries(securityHeaders({ origin: options.origin, isHtml }))) {
		if (name === 'content-security-policy') continue;
		if (!headers.has(name)) headers.set(name, value);
	}
	const csp = headers.get('content-security-policy');
	if (csp) {
		if (!/(^|[;,]\s*)frame-ancestors\s/i.test(csp)) {
			headers.append('content-security-policy', FRAME_ANCESTORS_POLICY);
		}
	} else if (!isScript) {
		headers.set('content-security-policy', isHtml ? FRAME_ANCESTORS_POLICY : NON_HTML_CSP);
	}
	return target;
}

/**
 * Content of web/_headers: the same headers for everything Workers Static Assets serves, i.e. the
 * static files answered before the Worker (/_app, web/static, the service worker) and, on the
 * `assets.run_worker_first` page routes of production and staging (web/wrangler.template.jsonc),
 * the prerendered pages the adapter's worker fetches from env.ASSETS behind the canonical-host
 * wrapper (src/worker-entry/canonical-host.ts). HSTS is included unconditionally (browsers ignore
 * it over plain http).
 */
export function renderStaticHeadersFile(): string {
	const headers = securityHeaders({ origin: 'https://static.invalid', isHtml: true });
	const lines = [
		'# Security headers for files served by Workers Static Assets (prerendered pages, /_app).',
		'# Generated from web/src/lib/server/security/headers.ts (renderStaticHeadersFile); keep in sync.',
		'/*'
	];
	for (const [name, value] of Object.entries(headers)) lines.push(`  ${name}: ${value}`);
	lines.push(`  content-security-policy: ${STATIC_DOCUMENT_CSP}`);
	return `${lines.join('\n')}\n`;
}
