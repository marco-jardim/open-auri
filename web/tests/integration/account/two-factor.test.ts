// Two-step verification in /conta (FX3.4): account/two-factor.ts through a real Better Auth
// instance (the auth hooks apply: per-user attempt limits, the admin 2FA-marker rule). TOTP codes
// are computed here (RFC 6238, HMAC over the key decoded from the otpauth URI), not by Better Auth.
// Turning 2FA off needs the password plus a current code or a backup code (issue #21). Confirm and
// disable rotate the session; the new cookie reaches the browser and the next load lists that
// session as the current one (issue #20: /conta now redirects after both).
import { setupNetwork } from '@msw/cloudflare';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { listAccountSessions } from '#lib/server/account/sessions.ts';
import {
	confirmEnrolment,
	disableTwoFactor,
	normalizeTotpCode,
	readSecondFactor,
	readTwoFactorStatus,
	startEnrolment,
	type DisableTwoFactorInput
} from '#lib/server/account/two-factor.ts';
import { toAuthLocals } from '#lib/server/auth.ts';
import {
	createVerifiedUser,
	Harness,
	mockNetwork,
	PASSWORD,
	signedIn,
	uniqueEmail,
	type Client
} from '../auth/harness.ts';

const network = setupNetwork();

// Sign-up, verification and sign-in per test, plus scrypt on every password check.
vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
	network.configure({ onUnhandledFrame: 'error' });
	await network.enable();
});
afterAll(async () => {
	await network.disable();
});
afterEach(() => {
	vi.restoreAllMocks();
});

const WRONG_PASSWORD = 'definitely not it 0';

/** The one refusal of a disable with a missing or wrong password or code. */
const REFUSED = { ok: false, code: 'wrong-password-or-code', status: 400 } as const;

/**
 * The browser of the server-side `auth.api.*` call in progress (the /conta actions). In production
 * `sveltekitCookies(getRequestEvent)` copies the Set-Cookie of such calls onto the response (the
 * 303 of confirm and disable included); here the same plugin writes into this client's jar.
 */
let cookieTarget: Client | null = null;

const fakeRequestEvent = {
	cookies: {
		set(name: string, value: string, options: { maxAge?: number; expires?: Date } = {}) {
			const expired =
				value === '' ||
				options.maxAge === 0 ||
				(options.expires !== undefined && options.expires.getTime() <= Date.now());
			if (expired) cookieTarget?.cookies.delete(name);
			else cookieTarget?.cookies.set(name, value);
		}
	}
};

/** Runs a server-side auth call as `client` (its Set-Cookie lands in the client's jar). */
async function as<T>(client: Client, run: () => Promise<T>): Promise<T> {
	cookieTarget = client;
	try {
		return await run();
	} finally {
		cookieTarget = null;
	}
}

function harness(logs?: string[]): Harness {
	network.resetHandlers();
	mockNetwork(network);
	return new Harness(
		{},
		{
			...(logs ? { log: (entry: unknown) => logs.push(JSON.stringify(entry) ?? '') } : {}),
			plugins: [sveltekitCookies(() => (cookieTarget ? fakeRequestEvent : undefined) as never)]
		}
	);
}

// --- RFC 6238 ---------------------------------------------------------------------------------------

/** RFC 4648 base32 → bytes (the HMAC key). */
function base32Bytes(encoded: string): Uint8Array {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const bytes: number[] = [];
	for (const char of encoded.replace(/=+$/, '').toUpperCase()) {
		const index = alphabet.indexOf(char);
		if (index < 0) throw new Error('bad base32');
		value = ((value << 5) | index) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return new Uint8Array(bytes);
}

/** TOTP (RFC 6238 / RFC 4226 truncation) for the parameters of an otpauth:// URI. */
async function totp(uri: string, at = Date.now()): Promise<string> {
	const url = new URL(uri);
	const key = base32Bytes(url.searchParams.get('secret') ?? '');
	const digits = Number(url.searchParams.get('digits') ?? '6');
	const period = Number(url.searchParams.get('period') ?? '30');
	const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1')
		.toUpperCase()
		.replace(/^SHA-?(\d+)$/, 'SHA-$1');
	const counter = Math.floor(at / 1000 / period);
	const message = new DataView(new ArrayBuffer(8));
	message.setUint32(0, Math.floor(counter / 2 ** 32));
	message.setUint32(4, counter >>> 0);
	const hmacKey = await crypto.subtle.importKey(
		'raw',
		key,
		{ name: 'HMAC', hash: algorithm },
		false,
		['sign']
	);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, message.buffer));
	const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
	const binary =
		(((mac[offset] ?? 0) & 0x7f) << 24) |
		((mac[offset + 1] ?? 0) << 16) |
		((mac[offset + 2] ?? 0) << 8) |
		(mac[offset + 3] ?? 0);
	return String(binary % 10 ** digits).padStart(digits, '0');
}

