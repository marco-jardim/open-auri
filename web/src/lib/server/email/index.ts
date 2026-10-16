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
import type { EmailProvider } from './provider.ts';
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

/** Resend adapter behind the D1 suppression list, configured from the validated env. */
export function createEmailProvider(
	env: ServerEnv,
	overrides: EmailProviderOverrides = {}
): EmailProvider {
	const resend = new ResendProvider({
		...overrides,
		apiKey: env.secrets.resendApiKey,
		from: env.resendFrom,
		userAgent: EMAIL_USER_AGENT
	});
	return withSuppression(resend, new SuppressionList(env.db, env.secrets.betterAuthSecret));
}
