// Shared layout: one accessible HTML document plus its plain-text twin. No images, no remote
// resources, no tracking pixels, no <style> block (several clients strip it): minimal inline
// styles only, readable without them. Every link shows its full URL as visible text.
import { escapeHtml } from './escape.ts';

export type EmailLocale = 'pt-BR' | 'en-US';

export const EMAIL_LOCALES: readonly EmailLocale[] = ['pt-BR', 'en-US'];

/** Account locale to e-mail locale; anything unknown falls back to pt-BR (base locale). */
export function resolveEmailLocale(value: string | null | undefined): EmailLocale {
	if (value && value.toLowerCase().startsWith('en')) return 'en-US';
	return 'pt-BR';
}

export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

/** Static copy plus already-validated values; the layout escapes everything it interpolates. */
export interface EmailParts {
	locale: EmailLocale;
	subject: string;
	heading: string;
	greeting: string;
	/** Paragraphs before the main link. */
	intro: readonly string[];
	/** Main call to action; `href` must come from safeUrl(). */
	action?: { label: string; href: string; fallback: string };
	/** Paragraphs after the link. */
	outro: readonly string[];
	/** Secondary reference link, rendered as `lead` followed by the visible URL. */
	reference?: { lead: string; href: string };
	footer: string;
	/** Product home, from safeUrl(). */
	homeHref: string;
}

const FONT = "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const BODY_STYLE = `margin:0;padding:24px 16px;background-color:#ffffff;color:#1a1a1a;${FONT};font-size:16px;line-height:1.5`;
const WRAP_STYLE = 'max-width:560px;margin:0 auto';
const H1_STYLE = 'font-size:22px;line-height:1.3;margin:0 0 16px;color:#1a1a1a';
const P_STYLE = 'margin:0 0 16px';
const LINK_STYLE = 'color:#0b57d0;text-decoration:underline';
const ACTION_STYLE = `${LINK_STYLE};font-weight:600;font-size:18px`;
const URL_STYLE = 'margin:0 0 16px;font-size:14px;word-break:break-all';
const FOOTER_STYLE =
	'margin:24px 0 0;padding-top:16px;border-top:1px solid #d0d0d0;font-size:14px;color:#4a4a4a';

function paragraph(text: string): string {
	return `<p style="${P_STYLE}">${escapeHtml(text)}</p>`;
}

function link(href: string, label: string, style = LINK_STYLE): string {
	return `<a href="${escapeHtml(href)}" style="${style}">${escapeHtml(label)}</a>`;
}

export function renderEmail(parts: EmailParts): RenderedEmail {
	const html: string[] = [
		'<!DOCTYPE html>',
		`<html lang="${parts.locale}" dir="ltr">`,
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="color-scheme" content="light">',
		`<title>${escapeHtml(parts.subject)}</title>`,
		'</head>',
		`<body style="${BODY_STYLE}">`,
		`<div role="article" aria-label="${escapeHtml(parts.subject)}" lang="${parts.locale}" style="${WRAP_STYLE}">`,
		`<h1 style="${H1_STYLE}">${escapeHtml(parts.heading)}</h1>`,
		paragraph(parts.greeting),
		...parts.intro.map(paragraph)
	];
	const text: string[] = [parts.heading, '', parts.greeting, ''];
	for (const line of parts.intro) text.push(line, '');

	if (parts.action) {
		const { label, href, fallback } = parts.action;
		html.push(
			`<p style="${P_STYLE}">${link(href, label, ACTION_STYLE)}</p>`,
			paragraph(fallback),
			`<p style="${URL_STYLE}">${link(href, href)}</p>`
		);
		text.push(`${label}:`, href, '');
	}

	html.push(...parts.outro.map(paragraph));
	for (const line of parts.outro) text.push(line, '');

	if (parts.reference) {
		const { lead, href } = parts.reference;
		html.push(`<p style="${P_STYLE}">${escapeHtml(lead)} ${link(href, href)}</p>`);
		text.push(`${lead} ${href}`, '');
	}

	html.push(
		`<p style="${FOOTER_STYLE}">${escapeHtml(parts.footer)}<br>${link(parts.homeHref, 'open-auri')}</p>`,
		'</div>',
		'</body>',
		'</html>'
	);
	text.push('--', parts.footer, parts.homeHref, '');

	return { subject: parts.subject, html: html.join('\n'), text: text.join('\n') };
}
