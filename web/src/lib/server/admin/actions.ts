// SvelteKit form actions shared by the /admin pages. Each one runs the guard itself (actions do
// not wait for the layout load), destructive ones with the freshness check; every mutation is
// audited by the modules it calls. Results are plain objects for `form` (no personal data).
import { fail, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import { requireAdminAction, requireAdminPage, type ReauthFailure } from './kit.ts';
import { reauthenticate, type ReauthResult } from './reauth.ts';
import { setReadOnly } from './read-only.ts';
import {
	banUser,
	parseBanForm,
	parseUnbanForm,
	unbanUser,
	type ModerationError,
	type ModerationResult
} from './users.ts';

type AdminEvent = Pick<RequestEvent, 'locals' | 'platform' | 'request'>;

export type ReauthActionData =
	{ reauthed: true } | { reauth: true; reauthError: Exclude<ReauthResult, { ok: true }>['code'] };

/** `?/reauth`: TOTP code → fresh session (non-destructive guard: a stale admin may call it). */
export async function reauthAction(
	event: AdminEvent
): Promise<ReauthActionData | ActionFailure<ReauthActionData>> {
	const admin = await requireAdminPage(event);
	const form = await event.request.formData();
	const result = await reauthenticate(
		{
			db: admin.env.db,
			auth: admin.auth,
			headers: event.request.headers,
			rateLimit: admin.env.rateLimit.auth,
			user: admin.user
		},
		form.get('code')
	);
	if (!result.ok) {
		return fail(result.code === 'RATE_LIMITED' ? 429 : 400, {
			reauth: true as const,
			reauthError: result.code
		});
	}
	return { reauthed: true as const };
}

export type ReadOnlyActionData = { done: 'read_only_on' | 'read_only_off' } | { error: 'invalid' };

/** `?/readOnly`: turns the emergency switch on (`mode=on`) or off (`mode=off`). */
export async function readOnlyAction(
	event: AdminEvent
): Promise<ReadOnlyActionData | ActionFailure<ReadOnlyActionData | ReauthFailure>> {
	const admin = await requireAdminAction(event);
	if (!('user' in admin)) return admin;
	const mode = (await event.request.formData()).get('mode');
	if (mode !== 'on' && mode !== 'off') return fail(400, { error: 'invalid' as const });
	await setReadOnly(admin.env, mode === 'on', admin.user.id);
	return { done: mode === 'on' ? 'read_only_on' : 'read_only_off' };
}

export type ModerationActionData =
	{ done: 'ban' | 'unban'; userId: string } | { error: ModerationError; userId: string | null };

function moderationStatus(code: ModerationError): 400 | 404 | 409 | 500 {
	if (code === 'NOT_FOUND') return 404;
	if (code === 'FAILED') return 500;
	if (code === 'INVALID_INPUT') return 400;
	return 409;
}

async function moderate(
	event: AdminEvent,
	kind: 'ban' | 'unban'
): Promise<ModerationActionData | ActionFailure<ModerationActionData | ReauthFailure>> {
	const admin = await requireAdminAction(event);
	if (!('user' in admin)) return admin;
	const form = await event.request.formData();
	const deps = {
		db: admin.env.db,
		auth: admin.auth,
		headers: event.request.headers,
		actorId: admin.user.id
	};
	const rawId = form.get('userId');
	const userId = typeof rawId === 'string' ? rawId.slice(0, 64) : null;
	let result: ModerationResult;
	if (kind === 'ban') {
		const input = parseBanForm(form);
		if (!input) return fail(400, { error: 'INVALID_INPUT' as const, userId });
		result = await banUser(deps, input);
	} else {
		const input = parseUnbanForm(form);
		if (!input) return fail(400, { error: 'INVALID_INPUT' as const, userId });
		result = await unbanUser(deps, input);
	}
	if (!result.ok) return fail(moderationStatus(result.code), { error: result.code, userId });
	return { done: kind, userId: userId ?? '' };
}

/** `?/ban`: userId, reason, duration. */
export function banAction(event: AdminEvent) {
	return moderate(event, 'ban');
}

/** `?/unban`: userId, reason. */
export function unbanAction(event: AdminEvent) {
	return moderate(event, 'unban');
}
