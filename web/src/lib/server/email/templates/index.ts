// Transactional e-mail templates, pt-BR and en-US. Signature: (locale, data) => { subject, html,
// text }. Copy is static; the only dynamic values are the display name (cleaned and escaped),
// the links (https or the configured origin, escaped) and the link lifetime (validated number).
// pt-BR copy never uses the em dash. Product name: "open-auri".
import { EmailError } from '../provider.ts';
import { cleanText, safeUrl } from './escape.ts';
import { renderEmail, type EmailLocale, type RenderedEmail } from './layout.ts';

export { EMAIL_LOCALES, resolveEmailLocale } from './layout.ts';
export type { EmailLocale, RenderedEmail } from './layout.ts';
export { cleanText, escapeHtml, safeUrl } from './escape.ts';

export interface TemplateBase {
	/** PUBLIC_ORIGIN, e.g. `https://example.org`. */
	origin: string;
	/**
	 * Display name for the greeting. Optional: omit it for messages to addresses not yet
	 * verified, so the name field cannot carry spam to arbitrary inboxes.
	 */
	name?: string | null;
}

/** Messages whose link performs the action (verify, reset, confirm). */
export interface ActionLinkData extends TemplateBase {
	url: string;
	/** Link lifetime shown to the reader; whole minutes, 1 to 43200 (30 days). */
	expiresInMinutes: number;
}

/** Security notices whose link lets the owner secure the account (e.g. reset password). */
export interface SecurityNoticeData extends TemplateBase {
	url: string;
}

export interface TemplateDataMap {
	'verify-email': ActionLinkData;
	'reset-password': ActionLinkData;
	'confirm-new-email': ActionLinkData;
	'email-change-notice': SecurityNoticeData;
	'password-changed': SecurityNoticeData;
	'confirm-account-deletion': ActionLinkData;
	'account-deleted': TemplateBase;
}

export type TemplateId = keyof TemplateDataMap;

export const TEMPLATE_IDS: readonly TemplateId[] = [
	'verify-email',
	'reset-password',
	'confirm-new-email',
	'email-change-notice',
	'password-changed',
	'confirm-account-deletion',
	'account-deleted'
];

interface LocaleCopy {
	subject: string;
	heading: string;
	intro: readonly string[];
	action?: string;
	outro: readonly string[];
	privacyReference?: boolean;
}

interface CommonCopy {
	greeting(name: string | null): string;
	fallback: string;
	footer: string;
	privacyLead: string;
	expiry(duration: string): string;
	duration(value: number, unit: 'minute' | 'hour' | 'day'): string;
}

const PT_UNITS: Record<'minute' | 'hour' | 'day', readonly [string, string]> = {
	minute: ['minuto', 'minutos'],
	hour: ['hora', 'horas'],
	day: ['dia', 'dias']
};

const COMMON: Record<EmailLocale, CommonCopy> = {
	'pt-BR': {
		greeting: (name) => (name ? `Olá, ${name}.` : 'Olá.'),
		fallback: 'Se o link acima não abrir, copie este endereço no navegador:',
		footer: 'Mensagem automática do open-auri sobre uma conta ligada a este endereço.',
		privacyLead: 'Detalhes na política de privacidade:',
		expiry: (duration) => `Este link vale por ${duration}.`,
		duration: (value, unit) => `${value} ${PT_UNITS[unit][value === 1 ? 0 : 1]}`
	},
	'en-US': {
		greeting: (name) => (name ? `Hi ${name},` : 'Hi,'),
		fallback: 'If the link above does not open, copy this address into your browser:',
		footer: 'Automated message from open-auri about an account linked to this address.',
		privacyLead: 'Details in the privacy policy:',
		expiry: (duration) => `This link expires in ${duration}.`,
		duration: (value, unit) => `${value} ${unit}${value === 1 ? '' : 's'}`
	}
};

