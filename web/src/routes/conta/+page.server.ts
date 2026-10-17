// /conta: profile, security, e-mail, data and account closure (T3.7). Thin glue over
// #lib/server/account (tested in workerd). Rules:
//   - load: anonymous → 303 /entrar?next=/conta; banned → 403;
//   - every action re-checks access itself (actions do not run the load first) and acts only on
//     `locals.user.id`; profile actions also need a verified e-mail;
//   - CSRF: SvelteKit's origin check on form actions (kept on; never disabled for this route);
//   - sensitive actions: password change needs the current password, e-mail change a fresh
//     session or the password, closure the password plus the mailed confirmation link;
//   - two-step verification (FX3.4): start needs the password, confirm the first code, disable
//     the password plus a current code or a backup code (cancelling a pending setup: the password)
//     (admins with 2FA on also need the session's 2FA marker, enforced by the auth hooks). The
//     otpauth URI and the backup codes go out only in the `?/twoFactorStart` action result;
//     confirm and disable answer 303 /conta?2fa=…#duas-etapas (the session rotated);
//   - responses are `Cache-Control: private, no-store` (load, and the 2FA actions' own JSON
//     results when enhanced; set once per request, as SvelteKit refuses a second set).
import { error, fail, redirect, type ActionFailure, type RequestEvent } from '@sveltejs/kit';
import type { D1Database } from '@cloudflare/workers-types';
import type { FormFeedback, FormId } from '#lib/components/account/types.ts';
import {
	accountAccess,
	BIO_MAX,
	changeAccountPassword,
	changeNickname,
	confirmEnrolment,
	disableTwoFactor,
	getAccountProfile,
	isDeletionMode,
	listAccountSessions,
	listNicknameHolds,
	PASSWORD_MAX,
	PASSWORD_MIN,
	pendingEmailChange,
	policyBannerState,
	readDeletionRequest,
	readTwoFactorStatus,
	requestAccountClosure,
	requestEmailChange,
	revokeAccountSession,
	revokeOtherAccountSessions,
	signInRedirect,
	startEnrolment,
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

const NO_STORE = { 'cache-control': 'private, no-store' } as const;
/** Requests whose response already got NO_STORE (an action and the load share one request). */
const noStoreSent = new WeakSet<Request>();

function noStore(event: {
	request: Request;
	setHeaders: (headers: Record<string, string>) => void;
}): void {
	if (noStoreSent.has(event.request)) return;
	noStoreSent.add(event.request);
	event.setHeaders(NO_STORE);
}

export const load: PageServerLoad = async (event) => {
	const { locals, platform, url } = event;
	noStore(event);
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
	const [sessions, pendingEmail, holds, closure, policy, twoFactorStatus] = await Promise.all([
		listAccountSessions(db, user.id, session.id, now),
		pendingEmailChange(db, user.id, profile.email, now),
		listNicknameHolds(db, user.id, now),
		readDeletionRequest(db, user.id),
		policyBannerState(db, user.id),
		// From D1: `locals.user` predates a 2FA action run in this same request.
		readTwoFactorStatus(db, user.id)
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
		twoFactor: { status: twoFactorStatus, admin: user.role === 'admin' },
		fresh: isFreshSession(session, undefined, now),
		emailChanged: url.searchParams.get('email') === 'alterado',
		twoFactorNotice: twoFactorNotice(url),
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
	},

	/** Password → pending setup; the URI and backup codes go out in this result only. */
	twoFactorStart: async (event): Result => {
		noStore(event);
		const ctx = open(event, 'twoFactor');
		if (!('db' in ctx)) return ctx;
		const auth = event.locals.auth;
		if (!auth) return reject(503, { form: 'twoFactor', error: 'unavailable' });
		const password = field(await event.request.formData(), 'password');
		const result = await startEnrolment(auth, event.request.headers, password);
		if (!result.ok) return authFailure('twoFactor', result);
		return {
			form: 'twoFactor',
			ok: true,
			detail: 'started',
			enrolment: { totpURI: result.totpURI, backupCodes: result.backupCodes }
		};
	},

	/** First code from the app → 2FA on (the session rotates and gets the 2FA marker). */
	twoFactorConfirm: async (event): Result => {
		noStore(event);
		const ctx = open(event, 'twoFactor');
		if (!('db' in ctx)) return ctx;
		const auth = event.locals.auth;
		if (!auth) return reject(503, { form: 'twoFactor', error: 'unavailable' });
		const code = field(await event.request.formData(), 'code', 16);
		const result = await confirmEnrolment(auth, event.request.headers, code);
		if (!result.ok) return authFailure('twoFactor', result);
		redirect(303, twoFactorDone('enabled'));
	},

	/**
	 * Password + current code or backup code → 2FA off (one refusal for either factor wrong; for an
	 * admin the code also sets the session's 2FA marker), or password → pending setup cancelled.
	 */
	twoFactorDisable: async (event): Result => {
		noStore(event);
		const ctx = open(event, 'twoFactor');
		if (!('db' in ctx)) return ctx;
		const auth = event.locals.auth;
		if (!auth) return reject(503, { form: 'twoFactor', error: 'unavailable' });
		const data = await event.request.formData();
		const result = await disableTwoFactor(auth, event.request.headers, {
			db: ctx.db,
			userId: ctx.user.id,
			password: field(data, 'password'),
			code: field(data, 'code', 64)
		});
		if (!result.ok) return authFailure('twoFactor', result);
		redirect(303, twoFactorDone('disabled'));
	}
};

// Confirm and disable rotate the session: Better Auth deletes the old row and sends the new cookie
// on this response (sveltekitCookies → event.cookies, which SvelteKit also puts on redirects).
// Rendering /conta in the same request would still use the old `locals.session` and list the new
// session as another one, with a button that signs the user out (issue #20). So both answer 303
// and the next load reads the new cookie; the success notice rides on the query, like
// `?email=alterado`.
function twoFactorDone(detail: 'enabled' | 'disabled'): string {
	return `/conta?2fa=${detail === 'enabled' ? 'ativada' : 'desativada'}#duas-etapas`;
}

/** Success notice of the redirect above, as the 2FA form's feedback; null for anything else. */
function twoFactorNotice(url: URL): FormFeedback | null {
	const value = url.searchParams.get('2fa');
	const detail = value === 'ativada' ? 'enabled' : value === 'desativada' ? 'disabled' : null;
	return detail ? { form: 'twoFactor', ok: true, detail } : null;
}