/** A 6-digit code valid in none of the windows Better Auth accepts around now. */
async function wrongCode(uri: string): Promise<string> {
	const now = Date.now();
	const valid = new Set(
		await Promise.all([-60_000, -30_000, 0, 30_000, 60_000].map((shift) => totp(uri, now + shift)))
	);
	for (let n = 0; ; n += 1) {
		const candidate = String(n).padStart(6, '0');
		if (!valid.has(candidate)) return candidate;
	}
}

// --- Fixtures ---------------------------------------------------------------------------------------

async function account(h: Harness, prefix: string) {
	const email = uniqueEmail(prefix);
	const id = await createVerifiedUser(h, email);
	const client = await signedIn(h, email);
	return { email, id, client, headers: () => client.headers({ origin: h.origin }) };
}

/** 2FA on through the HTTP endpoints (the client keeps the rotated session, with the marker). */
async function enableOverHttp(client: Client): Promise<{ totpURI: string; backupCodes: string[] }> {
	const enabled = await client.post('/two-factor/enable', { password: PASSWORD });
	expect(enabled.status).toBe(200);
	const { totpURI, backupCodes } = (await enabled.json()) as {
		totpURI: string;
		backupCodes: string[];
	};
	const verified = await client.post('/two-factor/verify-totp', { code: await totp(totpURI) });
	expect(verified.status).toBe(200);
	return { totpURI, backupCodes };
}

function disableInput(userId: string, password: string, code?: string): DisableTwoFactorInput {
	return { db: env.DB, userId, password, ...(code === undefined ? {} : { code }) };
}

async function enabledFlag(userId: string): Promise<number> {
	const row = await env.DB.prepare('SELECT "twoFactorEnabled" AS v FROM "user" WHERE id = ?')
		.bind(userId)
		.first<{ v: number | null }>();
	return Number(row?.v ?? 0);
}

async function twoFactorRow(userId: string) {
	return env.DB.prepare('SELECT secret, "backupCodes" AS codes FROM "twoFactor" WHERE "userId" = ?')
		.bind(userId)
		.first<{ secret: string; codes: string }>();
}

/** Id of the session the client's cookie points at. */
async function sessionIdOf(client: Client): Promise<string> {
	const current = toAuthLocals(await client.session());
	if (!current) throw new Error('signed out');
	return current.session.id;
}

/**
 * After a rotating step: the client holds a new session, and the list the next load renders (the
 * redirect's GET, with that cookie) marks it as the current one. With the pre-rotation id, the one
 * a same-request render used, the same session showed up as another one (issue #20).
 */
async function expectRotatedAndListedAsCurrent(
	userId: string,
	client: Client,
	before: string
): Promise<void> {
	const after = await sessionIdOf(client);
	expect(after).not.toBe(before);
	const listed = await listAccountSessions(env.DB, userId, after, Date.now());
	expect(listed.filter((session) => session.current).map((session) => session.id)).toEqual([after]);
	expect(listed.some((session) => session.id === before)).toBe(false);
	const stale = await listAccountSessions(env.DB, userId, before, Date.now());
	expect(stale.find((session) => session.id === after)?.current).toBe(false);
}

// --- Tests ------------------------------------------------------------------------------------------

describe('normalizeTotpCode', () => {
	it('accepts six digits with spaces or a hyphen, nothing else', () => {
		expect(normalizeTotpCode('123456')).toBe('123456');
		expect(normalizeTotpCode(' 123 456 ')).toBe('123456');
		expect(normalizeTotpCode('123-456')).toBe('123456');
		expect(normalizeTotpCode('12345')).toBeNull();
		expect(normalizeTotpCode('1234567')).toBeNull();
		expect(normalizeTotpCode('12345a')).toBeNull();
		expect(normalizeTotpCode('')).toBeNull();
	});
});

describe('readSecondFactor', () => {
	it('takes six digits as a TOTP code and other code-shaped input as a backup code', () => {
		expect(readSecondFactor(' 123 456 ')).toEqual({ method: 'totp', code: '123456' });
		expect(readSecondFactor(' aB3dE-fG4hI ')).toEqual({ method: 'backup', code: 'aB3dE-fG4hI' });
		expect(readSecondFactor('')).toBeNull();
		expect(readSecondFactor('12')).toBeNull();
		expect(readSecondFactor('<script>')).toBeNull();
	});
});