const COPY: Record<TemplateId, Record<EmailLocale, LocaleCopy>> = {
	'verify-email': {
		'pt-BR': {
			subject: 'Confirme seu e-mail no open-auri',
			heading: 'Confirme seu e-mail',
			intro: [
				'Recebemos um pedido para criar uma conta no open-auri com este endereço. Para ativar a conta, confirme o e-mail pelo link abaixo.'
			],
			action: 'Confirmar e-mail',
			outro: ['Se você não pediu isso, ignore esta mensagem. Nenhuma conta será ativada.']
		},
		'en-US': {
			subject: 'Confirm your email for open-auri',
			heading: 'Confirm your email',
			intro: [
				'We received a request to create an open-auri account with this address. To activate the account, confirm your email with the link below.'
			],
			action: 'Confirm email',
			outro: ['If you did not request this, ignore this message. No account will be activated.']
		}
	},
	'reset-password': {
		'pt-BR': {
			subject: 'Redefinição de senha do open-auri',
			heading: 'Redefina sua senha',
			intro: [
				'Recebemos um pedido para redefinir a senha da sua conta no open-auri. Para escolher uma nova senha, use o link abaixo.'
			],
			action: 'Redefinir senha',
			outro: ['Se você não pediu a redefinição, ignore esta mensagem. Sua senha continua a mesma.']
		},
		'en-US': {
			subject: 'Reset your open-auri password',
			heading: 'Reset your password',
			intro: [
				'We received a request to reset the password of your open-auri account. Use the link below to choose a new password.'
			],
			action: 'Reset password',
			outro: ['If you did not ask for a reset, ignore this message. Your password stays the same.']
		}
	},
	'confirm-new-email': {
		'pt-BR': {
			subject: 'Confirme seu novo e-mail no open-auri',
			heading: 'Confirme seu novo e-mail',
			intro: [
				'Recebemos um pedido para trocar o e-mail da sua conta no open-auri para este endereço. Para concluir a troca, confirme pelo link abaixo.'
			],
			action: 'Confirmar novo e-mail',
			outro: [
				'Se você não pediu a troca, ignore esta mensagem. O e-mail da conta não será alterado.'
			]
		},
		'en-US': {
			subject: 'Confirm your new email for open-auri',
			heading: 'Confirm your new email',
			intro: [
				'We received a request to change the email of your open-auri account to this address. To complete the change, confirm with the link below.'
			],
			action: 'Confirm new email',
			outro: [
				'If you did not request this change, ignore this message. The account email will not change.'
			]
		}
	},
	'email-change-notice': {
		'pt-BR': {
			subject: 'Pedido de troca do e-mail da sua conta no open-auri',
			heading: 'Troca de e-mail solicitada',
			intro: [
				'Recebemos um pedido para trocar o e-mail da sua conta no open-auri para outro endereço. Depois que o novo endereço for confirmado, as mensagens da conta deixam de chegar aqui.',
				'Se foi você, não precisa fazer nada. Se não foi você, proteja a conta pelo link abaixo.'
			],
			action: 'Proteger minha conta',
			outro: []
		},
		'en-US': {
			subject: 'Email change requested for your open-auri account',
			heading: 'Email change requested',
			intro: [
				'We received a request to move your open-auri account to a different email address. Once the new address is confirmed, account messages will no longer come here.',
				'If it was you, there is nothing else to do. If it was not you, secure your account with the link below.'
			],
			action: 'Secure my account',
			outro: []
		}
	},
	'password-changed': {
		'pt-BR': {
			subject: 'Sua senha do open-auri foi alterada',
			heading: 'Senha alterada',
			intro: [
				'A senha da sua conta no open-auri acabou de ser alterada.',
				'Se foi você, não precisa fazer nada. Se não foi você, proteja a conta pelo link abaixo.'
			],
			action: 'Proteger minha conta',
			outro: []
		},
		'en-US': {
			subject: 'Your open-auri password was changed',
			heading: 'Password changed',
			intro: [
				'The password of your open-auri account was just changed.',
				'If it was you, there is nothing else to do. If it was not you, secure your account with the link below.'
			],
			action: 'Secure my account',
			outro: []
		}
	},
	'confirm-account-deletion': {
		'pt-BR': {
			subject: 'Confirme o encerramento da sua conta no open-auri',
			heading: 'Confirme o encerramento da conta',
			intro: [
				'Recebemos um pedido para encerrar sua conta no open-auri. Ao confirmar, a conta é encerrada e os dados pessoais ligados a ela são apagados conforme a política de privacidade. Isso não pode ser desfeito.'
			],
			action: 'Encerrar minha conta',
			outro: [
				'Se você não pediu isso, ignore esta mensagem e considere trocar sua senha. A conta continua ativa.'
			],
			privacyReference: true
		},
		'en-US': {
			subject: 'Confirm closing your open-auri account',
			heading: 'Confirm account closure',
			intro: [
				'We received a request to close your open-auri account. Once you confirm, the account is closed and the personal data linked to it is deleted as described in the privacy policy. This cannot be undone.'
			],
			action: 'Close my account',
			outro: [
				'If you did not request this, ignore this message and consider changing your password. Your account stays active.'
			],
			privacyReference: true
		}
	},
	'account-deleted': {
		'pt-BR': {
			subject: 'Sua conta no open-auri foi encerrada',
			heading: 'Conta encerrada',
			intro: [
				'Sua conta no open-auri foi encerrada, como você pediu. Os dados pessoais ligados a ela são apagados conforme a política de privacidade.',
				'Obrigado por ter usado o open-auri. Esta é a última mensagem que você recebe sobre esta conta.'
			],
			outro: [],
			privacyReference: true
		},
		'en-US': {
			subject: 'Your open-auri account was closed',
			heading: 'Account closed',
			intro: [
				'Your open-auri account was closed, as you requested. Personal data linked to it is deleted as described in the privacy policy.',
				'Thank you for using open-auri. This is the last message you will receive about this account.'
			],
			outro: [],
			privacyReference: true
		}
	}
};

