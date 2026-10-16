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
// tightens), and (c) the same extra policy in web/_headers for prerendered pages. Non-HTML
// responses get a locked-down `default-src 'none'` policy. Nonce-only CSP is T5.4.

export const HSTS = 'max-age=63072000; includeSubDomains';
export const FRAME_ANCESTORS_POLICY = "frame-ancestors 'none'";
export const NON_HTML_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * `hid=(self)` for the cable (WebHID). Audio previews use Web Audio started by a user gesture, so
 * `autoplay=(self)` keeps same-origin playback working and blocks frames; the clipboard is used by
 * share/export buttons. Every other powerful feature is off, including inside the Turnstile frame.
 */
export const PERMISSIONS_POLICY = [
	'hid=(self)',
	'autoplay=(self)',
	'clipboard-write=(self)',
	'fullscreen=(self)',
	'accelerometer=()',
	'ambient-light-sensor=()',
	'bluetooth=()',
	'browsing-topics=()',
	'camera=()',
	'display-capture=()',
	'encrypted-media=()',
	'geolocation=()',
	'gyroscope=()',
	'magnetometer=()',
	'microphone=()',
	'midi=()',
	'payment=()',
	'screen-wake-lock=()',
	'serial=()',
	'usb=()',
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
 * Content of web/_headers: the same headers for everything Workers Static Assets serves without
 * running the Worker. HSTS is included unconditionally (browsers ignore it over plain http).
 */
export function renderStaticHeadersFile(): string {
	const headers = securityHeaders({ origin: 'https://static.invalid', isHtml: true });
	const lines = [
		'# Security headers for files served by Workers Static Assets (prerendered pages, /_app).',
		'# Generated from web/src/lib/server/security/headers.ts (renderStaticHeadersFile); keep in sync.',
		'/*'
	];
	for (const [name, value] of Object.entries(headers)) lines.push(`  ${name}: ${value}`);
	lines.push(`  content-security-policy: ${FRAME_ANCESTORS_POLICY}`);
	return `${lines.join('\n')}\n`;
}
