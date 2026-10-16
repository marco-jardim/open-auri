// /conta: profile, security, e-mail, data and account closure (T3.7). Thin glue over
// #lib/server/account (tested in workerd). Rules:
//   - load: anonymous → 303 /entrar?next=/conta; banned → 403;
//   - every action re-checks access itself (actions do not run the load first) and acts only on
//     `locals.user.id`; profile actions also need a verified e-mail;
//   - CSRF: SvelteKit's origin check on form actions (kept on; never disabled for this route);
//   - sensitive actions: password change needs the current password, e-mail change a fresh
//     session or the password, closure the password plus the mailed confirmation link.
import { error, fail, redirect, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import type { FormFeedback, FormId } from '#lib/components/account/types.ts';
import {
	accountAccess,
	BIO_MAX,
	changeAccountPassword,
	changeNickname,
	getAccountProfile,
	isDeletionMode,
	listAccountSessions,
	listNicknameHolds,
	PASSWORD_MAX,
	PASSWORD_MIN,
	pendingEmailChange,
	policyBannerState,
	readDeletionRequest,
	requestAccountClosure,
	requestEmailChange,
	revokeAccountSession,
	revokeOtherAccountSessions,
	signInRedirect,
	updateBio,
	updateVisibility,
	type AuthFailure
} from '#lib/server/account/index.ts';
import { isFreshSession } from '#lib/server/auth/session-policy.ts';
import { USERNAME_MAX, USERNAME_MIN } from '#lib/server/auth/username.ts';
import { getServerEnv } from '#lib/server/env.ts';
import { TURNSTILE_ACTIONS } from '#lib/server/security/turnstile.ts';
import type { AuthSession, AuthUser } from '#lib/server/types.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, url }) => {
	const access = accountAccess(locals);
	if (!access.ok) {
		if (access.status === 401) redirect(303, signInRedirect(url.pathname));
		error(access.status, access.code);
	}
	const { user, session } = access;
	const db = getServerEnv(platform).db;
	const now = Date.now();
	const profile = await getAccountProfile(db, user.id, now);
	if (!profile) redirect(303, signInRedirect(url.pathname));
	const [sessions, pendingEmail, holds, closure, policy] = await Promise.all([
		listAccountSessions(db, user.id, session.id, now),
		pendingEmailChange(db, user.id, profile.email, now),
		listNicknameHolds(db, user.id, now),
		readDeletionRequest(db, user.id),
		policyBannerState(db, user.id)
	]);
	return {
		profile: {
			email: profile.email,
			emailVerified: profile.emailVerified,
			username: profile.username,
			displayUsername: profile.displayUsername,
			bio: profile.bio,
			activityVisibility: profile.activityVisibility,
			libraryVisibility: profile.libraryVisibility,
			nextNicknameChangeAt: profile.nextNicknameChangeAt
		},
		sessions,
		pendingEmail,
		holds,
		closure,
		policy,
		fresh: isFreshSession(session, undefined, now),
		emailChanged: url.searchParams.get('email') === 'alterado',
		limits: {
			bioMax: BIO_MAX,
			nicknameMin: USERNAME_MIN,
			nicknameMax: USERNAME_MAX,
			passwordMin: PASSWORD_MIN,
			passwordMax: PASSWORD_MAX
		},
		turnstileAction: TURNSTILE_ACTIONS.changeEmail
	};
};

interface Context {
	user: AuthUser;
	session: AuthSession;
	db: D1Database;
	now: number;
}

type Result = Promise<FormFeedback | ActionFailure<FormFeedback>>;

function reject(status: number, feedback: FormFeedback): ActionFailure<FormFeedback> {
	return fail(status, feedback);
}

/** Access check of every action: the signed-in user (verified when `verified`), or a failure. */
function open(
	event: RequestEvent,
	form: FormId,
	verified = false
): Context | ActionFailure<FormFeedback> {
	const access = accountAccess(event.locals, verified);
	if (!access.ok) {
		const code = access.status === 401 ? 'unauthenticated' : access.code;
		return reject(access.status, { form, error: code });
	}
	return {
		user: access.user,
		session: access.session,
		db: getServerEnv(event.platform).db,
		now: Date.now()
	};
}

function field(data: FormData, name: string, max = 1024): string {
	const value = data.get(name);
	return typeof value === 'string' ? value.slice(0, max) : '';
}

function authFailure(form: FormId, result: AuthFailure, value?: string) {
	return reject(result.status >= 400 && result.status < 600 ? result.status : 400, {
		form,
		error: result.code,
		...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }),
		...(value === undefined ? {} : { value })
	});
}

