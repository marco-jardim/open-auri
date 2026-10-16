import { resendFlow, RESEND_COOKIE } from '#lib/components/auth/actions.server.ts';
import {
	AUTH_PAGE_HEADERS,
	finish,
	flowContext,
	readResendCooldown
} from '#lib/components/auth/kit.server.ts';
import { safeNext } from '#lib/components/auth/next.ts';
import { verifyStatus } from '#lib/components/auth/status.ts';
import type { Actions, PageServerLoad } from './$types';

export const prerender = false;

// Landing page of the verification link (Better Auth redirects to `?verificado=1`, adding
// `error=…` for a bad or expired token) and of a finished sign-up (`?enviado=1`).
export const load: PageServerLoad = ({ url, cookies, setHeaders }) => {
	setHeaders(AUTH_PAGE_HEADERS);
	return {
		status: verifyStatus(url.searchParams),
		next: safeNext(url.searchParams.get('next')),
		availableAt: readResendCooldown({ cookies })
	};
};

export const actions = {
	default: async (event) =>
		finish(
			await resendFlow(await event.request.formData(), {
				...flowContext(event),
				cooldownCookie: event.cookies.get(RESEND_COOKIE)
			}),
			event
		)
} satisfies Actions;
