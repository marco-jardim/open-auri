import { createSocialApi, createSocialSession, isSocialApiError } from '#lib/social/index.ts';
import type { SocialApi, SocialSession } from '#lib/social/index.ts';
import { m } from '#lib/paraglide/messages.js';

/** Page-owned, injectable client. Local editing never depends on this connection. */
export function createCurveSocial(
	api: SocialApi = createSocialApi(),
	session: SocialSession = createSocialSession()
) {
	let unavailable = $state(false);
	let abort: AbortController | null = null;
	/** Reads the session again while it is unknown (a failed probe never signs anybody out). */
	function refreshSession() {
		if (session.known || !abort) return;
		void session.refresh(abort.signal).catch((error: unknown) => {
			if (!(error instanceof DOMException && error.name === 'AbortError')) unavailable = true;
		});
	}
	return {
		api,
		session,
		get unavailable() {
			return unavailable;
		},
		retry() {
			unavailable = navigator.onLine === false;
			if (!unavailable) refreshSession();
		},
		mount() {
			const controller = new AbortController();
			abort = controller;
			const online = () => {
				unavailable = false;
				refreshSession();
			};
			const offline = () => {
				unavailable = true;
			};
			unavailable = navigator.onLine === false;
			refreshSession();
			window.addEventListener('online', online);
			window.addEventListener('offline', offline);
			return () => {
				controller.abort();
				if (abort === controller) abort = null;
				window.removeEventListener('online', online);
				window.removeEventListener('offline', offline);
			};
		},
		failure(error: unknown): string {
			if (isSocialApiError(error)) {
				if (
					error.unreachable ||
					error.code === 'INTERNAL' ||
					error.code === 'RATE_LIMIT_UNAVAILABLE'
				) {
					unavailable = true;
					return m.curve_social_offline();
				}
				if (error.code === 'AUTH_REQUIRED') {
					session.set(null);
					return m.curve_social_login();
				}
				if (error.code === 'EMAIL_NOT_VERIFIED') {
					const current = session.account;
					if (current) session.set({ ...current, emailVerified: false });
					return m.curve_social_verify();
				}
			}
			return m.curve_social_failed();
		}
	};
}

export type CurveSocial = ReturnType<typeof createCurveSocial>;
