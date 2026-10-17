// FX3.3: fixes of the Q3 round-2 security review, through the real Better Auth handler.
//   M1 single-use claim on the JWT's signed part; strict compact tokens; mail key without a row;
//   M2 no off-site redirect from any callback field (`/.//host`, `/\host`, `//host`, ...);
//   m1 GET /verify-email throttled per IP (fail closed);
//   m2 read-only: no session refresh write, no prune on reading the pending e-mail change;
//   nit sign-in by e-mail and by nickname share one per-account budget.
import { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isCompactJws, linkUseId } from '#lib/server/auth/link-uses.ts';
import { MAX_NEXT_LENGTH } from '#lib/components/auth/next.ts';
import {
	INVALID_CALLBACK_URL,
	isSafeCallbackURL,
	MAX_CALLBACK_URL_LENGTH
} from '#lib/server/auth/hooks.ts';
import { buildIdempotencyKey, RESEND_ENDPOINT } from '#lib/server/email/index.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { createAuthGuard } from '#lib/server/security/auth-guard.ts';
import {
	Client,
	createVerifiedUser,
	errorCode,
	Harness,
	linkOf,
	mockNetwork,
	outbox,
	signedIn,
	uniqueEmail,
	uniqueUsername
} from './harness.ts';

const network = setupNetwork();

vi.setConfig({ testTimeout: 60_000 });

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});

/** Resend idempotency keys seen. */
const keys: { template: string; to: string; key: string }[] = [];

