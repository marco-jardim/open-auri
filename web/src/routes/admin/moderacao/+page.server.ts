// /admin/moderacao (T4.8): queue of reported targets (grouped by target, reason counts, preview)
// and the decisions hide / restore / remove / dismiss / ban author / curate / uncurate. Every
// load and action runs the admin guard itself; remove and ban are destructive (fresh session,
// otherwise `fail(403, { reauth })`). Each decision is audited by social/moderation.ts.
import { fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import { reauthAction } from '#lib/server/admin/actions.ts';
import { requireAdminAction, requireAdminPage, type ReauthFailure } from '#lib/server/admin/kit.ts';
import {
	decide,
	isDestructive,
	loadQueue,
	parseDecisionForm,
	type DecisionError,
	type ModerationDecision,
	type QueuePage
} from '#lib/server/social/moderation.ts';
import { SocialRepoError } from '#lib/server/social/types.ts';
import type { Actions, PageServerLoad } from './$types';

export const prerender = false;

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

export const load: PageServerLoad = async (event) => {
	const admin = await requireAdminPage(event);
	const raw = event.url.searchParams.get('cursor') ?? '';
	const cursor = CURSOR.test(raw) ? raw : null;
	const now = Date.now();
	let page: QueuePage;
	try {
		page = await loadQueue(admin.env.db, { cursor, now });
	} catch (error) {
		if (!(error instanceof SocialRepoError)) throw error;
		// A stale or edited cursor: show the first page instead.
		page = await loadQueue(admin.env.db, { cursor: null, now });
	}
	return {
		cursor,
		nextCursor: page.nextCursor,
		selfId: admin.user.id,
		items: page.items.map((item) => ({
			targetKind: item.targetKind,
			targetId: item.targetId,
			openReports: item.openReports,
			eligibleReporters: item.eligibleReporters,
			firstAt: new Date(item.firstAt).toISOString(),
			lastAt: new Date(item.lastAt).toISOString(),
			reasons: item.reasons,
			notes: item.notes.map((note) => ({
				note: note.note,
				reason: note.reason,
				at: new Date(note.at).toISOString()
			})),
			preview: item.preview
		}))
	};
};

type AdminEvent = Pick<RequestEvent, 'locals' | 'platform' | 'request'>;

type DecisionActionData =
	| { done: ModerationDecision; targetId: string; resolved: number }
	| { error: DecisionError; targetId: string | null };

async function decision(
	event: AdminEvent,
	kind: ModerationDecision
): Promise<DecisionActionData | ActionFailure<DecisionActionData | ReauthFailure>> {
	const admin = isDestructive(kind)
		? await requireAdminAction(event)
		: await requireAdminPage(event);
	if (!('user' in admin)) return admin;
	const form = await event.request.formData();
	const rawId = form.get('targetId');
	const targetId = typeof rawId === 'string' ? rawId.slice(0, 64) : null;
	const input = parseDecisionForm(form, kind);
	if (!input) return fail(400, { error: 'INVALID_INPUT' as const, targetId });
	const result = await decide(
		{ db: admin.env.db, auth: admin.auth, headers: event.request.headers, actorId: admin.user.id },
		input
	);
	if (!result.ok) {
		const status =
			result.code === 'NOT_FOUND'
				? 404
				: result.code === 'FAILED'
					? 500
					: result.code === 'INVALID_INPUT'
						? 400
						: 409;
		return fail(status, { error: result.code, targetId });
	}
	return { done: kind, targetId: input.targetId, resolved: result.resolved };
}

export const actions: Actions = {
	hide: (event) => decision(event, 'hide'),
	restore: (event) => decision(event, 'restore'),
	remove: (event) => decision(event, 'remove'),
	dismiss: (event) => decision(event, 'dismiss'),
	ban: (event) => decision(event, 'ban'),
	curate: (event) => decision(event, 'curate'),
	uncurate: (event) => decision(event, 'uncurate'),
	reauth: (event) => reauthAction(event)
};
