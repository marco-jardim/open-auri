// Better Auth logger without personal data (plan §3.9, F3 brief: logs never carry e-mail, IP,
// token or user agent). Better Auth interpolates e-mails and origins into some messages (e.g.
// "Sign-up attempt for existing email: <address>") and passes error objects or request details as
// extra arguments. Here the message is redacted and extra arguments are reduced to error names.

export type AuthLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AuthLogEntry {
	event: 'better_auth.log';
	level: AuthLogLevel;
	message: string;
	errors?: string[];
}

const EMAIL = /[^\s@<>"'`,;:()[\]]+@[^\s@<>"'`,;:()[\]]+/g;
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Also matches compressed forms (`2001:db8::1`); may over-redact clock times, which is fine. */
const IPV6 = /\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi;
/** Long opaque strings: tokens, ids, hashes, JWT segments. */
const TOKEN = /\b[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*\b/g;
const MAX_MESSAGE = 200;

export function redactLogMessage(message: string): string {
	return String(message)
		.replace(URL_LIKE, '[url]')
		.replace(EMAIL, '[email]')
		.replace(IPV6, '[ip]')
		.replace(IPV4, '[ip]')
		.replace(TOKEN, '[redacted]')
		.slice(0, MAX_MESSAGE);
}

function errorName(value: unknown): string | null {
	if (value instanceof Error) return value.name || 'Error';
	return null;
}

export function createAuthLogger(
	sink: (entry: AuthLogEntry) => void = (entry) => {
		const line = JSON.stringify(entry);
		if (entry.level === 'error') console.error(line);
		else console.warn(line);
	}
) {
	return {
		level: 'warn' as const,
		log(level: AuthLogLevel, message: string, ...args: unknown[]): void {
			const errors = args.map(errorName).filter((name): name is string => name !== null);
			sink({
				event: 'better_auth.log',
				level,
				message: redactLogMessage(message),
				...(errors.length > 0 ? { errors } : {})
			});
		}
	};
}
