import { redirect } from '@sveltejs/kit';
import { signInFlow, twoFactorFlow } from '#lib/components/auth/actions.server.ts';
import { AUTH_PAGE_HEADERS, finish, flowContext } from '#lib/components/auth/kit.server.ts';
import { afterSignIn, safeNext } from '#lib/components/auth/next.ts';
import { signInNotice } from '#lib/components/auth/status.ts';
import type { Actions, PageServerLoad } from './$types';

// Rendered per request (session, cookies, form actions); never prerendered or indexed.
export const prerender = false;

export const load: PageServerLoad = ({ url, locals, setHeaders }) => {
	setHeaders(AUTH_PAGE_HEADERS);
	const next = safeNext(url.searchParams.get('next'));
	if (locals.user) redirect(303, afterSignIn(next));
	return { next, notice: signInNotice(url.searchParams) };
};

export const actions = {
	signIn: async (event) =>
		finish(await signInFlow(await event.request.formData(), flowContext(event)), event),
	twoFactor: async (event) =>
		finish(await twoFactorFlow(await event.request.formData(), flowContext(event)), event)
} satisfies Actions;
