import { redirect } from '@sveltejs/kit';
import { signUpFlow } from '#lib/components/auth/actions.server.ts';
import {
	AUTH_PAGE_HEADERS,
	finish,
	flowContext,
	signupEnabled
} from '#lib/components/auth/kit.server.ts';
import { afterSignIn, safeNext } from '#lib/components/auth/next.ts';
import type { Actions, PageServerLoad } from './$types';

export const prerender = false;

// SIGNUP_ENABLED is read per request from the Worker env: with it off the page explains that
// sign-up opens soon and renders no form; the action and the API both refuse with SIGNUP_DISABLED.
export const load: PageServerLoad = ({ url, locals, platform, setHeaders }) => {
	setHeaders(AUTH_PAGE_HEADERS);
	const next = safeNext(url.searchParams.get('next'));
	if (locals.user) redirect(303, afterSignIn(next));
	return { next, signupEnabled: signupEnabled({ platform }) };
};

export const actions = {
	default: async (event) =>
		finish(
			await signUpFlow(await event.request.formData(), {
				...flowContext(event),
				signupEnabled: signupEnabled(event)
			}),
			event
		)
} satisfies Actions;
