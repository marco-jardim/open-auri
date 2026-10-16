import { requestResetFlow } from '#lib/components/auth/actions.server.ts';
import { AUTH_PAGE_HEADERS, finish, flowContext } from '#lib/components/auth/kit.server.ts';
import type { Actions, PageServerLoad } from './$types';

export const prerender = false;

// Also the target of the "secure my account" links in the security e-mails (server/auth README).
export const load: PageServerLoad = ({ setHeaders }) => {
	setHeaders(AUTH_PAGE_HEADERS);
	return {};
};

export const actions = {
	default: async (event) =>
		finish(await requestResetFlow(await event.request.formData(), flowContext(event)), event)
} satisfies Actions;