const MAX_EXPIRY_MINUTES = 30 * 24 * 60;

function formatDuration(common: CommonCopy, minutes: number): string {
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EXPIRY_MINUTES) {
		throw new EmailError('invalid', 'link lifetime must be 1 to 43200 whole minutes');
	}
	if (minutes % (24 * 60) === 0) return common.duration(minutes / (24 * 60), 'day');
	if (minutes % 60 === 0) return common.duration(minutes / 60, 'hour');
	return common.duration(minutes, 'minute');
}

interface RenderInput extends TemplateBase {
	url?: string;
	expiresInMinutes?: number;
}

function render(id: TemplateId, locale: EmailLocale, data: RenderInput): RenderedEmail {
	const copy = COPY[id][locale];
	const common = COMMON[locale];
	const homeHref = safeUrl(data.origin, data.origin);
	const outro =
		data.expiresInMinutes === undefined
			? copy.outro
			: [common.expiry(formatDuration(common, data.expiresInMinutes)), ...copy.outro];

	let action: { label: string; href: string; fallback: string } | undefined;
	if (copy.action !== undefined) {
		if (data.url === undefined) throw new EmailError('invalid', 'template link is missing');
		action = {
			label: copy.action,
			href: safeUrl(data.url, data.origin),
			fallback: common.fallback
		};
	}

	return renderEmail({
		locale,
		subject: copy.subject,
		heading: copy.heading,
		greeting: common.greeting(cleanText(data.name)),
		intro: copy.intro,
		...(action ? { action } : {}),
		outro,
		...(copy.privacyReference
			? {
					reference: {
						lead: common.privacyLead,
						href: safeUrl(new URL('/privacidade', homeHref).href, data.origin)
					}
				}
			: {}),
		footer: common.footer,
		homeHref
	});
}

export function verifyEmail(locale: EmailLocale, data: ActionLinkData): RenderedEmail {
	return render('verify-email', locale, data);
}

export function resetPassword(locale: EmailLocale, data: ActionLinkData): RenderedEmail {
	return render('reset-password', locale, data);
}

export function confirmNewEmail(locale: EmailLocale, data: ActionLinkData): RenderedEmail {
	return render('confirm-new-email', locale, data);
}

export function emailChangeNotice(locale: EmailLocale, data: SecurityNoticeData): RenderedEmail {
	return render('email-change-notice', locale, data);
}

export function passwordChanged(locale: EmailLocale, data: SecurityNoticeData): RenderedEmail {
	return render('password-changed', locale, data);
}

export function confirmAccountDeletion(locale: EmailLocale, data: ActionLinkData): RenderedEmail {
	return render('confirm-account-deletion', locale, data);
}

export function accountDeleted(locale: EmailLocale, data: TemplateBase): RenderedEmail {
	return render('account-deleted', locale, data);
}

export const templates: {
	[K in TemplateId]: (locale: EmailLocale, data: TemplateDataMap[K]) => RenderedEmail;
} = {
	'verify-email': verifyEmail,
	'reset-password': resetPassword,
	'confirm-new-email': confirmNewEmail,
	'email-change-notice': emailChangeNotice,
	'password-changed': passwordChanged,
	'confirm-account-deletion': confirmAccountDeletion,
	'account-deleted': accountDeleted
};

export function renderTemplate<K extends TemplateId>(
	id: K,
	locale: EmailLocale,
	data: TemplateDataMap[K]
): RenderedEmail {
	const template: (locale: EmailLocale, data: TemplateDataMap[K]) => RenderedEmail = templates[id];
	return template(locale, data);
}
