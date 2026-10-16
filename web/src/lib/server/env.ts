import { z } from 'zod';
import type { Env } from './types.ts';

/**
 * Validated, typed view of the Worker environment (bindings, vars and secrets) for server code.
 * Raw values never appear in errors: issues carry the variable name and a reason code only.
 */
export interface ServerEnv {
	db: Env['DB'];
	config: Env['CONFIG'];
	media: Env['MEDIA'];
	accessLogQueue: Env['ACCESS_LOG_QUEUE'];
	rateLimit: { auth: Env['RL_AUTH']; api: Env['RL_API']; write: Env['RL_WRITE'] };
	/** Canonical origin, e.g. `https://example.org` (no path, no trailing slash). */
	publicOrigin: string;
	githubUrl: string;
	resendFrom: string;
	/**
	 * How transactional e-mail leaves the Worker: `resend` (default, production) or `capture`
	 * (local e2e only: messages go to the D1 table `dev_mail_outbox`, see email/capture.ts).
	 * `capture` is refused unless PUBLIC_ORIGIN is http(s)://localhost or 127.0.0.1.
	 */
	emailTransport: EmailTransport;
	flags: { accessLogEnabled: boolean; signupEnabled: boolean; admin2faRequired: boolean };
	secrets: {
		betterAuthSecret: string;
		resendApiKey: string;
		turnstileSecret: string;
		iphashPepper: string;
		accessLogKey: string;
		/** Optional until F5 (Resend webhooks). */
		resendWebhookSecret: string | null;
	};
}

export const EMAIL_TRANSPORTS = ['resend', 'capture'] as const;
export type EmailTransport = (typeof EMAIL_TRANSPORTS)[number];

/** True when `origin` is a loopback origin (the only place the capture transport may run). */
export function isLocalOrigin(origin: string): boolean {
	try {
		const { hostname } = new URL(origin);
		return hostname === 'localhost' || hostname === '127.0.0.1';
	} catch {
		return false;
	}
}

export class ServerEnvError extends Error {
	/** `NAME: reason` entries; never values. */
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(`Invalid server environment: ${issues.join('; ')}`);
		this.name = 'ServerEnvError';
		this.issues = issues;
	}
}

function hasMethods(...methods: string[]) {
	return (value: unknown): boolean =>
		typeof value === 'object' &&
		value !== null &&
		methods.every((method) => typeof Reflect.get(value, method) === 'function');
}

function binding<T>(...methods: string[]) {
	return z.custom<T>(hasMethods(...methods), 'binding missing or of the wrong type');
}

const flag = z.enum(['true', 'false'], 'expected "true" or "false"').transform((v) => v === 'true');

function isOrigin(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	const secure = url.protocol === 'https:' || (url.protocol === 'http:' && local);
	return secure && url.origin === value;
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

const secret = (minLength: number) =>
	z.string('expected a string').min(minLength, `shorter than ${minLength} characters`);

const schema = z.object({
	DB: binding<Env['DB']>('prepare', 'batch', 'exec'),
	CONFIG: binding<Env['CONFIG']>('get', 'put', 'delete', 'list'),
	MEDIA: binding<Env['MEDIA']>('get', 'put', 'head', 'delete'),
	ACCESS_LOG_QUEUE: binding<Env['ACCESS_LOG_QUEUE']>('send', 'sendBatch'),
	RL_AUTH: binding<Env['RL_AUTH']>('limit'),
	RL_API: binding<Env['RL_API']>('limit'),
	RL_WRITE: binding<Env['RL_WRITE']>('limit'),
	PUBLIC_ORIGIN: z
		.string('expected a string')
		.refine(isOrigin, 'not a bare https origin (scheme://host[:port])'),
	GITHUB_URL: z.string('expected a string').refine(isHttpsUrl, 'not an https URL'),
	RESEND_FROM: z.string('expected a string').min(3, 'empty'),
	// Missing (configs rendered before the variable existed) means the production transport.
	EMAIL_TRANSPORT: z.enum(EMAIL_TRANSPORTS, 'expected "resend" or "capture"').default('resend'),
	ACCESS_LOG_ENABLED: flag,
	SIGNUP_ENABLED: flag,
	ADMIN_2FA_REQUIRED: flag,
	BETTER_AUTH_SECRET: secret(32),
	RESEND_API_KEY: secret(1),
	TURNSTILE_SECRET: secret(1),
	IPHASH_PEPPER: secret(32),
	ACCESS_LOG_KEY: secret(32),
	RESEND_WEBHOOK_SECRET: secret(1).optional()
});

const cache = new WeakMap<object, ServerEnv>();

/**
 * Validates `platform.env` once per env object (stable for the isolate) and returns the typed
 * view. Throws {@link ServerEnvError} listing offending names and reasons, never values.
 * Accepts `event.platform` (or any `{ env }`); the shape is checked at runtime, not trusted.
 */
export function getServerEnv(platform: { readonly env?: unknown } | undefined): ServerEnv {
	const env: unknown = platform?.env;
	if (typeof env !== 'object' || env === null) {
		throw new ServerEnvError(['platform.env: missing (not running on the Workers runtime)']);
	}
	const cached = cache.get(env);
	if (cached) return cached;

	// reportInput: false keeps raw values out of issues; jitless avoids eval (blocked in workerd).
	const parsed = schema.safeParse(env, { reportInput: false, jitless: true });
	if (!parsed.success) {
		throw new ServerEnvError(
			parsed.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
		);
	}
	const data = parsed.data;
	// Hard guard: the dev mailbox must never run where real people sign up.
	if (data.EMAIL_TRANSPORT === 'capture' && !isLocalOrigin(data.PUBLIC_ORIGIN)) {
		throw new ServerEnvError(['EMAIL_TRANSPORT: capture is only allowed on a localhost origin']);
	}
	const serverEnv: ServerEnv = {
		db: data.DB,
		config: data.CONFIG,
		media: data.MEDIA,
		accessLogQueue: data.ACCESS_LOG_QUEUE,
		rateLimit: { auth: data.RL_AUTH, api: data.RL_API, write: data.RL_WRITE },
		publicOrigin: data.PUBLIC_ORIGIN,
		githubUrl: data.GITHUB_URL,
		resendFrom: data.RESEND_FROM,
		emailTransport: data.EMAIL_TRANSPORT,
		flags: {
			accessLogEnabled: data.ACCESS_LOG_ENABLED,
			signupEnabled: data.SIGNUP_ENABLED,
			admin2faRequired: data.ADMIN_2FA_REQUIRED
		},
		secrets: {
			betterAuthSecret: data.BETTER_AUTH_SECRET,
			resendApiKey: data.RESEND_API_KEY,
			turnstileSecret: data.TURNSTILE_SECRET,
			iphashPepper: data.IPHASH_PEPPER,
			accessLogKey: data.ACCESS_LOG_KEY,
			resendWebhookSecret: data.RESEND_WEBHOOK_SECRET ?? null
		}
	};
	cache.set(env, serverEnv);
	return serverEnv;
}
