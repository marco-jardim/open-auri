import { resetPasswordFlow } from '#lib/components/auth/actions.server.ts';
import { AUTH_PAGE_HEADERS, finish, flowContext } from '#lib/components/auth/kit.server.ts';
import { resetToken } from '#lib/components/auth/status.ts';
import type { Actions, PageServerLoad } from './$types';

export const prerender = false;

// Target of the reset e-mail link (`?token=…`). The token is not checked on load (that would
// need an endpoint that does not consume it); a bad or used token fails on submit.
export const load: PageServerLoad = ({ url, setHeaders }) => {
	setHeaders({ ...AUTH_PAGE_HEADERS, 'referrer-policy': 'no-referrer' });
	return { token: resetToken(url.searchParams) };
};

export const actions = {
	default: async (event) =>
		finish(await resetPasswordFlow(await event.request.formData(), flowContext(event)), event)
} satisfies Actions;
