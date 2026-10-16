// Non-blocking send: the response goes out while the e-mail is delivered under waitUntil.
// Failures are logged with the template id and the error kind only (no address, subject, body,
// idempotency key or vendor message).
import {
	isEmailError,
	type EmailErrorKind,
	type EmailMessage,
	type EmailProvider
} from './provider.ts';

/** `ExecutionContext` (platform.ctx) or anything with the same `waitUntil`. */
export interface WaitUntilContext {
	waitUntil(promise: Promise<unknown>): void;
}

export interface QueuedEmail {
	/** Template id (or another fixed label); the only message detail that reaches the logs. */
	templateId: string;
	message: EmailMessage;
}

export interface EmailLogger {
	warn(message: string, details: Record<string, string | number>): void;
}

/** Error kind for logs: EmailError kinds, plus `unexpected` for anything else. */
export type LoggedKind = EmailErrorKind | 'unexpected';

/** Short fixed label kept as is; anything else is replaced so a caller cannot log PII by mistake. */
function safeLabel(templateId: string): string {
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(templateId) ? templateId : 'custom';
}

/**
 * Sends `email.message` in the background. Never throws and never rejects the promise handed to
 * waitUntil (a rejection there would only add noise to the runtime logs). Returns that promise
 * so tests and callers that want to await delivery can.
 */
export function queueEmail(
	ctx: WaitUntilContext,
	provider: EmailProvider,
	email: QueuedEmail,
	logger: EmailLogger = console
): Promise<void> {
	const template = safeLabel(email.templateId);
	const task = provider.send(email.message).then(
		() => undefined,
		(error: unknown) => {
			const kind: LoggedKind = isEmailError(error) ? error.kind : 'unexpected';
			const details: Record<string, string | number> = { template, kind };
			if (isEmailError(error) && error.status !== null) details['status'] = error.status;
			logger.warn('email.send failed', details);
		}
	);
	ctx.waitUntil(task);
	return task;
}
