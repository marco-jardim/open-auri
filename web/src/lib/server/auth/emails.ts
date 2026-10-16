// Transactional e-mails of the auth flows, sent through the T3.2 EmailProvider under waitUntil
// (never awaited on the response path, so sending time does not reveal whether an account exists).
//
// One message has no T3.2 template: the change-email confirmation that goes to the CURRENT
// address (Better Auth's `sendChangeEmailConfirmation`). Its copy lives here and reuses the T3.2
// layout and escaping. The other messages use the T3.2 templates.
import { AsyncLocalStorage } from 'node:async_hooks';
import {
	accountDeleted,
	buildIdempotencyKey,
	cleanText,
	confirmAccountDeletion,
	confirmNewEmail,
	emailChangeNotice,
	passwordChanged,
	queueEmail,
	resetPassword,
	resolveEmailLocale,
	safeUrl,
	verifyEmail,
	type EmailLocale,
	type EmailProvider,
	type RenderedEmail
} from '../email/index.ts';
import { renderEmail } from '../email/templates/layout.ts';

/** Link lifetimes, seconds (Better Auth options) and minutes (shown in the e-mails). */
export const LINK_TTL_SECONDS = {
	verification: 3600,
	resetPassword: 3600,
	deleteAccount: 3600
} as const;

/** App pages the links point to (T3.6/T3.7 implement them). */
export const AUTH_PAGES = {
	resetPassword: '/redefinir-senha',
	secureAccount: '/esqueci-senha'
} as const;

type AuthEmailId =
	| 'verify-email'
	| 'reset-password'
	| 'confirm-email-change'
	| 'confirm-new-email'
	| 'email-change-notice'
	| 'password-changed'
	| 'confirm-account-deletion'
	| 'account-deleted';

export interface AuthMailerOptions {
	provider: EmailProvider;
	origin: string;
	waitUntil: (promise: Promise<unknown>) => void;
	/**
	 * `requested_at` of the pending e-mail change of `userId` to `newEmail`
	 * (email_change_requests), or null. Keys the final change-email messages (Q3-4).
	 */
	emailChangeRequestedAt?: (userId: string, newEmail: string) => Promise<number | null>;
}

interface Recipient {
	id: string;
	email: string;
	name?: string | null;
	emailVerified?: boolean | null;
}

/** Locale from request headers: the `oa_lang` cookie, then Accept-Language, then pt-BR. */
export function emailLocaleFromHeaders(headers: Headers | undefined | null): EmailLocale {
	if (!headers) return 'pt-BR';
	const cookie = headers.get('cookie') ?? '';
	const match = /(?:^|;\s*)oa_lang=([^;]+)/.exec(cookie);
	if (match?.[1]) {
		let value: string | null = null;
		try {
			value = decodeURIComponent(match[1]);
		} catch {
			// Malformed escape (`oa_lang=%`): ignore the cookie; the mail must still go out.
		}
		if (value !== null) return resolveEmailLocale(value);
	}
	return resolveEmailLocale(headers.get('accept-language'));
}

/**
 * Server-side `auth.api.*` calls (the /conta actions) carry no `Request`, so Better Auth hands the
 * e-mail callbacks `undefined`. The caller states the locale with {@link withEmailLocale} around the
 * call instead; the scope follows every await inside it.
 */
const localeScope = new AsyncLocalStorage<EmailLocale>();

export function withEmailLocale<T>(locale: EmailLocale, run: () => Promise<T>): Promise<T> {
	return localeScope.run(locale, run);
}

/** Locale of the e-mail: the request's headers, else the {@link withEmailLocale} scope, else pt-BR. */
export function emailLocaleFromRequest(request: Request | undefined | null): EmailLocale {
	if (request?.headers) return emailLocaleFromHeaders(request.headers);
	return localeScope.getStore() ?? 'pt-BR';
}

const CONFIRM_CHANGE_COPY: Record<
	EmailLocale,
	{ subject: string; heading: string; intro: string[]; action: string; outro: string[] }