export const actions: Actions = {
	nickname: async (event): Result => {
		const ctx = open(event, 'nickname', true);
		if (!('db' in ctx)) return ctx;
		const value = field(await event.request.formData(), 'nickname', 64);
		const result = await changeNickname(ctx.db, ctx.user.id, value, ctx.now);
		if (!result.ok) {
			return reject(result.error === 'unverified' ? 403 : 400, {
				form: 'nickname',
				error: result.error,
				value,
				...(result.retryAt === undefined ? {} : { retryAt: result.retryAt })
			});
		}
		return { form: 'nickname', ok: true, detail: result.kind };
	},

	bio: async (event): Result => {
		const ctx = open(event, 'bio', true);
		if (!('db' in ctx)) return ctx;
		// Read a bit past the limit so an over-long bio is reported, not silently cut.
		const value = field(await event.request.formData(), 'bio', BIO_MAX * 4);
		const result = await updateBio(ctx.db, ctx.user.id, value);
		if (!result.ok) return reject(400, { form: 'bio', error: result.error, value });
		return { form: 'bio', ok: true };
	},

	visibility: async (event): Result => {
		const ctx = open(event, 'visibility', true);
		if (!('db' in ctx)) return ctx;
		const data = await event.request.formData();
		// Checkboxes: present = public, absent = private (the default).
		await updateVisibility(ctx.db, ctx.user.id, {
			activity: field(data, 'activity_visibility', 16) === 'public' ? 'public' : 'private',
			library: field(data, 'library_visibility', 16) === 'public' ? 'public' : 'private'
		});
		return { form: 'visibility', ok: true };
	},

	password: async (event): Result => {
		const ctx = open(event, 'password');
		if (!('db' in ctx)) return ctx;
		const auth = event.locals.auth;
		if (!auth) return reject(503, { form: 'password', error: 'unavailable' });
		const data = await event.request.formData();
		const result = await changeAccountPassword(auth.api, event.request.headers, {
			currentPassword: field(data, 'currentPassword'),
			newPassword: field(data, 'newPassword'),
			confirmPassword: field(data, 'confirmPassword'),
			revokeOtherSessions: data.get('revokeOtherSessions') === 'on'
		});
		if (!result.ok) return authFailure('password', result);
		return { form: 'password', ok: true };
	},

	revokeSession: async (event): Result => {
		const ctx = open(event, 'sessions');
		if (!('db' in ctx)) return ctx;
		const sessionId = field(await event.request.formData(), 'sessionId', 256);
		const result = await revokeAccountSession(ctx.db, ctx.user.id, sessionId, ctx.session.id);
		if (result !== 'revoked') {
			return reject(result === 'current' ? 400 : 404, { form: 'sessions', error: result });
		}
		return { form: 'sessions', ok: true, detail: 'revoked' };
	},

	revokeOthers: async (event): Result => {
		const ctx = open(event, 'sessions');
		if (!('db' in ctx)) return ctx;
		const count = await revokeOtherAccountSessions(ctx.db, ctx.user.id, ctx.session.id);
		return { form: 'sessions', ok: true, detail: 'others', count };
	},

	email: async (event): Result => {
		const ctx = open(event, 'email');
		if (!('db' in ctx)) return ctx;
		const auth = event.locals.auth;
		if (!auth) return reject(503, { form: 'email', error: 'unavailable' });
		const data = await event.request.formData();
		const newEmail = field(data, 'newEmail', 320);
		const result = await requestEmailChange(auth.api, event.request.headers, {
			db: ctx.db,
			userId: ctx.user.id,
			currentEmail: ctx.user.email,
			session: ctx.session,
			newEmail,
			password: field(data, 'password'),
			turnstileToken: field(data, 'cf-turnstile-response', 4096),
			now: ctx.now
		});
		if (!result.ok) return authFailure('email', result, newEmail);
		return { form: 'email', ok: true };
	},

	close: async (event): Result => {
		const ctx = open(event, 'close');
		if (!('db' in ctx)) return ctx;
		const auth = event.locals.auth;
		if (!auth) return reject(503, { form: 'close', error: 'unavailable' });
		const data = await event.request.formData();
		const mode = field(data, 'mode', 32);
		if (!isDeletionMode(mode)) return reject(400, { form: 'close', error: 'invalid-mode' });
		const result = await requestAccountClosure(auth.api, event.request.headers, {
			db: ctx.db,
			userId: ctx.user.id,
			password: field(data, 'password'),
			mode,
			acknowledged: data.get('acknowledged') === 'on',
			now: ctx.now
		});
		if (!result.ok) return authFailure('close', result);
		return { form: 'close', ok: true };
	}
};
