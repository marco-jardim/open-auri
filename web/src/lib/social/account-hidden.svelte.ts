import type { AccountSession } from '#lib/components/chrome/account.svelte.ts';
import { createSocialApi } from './api.ts';
import { createHiddenStore } from './hidden-store.ts';

/**
 * Layout-owned preferences: a failed prerender session check must never become sign-out.
 *
 * - A probe that answers (signed in, another account or signed out) wins at once.
 * - A failed probe with no account known before reads as a visitor: the browser's own hidden
 *   list applies and community content stays usable offline or with the auth API down.
 * - A failed probe after an account was known keeps that account: no purge, no identity switch.
 */
export function createAccountHiddenStore(account: AccountSession) {
	const hidden = createHiddenStore(createSocialApi(), undefined, () => account.retry());
	$effect(() => {
		if (account.known) void hidden.setUser(account.current?.id ?? null);
		else if (account.failed && account.current === null) void hidden.setUser(null);
	});
	return hidden;
}
