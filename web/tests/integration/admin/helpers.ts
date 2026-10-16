// Shared helpers of the admin integration tests (T3.8).
import type { setupNetwork } from '@msw/cloudflare';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { toAuthLocals } from '#lib/server/auth.ts';
import type { AuthSession, AuthUser } from '#lib/server/types.ts';
import {
	createVerifiedUser,
	Harness,
	mockNetwork,
	PASSWORD,
	signedIn,
	totpSecretFromUri,
	uniqueEmail,
	uniqueUsername,
	type Client
} from '../auth/harness.ts';

type Network = ReturnType<typeof setupNetwork>;

export function harness(
	network: Network,
	overrides: ConstructorParameters<typeof Harness>[0] = {}
): Harness {
	network.resetHandlers();
	mockNetwork(network);
	return new Harness(overrides);
}

export async function localsOf(client: Client): Promise<{ user: AuthUser; session: AuthSession }> {
	const current = toAuthLocals(await client.session());
	if (!current) throw new Error('not signed in');
	return current;
}

export async function makeAdmin(userId: string): Promise<void> {
	await env.DB.prepare(`UPDATE "user" SET role = 'admin' WHERE id = ?`).bind(userId).run();
}

export async function totpCode(h: Harness, secret: string): Promise<string> {
	const { code } = await h.auth.api.generateTOTP({ body: { secret } });
	return code;
}

/** Enables TOTP for the signed-in client (sets the session's 2FA marker); returns the secret. */
export async function enableTotp(h: Harness, client: Client): Promise<string> {
	const enabled = await client.post('/two-factor/enable', { password: PASSWORD });
	expect(enabled.status).toBe(200);
	const body = (await enabled.json()) as { totpURI: string };
	const secret = totpSecretFromUri(body.totpURI);
	const verified = await client.post('/two-factor/verify-totp', {
		code: await totpCode(h, secret)
	});
	expect(verified.status).toBe(200);
	return secret;
}

export interface Account {
	id: string;
	email: string;
	username: string;
	client: Client;
}

/** A verified, signed-in account with a nickname; `admin` also gets the admin role. */
export async function account(h: Harness, prefix: string, admin = false): Promise<Account> {
	const email = uniqueEmail(prefix);
	// Neutral nicknames (a prefix such as "admin" could hit the reserved list).
	const username = uniqueUsername('u');
	const id = await createVerifiedUser(h, email, { username });
	if (admin) await makeAdmin(id);
	const client = await signedIn(h, email);
	return { id, email, username, client };
}

export function adminRequest(
	h: Harness,
	path = '/admin',
	headers: Record<string, string> = {}
): Request {
	return new Request(`${h.origin}${path}`, { headers });
}
