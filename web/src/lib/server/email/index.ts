// Public entry point of the transactional e-mail module (T3.2).
//
// Typical use in an auth callback (T3.5):
//   const provider = createEmailProvider(getServerEnv(platform));
//   const { subject, html, text } = verifyEmail(locale, { origin, url, expiresInMinutes: 60 });
//   queueEmail(platform.ctx, provider, {
//     templateId: 'verify-email',
//     message: { to, subject, html, text,
//       idempotencyKey: await buildIdempotencyKey('verify-email', userId, tokenId),
//       tags: [{ name: 'template', value: 'verify-email' }] }
//   });
import type { ServerEnv } from '../env.ts';
import { recordEmailFailure, type MetricsDataset } from '../observability/metrics.ts';
import { createCaptureProvider } from './capture.ts';
import { isEmailError, type EmailMessage, type EmailProvider } from './provider.ts';
import { ResendProvider, type ResendProviderOptions } from './resend.ts';
import { SuppressionList, withSuppression } from './suppression.ts';

export * from './provider.ts';
export { queueEmail, type EmailLogger, type QueuedEmail, type WaitUntilContext } from './queue.ts';
export { ResendProvider, RESEND_ENDPOINT, type FetchLike } from './resend.ts';
export { SuppressionList, normalizeAddress, withSuppression } from './suppression.ts';
export * from './templates/index.ts';

/** Sent as `User-Agent` on every Resend request (Resend rejects requests without one). */
export const EMAIL_USER_AGENT = 'open-auri-web/1';

export type EmailProviderOverrides = Pick<
	ResendProviderOptions,
	'fetch' | 'sleep' | 'random' | 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'timeoutMs'
>;

/**
 * Resend adapter behind the D1 suppression list, configured from the validated env. With
 * EMAIL_TRANSPORT=capture (local e2e only; getServerEnv refuses it on a non-local origin) the
 * messages go to the dev mailbox instead (capture.ts), still behind the suppression list.
 */
export function createEmailProvider(
	env: ServerEnv,
	overrides: EmailProviderOverrides = {}
): EmailProvider {
	const suppression = new SuppressionList(env.db, env.secrets.betterAuthSecret);
	if (env.emailTransport === 'capture') {
		const capture = withSuppression(createCaptureProvider(env), suppression);
		return withFailureMetrics(capture, env.metrics);
	}
	const resend = new ResendProvider({
		...overrides,
		apiKey: env.secrets.resendApiKey,
		from: env.resendFrom,
		userAgent: EMAIL_USER_AGENT
	});
	return withFailureMetrics(withSuppression(resend, suppression), env.metrics);
}

/** Template id of a message (its `template` tag), or `unknown`; never another message field. */
function templateOf(message: EmailMessage): string {
	return message.tags?.find((tag) => tag.name === 'template')?.value ?? 'unknown';
}

/**
 * T5.2: every failed send becomes one `email_failed` metric (template tag and error kind only;
 * `unexpected` for non-EmailError failures). The rejection is passed on unchanged. A no-op
 * wrapper when the METRICS binding is absent.
 */
export function withFailureMetrics(
	provider: EmailProvider,
	metrics: MetricsDataset | null | undefined
): EmailProvider {
	if (!metrics) return provider;
	return {
		send: (message) =>
			provider.send(message).catch((error: unknown) => {
				const kind = isEmailError(error) ? error.kind : 'unexpected';
				recordEmailFailure(metrics, templateOf(message), kind);
				throw error;
			})
	};
}