function harness(...args: ConstructorParameters<typeof Harness>): Harness {
	network.resetHandlers();
	mockNetwork(network);
	network.use(
		http.post(RESEND_ENDPOINT, async ({ request }) => {
			const body = (await request.json()) as {
				to: string[];
				subject: string;
				text: string;
				html: string;
				tags?: { name: string; value: string }[];
			};
			const template = body.tags?.find((tag) => tag.name === 'template')?.value ?? '';
			const to = body.to[0] ?? '';
			keys.push({ template, to, key: request.headers.get('idempotency-key') ?? '' });
			outbox.push({ to, subject: body.subject, text: body.text, html: body.html, template });
			return HttpResponse.json({ id: `email_${outbox.length}` });
		})
	);
	return new Harness(...args);
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const USED = '/conta?email=alterado&error=LINK_ALREADY_USED';

/**
 * The same HS256 token with a different last character: a 32-byte signature takes 43 base64url
 * characters, whose last 2 bits are unused, so the decoded signature is unchanged.
 */
function flipUnusedBits(token: string): string {
	const signature = token.slice(token.lastIndexOf('.') + 1);
	expect(signature).toHaveLength(43);
	const index = B64URL.indexOf(token.slice(-1));
	return `${token.slice(0, -1)}${B64URL[index ^ 1] ?? ''}`;
}

/** The verify-email link `link` with another token text (percent-encoded as given). */
function withToken(link: URL, encodedToken: string, callbackURL?: string | null): URL {
	const callback = callbackURL === undefined ? link.searchParams.get('callbackURL') : callbackURL;
	const tail = callback ? `&callbackURL=${encodeURIComponent(callback)}` : '';
	return new URL(`${link.origin}${link.pathname}?token=${encodedToken}${tail}`);
}

/** No Location, or one that stays on `origin` with a path not starting with `//`. */
function expectNotOffsite(response: Response, origin: string): void {
	const location = response.headers.get('location');
	if (location === null) return;
	expect(location.startsWith('//')).toBe(false);
	expect(location).not.toContain('\\');
	const target = new URL(location, origin);
	expect(target.origin).toBe(origin);
	expect(target.pathname.startsWith('//')).toBe(false);
}

async function emailVerified(email: string): Promise<number | undefined> {
	const row = await env.DB.prepare('SELECT "emailVerified" AS v FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ v: number }>();
	return row?.v;
}

/** Starts a change-email by direct POST (no /conta row) and returns the first link. */
async function directChange(h: Harness, prefix: string) {
	const email = uniqueEmail(prefix);
	const id = await createVerifiedUser(h, email);
	const client = await signedIn(h, email);
	const target = uniqueEmail(`${prefix}-to`);
	const callbackURL = '/conta?email=alterado';
	expect((await client.post('/change-email', { newEmail: target, callbackURL })).status).toBe(200);
	await h.flush();
	const link = linkOf(h.mail(email, 'confirm-email-change'));
	const token = link.searchParams.get('token') ?? '';
	return { email, id, target, link, token, callbackURL };
}

describe('M1: one claim per token, whatever its spelling', () => {
	it('link ids ignore the signature spelling; only strict compact JWS pass', async () => {
		const signed = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImFAeC5leGFtcGxlIn0';
		const token = `${signed}.${'A'.repeat(43)}`;
		expect(isCompactJws(token)).toBe(true);
		expect(await linkUseId(flipUnusedBits(token))).toBe(await linkUseId(token));
		const bad = [`${token} `, `${token}\n`, `${token}\t`, `${token}=`, ` ${token}`, 'a.b'];
		for (const value of bad) expect(isCompactJws(value), JSON.stringify(value)).toBe(false);
		await expect(linkUseId(`${token} `)).rejects.toThrow();
	});

	it('variants of a used link never act again and the new address gets one mail (no /conta row)', async () => {
		const h = harness();
		const { email, id, target, link, token } = await directChange(h, 'r2-variant');

		const opened = await h.client().get(link);
		expect(opened.status).toBe(302);
		expect(opened.headers.get('location') ?? '').not.toContain('error=');
		await h.flush();
		expect(h.mails(target, 'confirm-new-email')).toHaveLength(1);

		const encoded = encodeURIComponent(token);
		for (const suffix of ['%20', '%0A', '%09', '%0A%20', '%0D%0A', '%0C']) {
			const response = await h.client().get(withToken(link, `${encoded}${suffix}`));
			expect(response.status, suffix).toBe(302);
			expect(response.headers.get('location'), suffix).toBe(
				'/conta?email=alterado&error=INVALID_TOKEN'
			);
		}
		// Same signed part, different signature text: the claim still knows it.
		const flippedLink = withToken(link, encodeURIComponent(flipUnusedBits(token)));
		const flipped = await h.client().get(flippedLink);
		expect(flipped.status).toBe(302);
		expect(flipped.headers.get('location')).toBe(USED);
		const again = await h.client().get(link);
		expect(again.headers.get('location')).toBe(USED);

		await h.flush();
		expect(h.mails(target, 'confirm-new-email')).toHaveLength(1);
		expect(h.mails(email, 'email-change-notice')).toHaveLength(1);
		// Keyed on the claimed confirmation link, not on the token minted for the new address.
		const expected = await buildIdempotencyKey(
			'confirm-new-email',
			id,
			target,
			`link:${await linkUseId(token)}`
		);
		expect(keys.filter((entry) => entry.to === target).map((entry) => entry.key)).toEqual([
			expected
		]);
	});

	it('a trailing-bit variant opened first spends the original link', async () => {
		const h = harness();
		const { target, link, token } = await directChange(h, 'r2-flip-first');
		const flippedLink = withToken(link, encodeURIComponent(flipUnusedBits(token)));
		const flipped = await h.client().get(flippedLink);
		expect(flipped.status).toBe(302);
		expect(flipped.headers.get('location') ?? '').not.toContain('error=');
		const original = await h.client().get(link);
		expect(original.headers.get('location')).toBe(USED);
		await h.flush();
		expect(h.mails(target, 'confirm-new-email')).toHaveLength(1);
	});

	it('a malformed token is refused before Better Auth: nothing is verified', async () => {
		const h = harness();
		const email = uniqueEmail('r2-malformed');
		expect((await h.client().signUp(email)).status).toBe(200);
		await h.flush();
		const link = linkOf(h.mail(email, 'verify-email'));
		const token = link.searchParams.get('token') ?? '';
		const refused = await h.client().get(withToken(link, `${encodeURIComponent(token)}%20`));
		const location = refused.headers.get('location');
		if (location === null) {
			expect(refused.status).toBe(401);
			expect(await errorCode(refused)).toBe('INVALID_TOKEN');
		} else {
			expect(location).toMatch(/[?&]error=INVALID_TOKEN/);
			expectNotOffsite(refused, h.origin);
		}
		expect(await emailVerified(email)).toBe(0);
		expect((await h.client().get(link)).status).toBeLessThan(400);
		expect(await emailVerified(email)).toBe(1);
	});
});

describe('M2: callback URLs never leave the site', () => {
	const EVIL = [
		'/.//evil.example',
		'/./%2F/evil.example',
		'/\\evil.example',
		'https://evil.example',
		'//evil.example',
		'/%2F%2Fevil.example',
		'/%2e%2e//evil.example',
		'/../evil.example',
		' /x',
		'javascript:alert(1)'
	];

	it('isSafeCallbackURL accepts the app callbacks only', () => {
		const origin = getServerEnv({ env }).publicOrigin;
		for (const good of [
			'/',
			'/conta?email=alterado',
			'/conta/encerrada',
			'/verificar-email?verificado=1&next=%2Fconta',
			`${origin}/conta`,
			origin
		]) {
			expect(isSafeCallbackURL(good, origin), good).toBe(true);
		}
		for (const bad of [...EVIL, `${origin}.evil.example/`, `${origin}//evil.example`]) {
			expect(isSafeCallbackURL(bad, origin), bad).toBe(false);
		}
	});

	// Q3 round 3, m-c (#22): the callback ends up in mailed links, so it is bounded like `?next=`.
	it('isSafeCallbackURL refuses values longer than MAX_CALLBACK_URL_LENGTH', () => {
		const origin = getServerEnv({ env }).publicOrigin;
		expect(MAX_CALLBACK_URL_LENGTH).toBe(MAX_NEXT_LENGTH);
		const relative = `/${'a'.repeat(MAX_CALLBACK_URL_LENGTH - 1)}`;
		expect(relative).toHaveLength(MAX_CALLBACK_URL_LENGTH);
		expect(isSafeCallbackURL(relative, origin)).toBe(true);
		expect(isSafeCallbackURL(`${relative}a`, origin)).toBe(false);
		const prefix = `${origin}/`;
		const absolute = `${prefix}${'a'.repeat(MAX_CALLBACK_URL_LENGTH - prefix.length)}`;
		expect(absolute).toHaveLength(MAX_CALLBACK_URL_LENGTH);
		expect(isSafeCallbackURL(absolute, origin)).toBe(true);
		expect(isSafeCallbackURL(`${absolute}a`, origin)).toBe(false);
	});

	it('a callback over the length limit is refused before Better Auth runs', async () => {
		const h = harness();
		const callbackURL = `/${'a'.repeat(MAX_CALLBACK_URL_LENGTH)}`;
		const response = await h
			.client()
			.post('/send-verification-email', { email: uniqueEmail('r2-long'), callbackURL });
		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe(INVALID_CALLBACK_URL);
	});

	it('garbage, unknown and used tokens with an evil callback never redirect off-site', async () => {
		const h = harness();
		const { link, token } = await directChange(h, 'r2-redirect');
		expect((await h.client().get(link)).status).toBe(302); // spends the link
		const encoded = encodeURIComponent(token);
		for (const value of ['garbage', 'a.b.c', encoded, `${encoded}%20`]) {
			for (const callback of EVIL) {
				const response = await h.client().get(withToken(link, value, callback));
				expectNotOffsite(response, h.origin);
				expect(response.status, `${value} ${callback}`).toBeGreaterThanOrEqual(400);
			}
		}
		// Better Auth's own check accepts this one; the hook refuses it.
		const dot = await h.client().get(withToken(link, 'garbage', '/.//evil.example'));
		expect(dot.status).toBe(403);
		expect(await errorCode(dot)).toBe(INVALID_CALLBACK_URL);
	});

	// `/.//host` passes Better Auth's own check, so only the hook can refuse it (403, its code).
	it('every endpoint taking a redirect field refuses an evil one', async () => {
		const h = harness();
		const email = uniqueEmail('r2-fields');
		await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		const newEmail = uniqueEmail('r2-fields-to');
		const cases: [string, Record<string, unknown>][] = [
			['/change-email', { newEmail, callbackURL: '/.//evil.example' }],
			['/delete-user', { password: 'whatever whatever', callbackURL: '/.//evil.example' }],
			['/send-verification-email', { email, callbackURL: '/.//evil.example' }],
			['/request-password-reset', { email, redirectTo: '/.//evil.example' }],
			['/sign-in/email', { email, password: 'x', callbackURL: '/.//evil.example' }],
			[
				'/sign-up/email',
				{
					name: 'X',
					email: uniqueEmail('r2-fields-up'),
					password: 'long enough password',
					callbackURL: '/.//evil.example'
				}
			],
			['/sign-in/email', { email, password: 'x', errorCallbackURL: '/.//evil.example' }],
			['/sign-in/email', { email, password: 'x', newUserCallbackURL: '/.//evil.example' }]
		];
		for (const [path, body] of cases) {
			const response = await client.post(path, body);
			expect(response.status, path).toBe(403);
			expect(await errorCode(response), path).toBe(INVALID_CALLBACK_URL);
		}
		const evil = encodeURIComponent('/.//evil.example');
		const callback = await client.get(`/delete-user/callback?token=x&callbackURL=${evil}`);
		expectNotOffsite(callback, h.origin);
		expect(callback.status).toBe(403);
		await h.flush();
		expect(h.mails(email, 'confirm-account-deletion')).toHaveLength(0);
	});
});

describe('m1: GET /verify-email is throttled per IP', () => {
	it('30 per 10 min per client over HTTP, then 429', async () => {
		const h = harness();
		const client = h.client();
		const statuses: number[] = [];
		for (let index = 0; index < 31; index += 1) {
			statuses.push((await client.get('/verify-email?token=garbage')).status);
		}
		expect(statuses.slice(0, 20).every((status) => status !== 429)).toBe(true);
		expect(statuses.at(-1)).toBe(429);
		// Another client is not affected.
		expect((await h.client().get('/verify-email?token=garbage')).status).not.toBe(429);
	});

	it('the D1 rule alone: 30 pass, the 31st is limited; failures are closed', async () => {
		const serverEnv = getServerEnv({ env });
		const guard = createAuthGuard({
			env: serverEnv,
			rateLimit: async () => ({ ok: true }),
			log: () => undefined
		});
		const ip = `198.19.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
		const outcomes: boolean[] = [];
		for (let index = 0; index < 31; index += 1) {
			outcomes.push((await guard({ path: '/verify-email', ip })).ok);
		}
		expect(outcomes.slice(0, 30).every(Boolean)).toBe(true);
		expect(outcomes[30]).toBe(false);

		const broken = createAuthGuard({
			env: serverEnv,
			rateLimit: async () => ({ ok: true }),
			windowLimit: async () => ({ ok: false, reason: 'unavailable' }),
			log: () => undefined
		});
		expect(await broken({ path: '/verify-email', ip })).toMatchObject({
			ok: false,
			status: 503,
			code: 'RATE_LIMIT_UNAVAILABLE'
		});
	});
});

describe('m2: read-only mode and session refresh', () => {
	it('an instance built with readOnly does not refresh the session row', async () => {
		const h = harness();
		const email = uniqueEmail('r2-refresh');
		const id = await createVerifiedUser(h, email);
		const client = await signedIn(h, email);
		// Two days into a 7-day session: past Better Auth's 1-day updateAge.
		const old = new Date(Date.now() + 5 * 86_400_000).toISOString();
		await env.DB.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "userId" = ?')
			.bind(old, id)
			.run();
		const expiresAt = async () =>
			(
				await env.DB.prepare('SELECT "expiresAt" AS e FROM "session" WHERE "userId" = ?')
					.bind(id)
					.first<{ e: string }>()
			)?.e;

		const readOnly = new Client(harness({}, { readOnly: true }));
		for (const [name, value] of client.cookies) readOnly.cookies.set(name, value);
		expect((await readOnly.session())?.user.email).toBe(email);
		expect(await expiresAt()).toBe(old);

		// Control: the normal instance refreshes it.
		expect((await client.session())?.user.email).toBe(email);
		expect(await expiresAt()).not.toBe(old);
	});
});

describe('Q3 round 3: sign-in limits never reveal whether an account exists', () => {
	it('token-less attempts by e-mail then by nickname answer the same for known and unknown names', async () => {
		const h = harness();
		const registered = uniqueEmail('r3-known');
		await createVerifiedUser(h, registered, { username: uniqueUsername('k') });
		const unknown = uniqueEmail('r3-unknown');
		const answers: number[][] = [];
		for (const email of [registered, unknown]) {
			const client = h.client();
			const seen: number[] = [];
			for (let index = 0; index < 3; index += 1) {
				const response = await client.post(
					'/sign-in/email',
					{ email, password: 'whatever pw 1' },
					{ turnstile: null }
				);
				seen.push(response.status);
			}
			const byName = await client.post(
				'/sign-in/username',
				{ username: email, password: 'whatever pw 1' },
				{ turnstile: null }
			);
			seen.push(byName.status);
			answers.push(seen);
		}
		expect(answers[0]).toEqual(answers[1]);
		// Turnstile is required each time; the 4th hits the requester's ip+name window.
		expect(answers[0]).toEqual([400, 400, 400, 429]);
	});

	it('token-less sign-ups answer the same for a taken and a free nickname', async () => {
		const h = harness();
		const taken = uniqueUsername('t');
		await createVerifiedUser(h, uniqueEmail('r3-owner'), { username: taken });
		const statuses: number[] = [];
		for (const username of [taken, uniqueUsername('f')]) {
			const response = await h
				.client()
				.post(
					'/sign-up/email',
					{ email: uniqueEmail('r3-probe'), password: 'long enough pw 1', name: 'x', username },
					{ turnstile: null }
				);
			statuses.push(response.status);
			expect(await errorCode(response)).toBe('TURNSTILE_REQUIRED');
		}
		expect(statuses).toEqual([400, 400]);
	});
});
