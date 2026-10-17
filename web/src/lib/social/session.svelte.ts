// Reactive social session (T4.12b): who may use the social features, derived from the chrome's
// account summary (`fetchAccount` / `AccountSummary`), never from a second session endpoint.
// No module singleton: create one per client (layout or page) and pass it down.
import {
	fetchAccount,
	signInHref,
	type AccountSummary,
	type FetchLike
} from '#lib/components/chrome/account.ts';

export interface SocialSessionOptions {
	/** Summary already known (layout data); `undefined` = unknown until `refresh()`. */
	initial?: AccountSummary | null;
	fetch?: FetchLike;
}

export function createSocialSession(options: SocialSessionOptions = {}) {
	const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
	let account = $state.raw<AccountSummary | null>(options.initial ?? null);
	let known = $state(options.initial !== undefined);
	let generation = 0;

	return {
		/** False until a summary was given or fetched. */
		get known() {
			return known;
		},
		get account() {
			return account;
		},
		get signedIn() {
			return account !== null;
		},
		/** Signed in with a verified e-mail (required by every social write but retraction). */
		get verified() {
			return account !== null && account.emailVerified;
		},
		/** The signed-in user's own account id (outbox owner); null when signed out. */
		get accountId() {
			return account?.id ?? null;
		},
		/** Public nickname; null when signed out or before the nickname is chosen. */
		get nickname() {
			return account?.username ?? null;
		},
		/** Replaces the summary (e.g. from layout data or after sign-out). */
		set(summary: AccountSummary | null) {
			generation += 1;
			account = summary;
			known = true;
		},
		/** Reads the session again; any failure reads as signed out (see `fetchAccount`). */
		async refresh(signal?: AbortSignal): Promise<AccountSummary | null> {
			const token = ++generation;
			const summary = await fetchAccount(fetcher, signal);
			if (token === generation) {
				account = summary;
				known = true;
			}
			return summary;
		}
	};
}

export type SocialSession = ReturnType<typeof createSocialSession>;

/** Sign-in link that returns to `currentPath` (same rule as the header's "Entrar"). */
export function requireLoginHref(currentPath: string): string {
	return signInHref(currentPath);
}
