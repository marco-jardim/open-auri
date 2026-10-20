import type { AccountSession } from '#lib/components/chrome/account.svelte.ts';
import { createSocialApi } from './api.ts';
import { createHiddenStore } from './hidden-store.ts';

/** Layout-owned preferences: a failed prerender session check must never become sign-out. */
export function createAccountHiddenStore(account: AccountSession) {
	const hidden = createHiddenStore(createSocialApi(), undefined, () => account.retry());
	$effect(() => {
		if (account.known) void hidden.setUser(account.current?.id ?? null);
		else if (account.failed) void hidden.setUser(undefined);
	});
	return hidden;
}