> = {
	'pt-BR': {
		subject: 'Confirme a troca do e-mail da sua conta no open-auri',
		heading: 'Confirme a troca de e-mail',
		intro: [
			'Recebemos um pedido para trocar o e-mail da sua conta no open-auri para outro endereço. Para continuar, confirme pelo link abaixo. Depois disso, enviaremos uma mensagem para o novo endereço, que também precisa ser confirmado.'
		],
		action: 'Confirmar a troca',
		outro: [
			'Se você não pediu a troca, ignore esta mensagem e considere trocar sua senha. O e-mail da conta continua o mesmo.'
		]
	},
	'en-US': {
		subject: 'Confirm the email change for your open-auri account',
		heading: 'Confirm the email change',
		intro: [
			'We received a request to move your open-auri account to a different email address. To continue, confirm with the link below. We will then send a message to the new address, which must be confirmed as well.'
		],
		action: 'Confirm the change',
		outro: [
			'If you did not request this change, ignore this message and consider changing your password. The account email stays the same.'
		]
	}
};

const COMMON: Record<
	EmailLocale,
	{ greeting(name: string | null): string; fallback: string; footer: string; expiry: string }
> = {
	'pt-BR': {
		greeting: (name) => (name ? `Olá, ${name}.` : 'Olá.'),
		fallback: 'Se o link acima não abrir, copie este endereço no navegador:',
		footer: 'Mensagem automática do open-auri sobre uma conta ligada a este endereço.',
		expiry: 'Este link vale por 1 hora.'
	},
	'en-US': {
		greeting: (name) => (name ? `Hi ${name},` : 'Hi,'),
		fallback: 'If the link above does not open, copy this address into your browser:',
		footer: 'Automated message from open-auri about an account linked to this address.',
		expiry: 'This link expires in 1 hour.'
	}
};

/** Confirmation sent to the current address before an e-mail change (no T3.2 template). */
export function confirmEmailChange(
	locale: EmailLocale,
	data: { origin: string; url: string; name?: string | null }
): RenderedEmail {
	const copy = CONFIRM_CHANGE_COPY[locale];
	const common = COMMON[locale];
	return renderEmail({
		locale,
		subject: copy.subject,
		heading: copy.heading,
		greeting: common.greeting(cleanText(data.name)),
		intro: copy.intro,
		action: { label: copy.action, href: safeUrl(data.url, data.origin), fallback: common.fallback },
		outro: [common.expiry, ...copy.outro],
		footer: common.footer,
		homeHref: safeUrl(data.origin, data.origin)
	});
}

/** Decodes the payload of a Better Auth e-mail JWT (our own token; used only to pick a template). */
export function readEmailTokenPayload(token: string): { email?: string; updateTo?: string } {
	const part = token.split('.')[1];
	if (!part) return {};
	try {
		const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
		const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
		const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== 'object' || parsed === null) return {};
		const { email, updateTo } = parsed as Record<string, unknown>;
		return {
			...(typeof email === 'string' ? { email } : {}),
			...(typeof updateTo === 'string' ? { updateTo } : {})
		};
	} catch {
		return {};
	}
}

const minutes = (seconds: number) => Math.round(seconds / 60);

