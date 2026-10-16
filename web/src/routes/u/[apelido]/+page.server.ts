// /u/[apelido] (T4.11): public profile, SSR. Previous nickname on hold (90 days) or another
// spelling of the nickname → 308 to the current path; unknown, released or banned → 404.
// Library off → only nickname, bio and counts; library on → creations and public packs;
// favorites only when the activity is public too (rules in social/profiles.ts).
import { error, redirect } from '@sveltejs/kit';
import { getServerEnv } from '#lib/server/env.ts';
import {
	findProfile,
	loadProfileOverview,
	type ProfileOverview
} from '#lib/server/social/profiles.ts';

export const prerender = false;

export interface ProfileLoadEvent {
	params: { apelido: string };
	platform?: { readonly env?: unknown } | undefined;
}

export async function load(event: ProfileLoadEvent): Promise<ProfileOverview> {
	const db = getServerEnv(event.platform).db;
	const found = await findProfile(db, event.params.apelido, Date.now());
	if (found.kind === 'missing') error(404);
	if (found.kind === 'redirect') redirect(308, `/u/${encodeURIComponent(found.to)}`);
	return loadProfileOverview(db, found.profile);
}
