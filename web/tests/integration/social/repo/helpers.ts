// Fixtures of the social repository tests: curves, versions and lineages published through the
// repository itself, plus raw counters. Users come from ../../account/helpers.ts (straight D1
// inserts). Every id is unique, so the files can share the database.
import { env } from 'cloudflare:workers';
import { updateVisibility } from '#lib/server/account/profile.ts';
import { publishLineage } from '#lib/server/social/repo.ts';
import type { CurveInput, LineageVisibility, VersionInput } from '#lib/server/social/types.ts';
import { count, nick, seedUser, type SeededUser } from '../../account/helpers.ts';

export { count, nick, seedUser, type SeededUser };

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function sid(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

export function curveInput(overrides: Partial<CurveInput> = {}): CurveInput {
	const id = Array.from(
		crypto.getRandomValues(new Uint8Array(12)),
		(byte) => BASE32[byte % 32]
	).join('');
	return {
		id,
		s1: `S1-${crypto.randomUUID()}`.padEnd(68, 'x'),
		canonKey: `v1;0;PK,1000,30,100;${id}`,
		gateVer: 'v2:test',
		gateOk: true,
		gateReasons: [],
		levelDb: -3,
		...overrides
	};
}

export function versionInput(overrides: Partial<VersionInput> = {}): VersionInput {
	return {
		id: sid('ver'),
		name: 'Warm vocal',
		description: 'A gentle lift around 3 kHz.',
		license: 'CC-BY-4.0',
		recipe: null,
		lang: 'en-US',
		...overrides
	};
}

export interface Published {
	lineageId: string;
	versionId: string;
	curve: CurveInput;
}

export async function publish(
	ownerUserId: string,
	options: { visibility?: LineageVisibility; now?: number; curve?: CurveInput } = {}
): Promise<Published> {
	const lineageId = sid('lin');
	const version = versionInput();
	const curve = options.curve ?? curveInput();
	const result = await publishLineage(env.DB, {
		lineageId,
		ownerUserId,
		visibility: options.visibility ?? 'public',
		curve,
		version,
		now: options.now ?? Date.now()
	});
	if (!result.ok) throw new Error(`publish failed: ${result.code}`);
	return { lineageId, versionId: version.id, curve };
}

/** A verified user with a nickname and the given profile visibility. */
export async function member(
	visibility: { activity?: 'private' | 'public'; library?: 'private' | 'public' } = {}
): Promise<SeededUser & { username: string }> {
	const username = nick('m');
	const user = await seedUser({ username });
	await updateVisibility(env.DB, user.id, {
		activity: visibility.activity ?? 'private',
		library: visibility.library ?? 'private'
	});
	return { ...user, username };
}

export async function setUserCreatedAt(userId: string, at: number): Promise<void> {
	await env.DB.prepare('UPDATE "user" SET "createdAt" = ? WHERE "id" = ?')
		.bind(new Date(at).toISOString(), userId)
		.run();
}

export async function ban(userId: string): Promise<void> {
	await env.DB.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').bind(userId).run();
}

/** Errors thrown by D1 for a statement, as text (for trigger and constraint assertions). */
export async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return 'no error';
}
