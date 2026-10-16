// Fixtures of the moderation tests (T4.8): reporters of a given age and state, report targets and
// small readers. Every id is unique, so the files can share the database.
import { env } from 'cloudflare:workers';
import type { AuthLocals } from '#lib/server/auth/guards.ts';
import type { ModerationState } from '#lib/server/social/types.ts';
import { authSession, authUser, DAY, uid } from '../../account/helpers.ts';
import { publish, seedUser, setUserCreatedAt, type SeededUser } from '../repo/helpers.ts';

export { DAY, publish, seedUser, uid, type SeededUser };

export interface ReporterOptions {
	/** Account age in days (default 4: eligible). */
	ageDays?: number;
	verified?: boolean;
	banned?: boolean;
}

/** A user row with the given age, verification and ban state. */
export async function reporter(options: ReporterOptions = {}): Promise<SeededUser> {
	const user = await seedUser({
		verified: options.verified ?? true,
		banned: options.banned ?? false
	});
	await setUserCreatedAt(user.id, Date.now() - (options.ageDays ?? 4) * DAY);
	return user;
}

/** API locals of a seeded user (session not stored: the API reads locals only). */
export function apiLocals(user: SeededUser, verified = true): AuthLocals {
	return {
		user: authUser(user, { emailVerified: verified }),
		session: authSession(user.id, uid('session'))
	};
}

export async function lineageModeration(id: string): Promise<ModerationState | null> {
	const row = await env.DB.prepare('SELECT moderation FROM lineages WHERE id = ?')
		.bind(id)
		.first<{ moderation: ModerationState }>();
	return row?.moderation ?? null;
}

export async function lineageCurated(id: string): Promise<number | null> {
	const row = await env.DB.prepare('SELECT curated FROM lineages WHERE id = ?')
		.bind(id)
		.first<{ curated: number }>();
	return row?.curated ?? null;
}

export async function resolutions(kind: string, id: string): Promise<(string | null)[]> {
	const rows = await env.DB.prepare(
		'SELECT resolution FROM reports WHERE target_kind = ? AND target_id = ? ORDER BY created_at, id'
	)
		.bind(kind, id)
		.all<{ resolution: string | null }>();
	return rows.results.map((row) => row.resolution);
}

export async function reportCount(kind: string, id: string): Promise<number> {
	const row = await env.DB.prepare(
		'SELECT count(*) AS n FROM reports WHERE target_kind = ? AND target_id = ?'
	)
		.bind(kind, id)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/** A public lineage owned by a fresh verified user. */
export async function target(): Promise<{ owner: SeededUser; lineageId: string }> {
	const owner = await seedUser();
	const { lineageId } = await publish(owner.id);
	return { owner, lineageId };
}