export function createAuthMailer(options: AuthMailerOptions) {
	const { provider, origin } = options;
	const context = { waitUntil: options.waitUntil };
	const page = (path: string) => new URL(path, origin).href;

	/** Schedules one message; resolves once it is queued (delivery continues under waitUntil). */
	async function send(
		templateId: AuthEmailId,
		to: string,
		rendered: RenderedEmail,
		...keyParts: string[]
	): Promise<void> {
		const idempotencyKey = await buildIdempotencyKey(templateId, ...keyParts);
		queueEmail(context, provider, {
			templateId,
			message: {
				to,
				...rendered,
				idempotencyKey,
				tags: [{ name: 'template', value: templateId }]
			}
		});
	}

	/** Greeting name only for verified addresses (T3.2: no free text to unverified inboxes). */
	const nameFor = (user: Recipient) => (user.emailVerified ? (user.name ?? null) : null);

	/**
	 * (user, new address) → id of the change-email confirmation link being opened. Set by the auth
	 * before-hook when it claims that link, read once by the `verification` call Better Auth makes
	 * right after. The instance lives for one request in the app, so this holds one entry at most.
	 */
	const changeLinks = new Map<string, string>();
	const changeLinkKey = (userId: string, newEmail: string) => `${userId}\n${newEmail}`;

	return {
		/** The hook claimed confirmation link `linkId` of `userId` → `newEmail` (see `verification`). */
		noteChangeConfirmation(userId: string, newEmail: string, linkId: string): void {
			changeLinks.set(changeLinkKey(userId, newEmail), linkId);
		},

		async verification(user: Recipient, url: string, token: string, request?: Request) {
			const locale = emailLocaleFromRequest(request);
			const { email: currentEmail, updateTo } = readEmailTokenPayload(token);
			const ttl = minutes(LINK_TTL_SECONDS.verification);
			if (!updateTo) {
				return send(
					'verify-email',
					user.email,
					verifyEmail(locale, { origin, url, expiresInMinutes: ttl }),
					user.id,
					token
				);
			}
			// E-mail change, final step: the new address confirms; the old one is told. Both are keyed
			// on the pending request (user, new address, requested_at), not on this link's token: Better
			// Auth mints a new token on every opening of the first link, so a token key would let one
			// link mail the new address (and the account's own) again and again. With the request key,
			// Resend sends each message once per request (repeats are deduplicated for 24 h). Without a
			// recorded request (a direct API call outside /conta), the key is the ORIGINAL confirmation
			// link the hook just claimed (its stable id, auth/link-uses.ts), so one first link maps to
			// one key on top of its single-use claim; the fresh token is only the last resort.
			const noteKey = changeLinkKey(user.id, updateTo);
			const linkId = changeLinks.get(noteKey);
			changeLinks.delete(noteKey);
			const lookup = options.emailChangeRequestedAt;
			const requestedAt = lookup ? await lookup(user.id, updateTo).catch(() => null) : null;
			const keyParts =
				requestedAt !== null
					? [user.id, updateTo, String(requestedAt)]
					: [user.id, updateTo, linkId ? `link:${linkId}` : token];
			const tasks = [
				send(
					'confirm-new-email',
					updateTo,
					confirmNewEmail(locale, { origin, url, expiresInMinutes: ttl }),
					...keyParts
				)
			];
			if (currentEmail && currentEmail !== updateTo && user.emailVerified) {
				tasks.push(
					send(
						'email-change-notice',
						currentEmail,
						emailChangeNotice(locale, {
							origin,
							url: page(AUTH_PAGES.secureAccount),
							name: user.name ?? null
						}),
						...keyParts
					)
				);
			}
			return Promise.all(tasks).then(() => undefined);
		},

		changeEmailConfirmation(user: Recipient, url: string, token: string, request?: Request) {
			const locale = emailLocaleFromRequest(request);
			return send(
				'confirm-email-change',
				user.email,
				confirmEmailChange(locale, { origin, url, name: nameFor(user) }),
				user.id,
				token
			);
		},

		resetPassword(user: Recipient, token: string, request?: Request) {
			const locale = emailLocaleFromRequest(request);
			const url = `${page(AUTH_PAGES.resetPassword)}?token=${encodeURIComponent(token)}`;
			return send(
				'reset-password',
				user.email,
				resetPassword(locale, {
					origin,
					url,
					name: nameFor(user),
					expiresInMinutes: minutes(LINK_TTL_SECONDS.resetPassword)
				}),
				user.id,
				token
			);
		},

		passwordChanged(user: Recipient, eventId: string, request?: Request) {
			const locale = emailLocaleFromRequest(request);
			return send(
				'password-changed',
				user.email,
				passwordChanged(locale, {
					origin,
					url: page(AUTH_PAGES.secureAccount),
					name: nameFor(user)
				}),
				user.id,
				eventId
			);
		},

		confirmAccountDeletion(user: Recipient, url: string, token: string, request?: Request) {
			const locale = emailLocaleFromRequest(request);
			return send(
				'confirm-account-deletion',
				user.email,
				confirmAccountDeletion(locale, {
					origin,
					url,
					name: nameFor(user),
					expiresInMinutes: minutes(LINK_TTL_SECONDS.deleteAccount)
				}),
				user.id,
				token
			);
		},

		accountDeleted(user: Recipient, request?: Request) {
			const locale = emailLocaleFromRequest(request);
			return send(
				'account-deleted',
				user.email,
				accountDeleted(locale, { origin, name: nameFor(user) }),
				user.id
			);
		}
	};
}

export type AuthMailer = ReturnType<typeof createAuthMailer>;
