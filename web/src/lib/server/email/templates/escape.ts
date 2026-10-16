// Escaping and validation for values interpolated into e-mails. Every dynamic value in a template
// goes through one of these; template copy itself is static.
import { EmailError } from '../provider.ts';

const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
	'`': '&#96;'
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"'`]/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Longest display name shown in an e-mail; longer names are cut with an ellipsis. */
export const MAX_NAME_LENGTH = 64;

/**
 * User-supplied text (display names) for both HTML (after escaping) and plain text: control
 * characters and line breaks removed, whitespace collapsed, length capped. Returns null when
 * nothing printable is left.
 */
export function cleanText(value: string | null | undefined, max = MAX_NAME_LENGTH): string | null {
	if (value === null || value === undefined) return null;
	const flat = value
		.normalize('NFC')
		.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (flat === '') return null;
	const chars = Array.from(flat);
	return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

function isLocalOrigin(url: URL): boolean {
	return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

/**
 * Returns the normalized href when `value` is an https URL, or an http URL on the configured
 * origin (local development only). Anything else (javascript:, data:, credentials in the URL,
 * relative paths, plain http elsewhere) throws `invalid`. The message never includes the URL.
 */
export function safeUrl(value: string, origin: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new EmailError('invalid', 'template link is not an absolute URL');
	}
	if (url.username !== '' || url.password !== '') {
		throw new EmailError('invalid', 'template link must not carry credentials');
	}
	const sameOrigin = url.origin === origin;
	const allowed =
		url.protocol === 'https:' || (url.protocol === 'http:' && sameOrigin && isLocalOrigin(url));
	if (!allowed) throw new EmailError('invalid', 'template link must use https');
	return url.href;
}