describe('two-step verification from /conta', () => {
	it('start needs the correct password; 2FA stays off until a code is confirmed', async () => {
		const h = harness();
		const { id, headers } = await account(h, 'tf-start');

		expect(await startEnrolment(h.auth, headers(), '')).toEqual({
			ok: false,
			code: 'wrong-password',
			status: 400
		});
		expect(await startEnrolment(h.auth, headers(), WRONG_PASSWORD)).toEqual({
			ok: false,
			code: 'wrong-password',
			status: 400
		});
		expect(await readTwoFactorStatus(env.DB, id)).toBe('off');
		expect(await twoFactorRow(id)).toBeNull();

		const started = await startEnrolment(h.auth, headers(), PASSWORD);
		if (!started.ok) throw new Error(`start failed: ${started.code}`);
		expect(started.totpURI).toMatch(/^otpauth:\/\/totp\//);
		expect(new URL(started.totpURI).searchParams.get('issuer')).toBe('open-auri');
		expect(started.backupCodes.length).toBeGreaterThan(0);
		expect(await readTwoFactorStatus(env.DB, id)).toBe('pending');
		expect(await enabledFlag(id)).toBe(0);

		// Stored encrypted only: neither the key nor a backup code is in D1 in clear.
		const row = await twoFactorRow(id);
		const base32 = new URL(started.totpURI).searchParams.get('secret') ?? '';
		const raw = new TextDecoder().decode(base32Bytes(base32));
		expect(row?.secret).not.toContain(base32);
		expect(row?.secret).not.toContain(raw);
		for (const code of started.backupCodes) expect(row?.codes).not.toContain(code);

		// Starting again replaces the pending setup with a new key.
		const again = await startEnrolment(h.auth, headers(), PASSWORD);
		if (!again.ok) throw new Error(`restart failed: ${again.code}`);
		expect(again.totpURI).not.toBe(started.totpURI);
		expect(await readTwoFactorStatus(env.DB, id)).toBe('pending');
	});

	it('a pending setup is cancelled with the password alone; a code there is never checked', async () => {
		const h = harness();
		const { id, headers } = await account(h, 'tf-cancel');
		const started = await startEnrolment(h.auth, headers(), PASSWORD);
		if (!started.ok) throw new Error(`start failed: ${started.code}`);

		// A valid code is ignored (checking it would confirm the setup): only the password counts.
		const code = await totp(started.totpURI);
		expect(
			await disableTwoFactor(h.auth, headers(), disableInput(id, WRONG_PASSWORD, code))
		).toEqual({ ok: false, code: 'wrong-password', status: 400 });
		expect(await readTwoFactorStatus(env.DB, id)).toBe('pending');
		expect(await enabledFlag(id)).toBe(0);

		expect(await disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD))).toEqual({
			ok: true
		});
		expect(await readTwoFactorStatus(env.DB, id)).toBe('off');
		expect(await twoFactorRow(id)).toBeNull();
	});

	it('a wrong code is refused; the current code turns 2FA on and marks the session', async () => {
		const h = harness();
		const { email, id, client, headers } = await account(h, 'tf-confirm');
		const started = await startEnrolment(h.auth, headers(), PASSWORD);
		if (!started.ok) throw new Error(`start failed: ${started.code}`);

		// Malformed: refused before Better Auth.
		expect(await confirmEnrolment(h.auth, headers(), '12')).toEqual({
			ok: false,
			code: 'invalid-code',
			status: 400
		});
		expect(await confirmEnrolment(h.auth, headers(), await wrongCode(started.totpURI))).toEqual({
			ok: false,
			code: 'invalid-code',
			status: 400
		});
		expect(await readTwoFactorStatus(env.DB, id)).toBe('pending');
		expect(await enabledFlag(id)).toBe(0);

		const before = await sessionIdOf(client);
		const code = await totp(started.totpURI);
		const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
		expect(await as(client, () => confirmEnrolment(h.auth, headers(), spaced))).toEqual({
			ok: true
		});
		expect(await readTwoFactorStatus(env.DB, id)).toBe('on');
		expect(await enabledFlag(id)).toBe(1);

		// Better Auth rotated the session; the new one carries the 2FA marker, the old one is gone,
		// and the page after the redirect lists the new one as the current session.
		const marked = await env.DB.prepare(
			'SELECT count(*) AS n FROM "session" WHERE "userId" = ? AND "twoFactorVerifiedAt" IS NOT NULL'
		)
			.bind(id)
			.first<{ n: number }>();
		expect(marked?.n).toBe(1);
		await expectRotatedAndListedAsCurrent(id, client, before);

		// From now on, signing in asks for the second factor.
		const signIn = await h.client().signIn(email);
		expect(signIn.status).toBe(200);
		expect(((await signIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
	});

	it('disable refuses the password alone, a wrong code, or a wrong password, with one answer', async () => {
		const h = harness();
		const { id, client } = await account(h, 'tf-disable');
		const { totpURI } = await enableOverHttp(client);
		const headers = () => client.headers({ origin: h.origin });
		expect(await readTwoFactorStatus(env.DB, id)).toBe('on');

		expect(await startEnrolment(h.auth, headers(), PASSWORD)).toEqual({
			ok: false,
			code: 'already-enabled',
			status: 400
		});
		const code = await totp(totpURI);
		// Missing a field (the password alone was the old rule): refused before Better Auth.
		expect(await disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD))).toEqual(REFUSED);
		expect(await disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD, ''))).toEqual(
			REFUSED
		);
		expect(await disableTwoFactor(h.auth, headers(), disableInput(id, '', code))).toEqual(REFUSED);
		// A wrong code, or the right code with a wrong password: the same refusal.
		expect(
			await disableTwoFactor(
				h.auth,
				headers(),
				disableInput(id, PASSWORD, await wrongCode(totpURI))
			)
		).toEqual(REFUSED);
		expect(
			await disableTwoFactor(h.auth, headers(), disableInput(id, WRONG_PASSWORD, code))
		).toEqual(REFUSED);
		expect(await readTwoFactorStatus(env.DB, id)).toBe('on');
		expect(await enabledFlag(id)).toBe(1);
	});

	it('the password plus a current TOTP code turns 2FA off; the new session is the current one', async () => {
		const h = harness();
		const { id, client } = await account(h, 'tf-disable-totp');
		const { totpURI } = await enableOverHttp(client);
		const headers = () => client.headers({ origin: h.origin });

		const before = await sessionIdOf(client);
		const code = await totp(totpURI);
		expect(
			await as(client, () => disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD, code)))
		).toEqual({ ok: true });
		expect(await readTwoFactorStatus(env.DB, id)).toBe('off');
		expect(await enabledFlag(id)).toBe(0);
		expect(await twoFactorRow(id)).toBeNull();
		await expectRotatedAndListedAsCurrent(id, client, before);
	});

	it('a backup code works instead of the app code, and is spent once checked', async () => {
		const h = harness();
		const { id, client } = await account(h, 'tf-disable-backup');
		const { backupCodes } = await enableOverHttp(client);
		const headers = () => client.headers({ origin: h.origin });
		const [spent, kept] = backupCodes;
		if (!spent || !kept) throw new Error('fewer than two backup codes');

		// The code is checked before the password: with a wrong password it is refused and used up.
		expect(
			await disableTwoFactor(h.auth, headers(), disableInput(id, WRONG_PASSWORD, spent))
		).toEqual(REFUSED);
		expect(await disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD, spent))).toEqual(
			REFUSED
		);
		expect(await readTwoFactorStatus(env.DB, id)).toBe('on');

		const before = await sessionIdOf(client);
		expect(
			await as(client, () =>
				disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD, ` ${kept} `))
			)
		).toEqual({ ok: true });
		expect(await readTwoFactorStatus(env.DB, id)).toBe('off');
		expect(await enabledFlag(id)).toBe(0);
		// Every backup code went with the row.
		expect(await twoFactorRow(id)).toBeNull();
		await expectRotatedAndListedAsCurrent(id, client, before);
	});

	it('an admin without the session 2FA marker disables only with a code (which marks it)', async () => {
		const h = harness();
		const { id, client } = await account(h, 'tf-admin');
		const { totpURI } = await enableOverHttp(client);
		await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE id = ?`).bind(id).run();
		// A session of this admin that never went through the second factor.
		await env.DB.prepare('UPDATE "session" SET "twoFactorVerifiedAt" = NULL WHERE "userId" = ?')
			.bind(id)
			.run();
		const headers = () => client.headers({ origin: h.origin });

		expect(await disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD))).toEqual(REFUSED);
		expect(await readTwoFactorStatus(env.DB, id)).toBe('on');

		// The code of the same form verifies the second factor in this session first.
		expect(
			await disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD, await totp(totpURI)))
		).toEqual({ ok: true });
		expect(await readTwoFactorStatus(env.DB, id)).toBe('off');
	});

	it('password attempts are limited per user (429 + Retry-After)', async () => {
		const h = harness();
		const { headers } = await account(h, 'tf-limit');
		const results: Awaited<ReturnType<typeof startEnrolment>>[] = [];
		for (let attempt = 0; attempt < 7; attempt += 1) {
			results.push(await startEnrolment(h.auth, headers(), WRONG_PASSWORD));
		}
		const limited = results.find((result) => !result.ok && result.code === 'RATE_LIMITED');
		expect(limited).toMatchObject({ ok: false, code: 'RATE_LIMITED', status: 429 });
		expect(limited && !limited.ok ? limited.retryAfter : 0).toBeGreaterThan(0);
	});

	it('codes tried on disable are limited per user (429 + Retry-After)', async () => {
		const h = harness();
		const { id, client } = await account(h, 'tf-disable-limit');
		const { totpURI } = await enableOverHttp(client);
		const headers = () => client.headers({ origin: h.origin });
		const wrong = await wrongCode(totpURI);

		expect(
			await disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD, 'zzzzz-zzzzz'))
		).toEqual(REFUSED);
		const results: Awaited<ReturnType<typeof disableTwoFactor>>[] = [];
		for (let attempt = 0; attempt < 7; attempt += 1) {
			results.push(await disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD, wrong)));
		}
		expect(results[0]).toEqual(REFUSED);
		const limited = results.find((result) => !result.ok && result.code === 'RATE_LIMITED');
		expect(limited).toMatchObject({ ok: false, code: 'RATE_LIMITED', status: 429 });
		expect(limited && !limited.ok ? limited.retryAfter : 0).toBeGreaterThan(0);
		expect(await readTwoFactorStatus(env.DB, id)).toBe('on');
	});

	it('without a session every step is refused as unauthenticated', async () => {
		const h = harness();
		const headers = new Headers({ origin: h.origin, 'cf-connecting-ip': '10.9.9.9' });
		expect(await startEnrolment(h.auth, headers, PASSWORD)).toMatchObject({
			ok: false,
			code: 'unauthenticated',
			status: 401
		});
		expect(await confirmEnrolment(h.auth, headers, '123456')).toMatchObject({ ok: false });
		expect(
			await disableTwoFactor(h.auth, headers, disableInput('no-such-user', PASSWORD, '123456'))
		).toMatchObject({ ok: false });
	});

	it('nothing secret reaches the logs', async () => {
		const lines: string[] = [];
		const capture =
			(level: string) =>
			(...args: unknown[]) => {
				lines.push(
					`${level} ${args
						.map((arg) => (typeof arg === 'string' ? arg : (JSON.stringify(arg) ?? String(arg))))
						.join(' ')}`
				);
			};
		for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
			vi.spyOn(console, level).mockImplementation(capture(level));
		}
		const h = harness(lines);
		const { id, client, headers } = await account(h, 'tf-logs');

		// Failures and successes of every step.
		await startEnrolment(h.auth, headers(), WRONG_PASSWORD);
		const started = await startEnrolment(h.auth, headers(), PASSWORD);
		if (!started.ok) throw new Error(`start failed: ${started.code}`);
		const wrong = await wrongCode(started.totpURI);
		await confirmEnrolment(h.auth, headers(), wrong);
		await disableTwoFactor(h.auth, headers(), disableInput(id, WRONG_PASSWORD));
		const code = await totp(started.totpURI);
		expect(await as(client, () => confirmEnrolment(h.auth, headers(), code))).toEqual({ ok: true });
		expect(await readTwoFactorStatus(env.DB, id)).toBe('on');
		await disableTwoFactor(h.auth, headers(), disableInput(id, PASSWORD, wrong));
		await disableTwoFactor(h.auth, headers(), disableInput(id, WRONG_PASSWORD, code));
		await disableTwoFactor(
			h.auth,
			headers(),
			disableInput(id, WRONG_PASSWORD, started.backupCodes[0] ?? '')
		);

		const base32 = new URL(started.totpURI).searchParams.get('secret') ?? '';
		const secrets = [
			started.totpURI,
			base32,
			new TextDecoder().decode(base32Bytes(base32)),
			...started.backupCodes,
			PASSWORD,
			WRONG_PASSWORD,
			code,
			wrong
		];
		const printed = lines.join('\n');
		for (const secret of secrets) expect(printed).not.toContain(secret);
	});
});
