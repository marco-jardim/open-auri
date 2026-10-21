// Who is signed in, for the chrome. Dynamic pages get it from the root layout's server load;
// prerendered pages were built without a session (`sessionResolved: false`), so the client asks
// the auth API once per navigation to such a page. The last known value is shown meanwhile, so
// the header does not flicker between pages.
import { fetchAccount, type AccountSummary } from './account.ts';

export interface AccountInput {
	user: AccountSummary | null;
	resolved: boolean;
	/** Current pathname: a change on a prerendered page triggers a new probe. */
	path: string;
}

export type AccountProbe = (signal: AbortSignal) => Promise<AccountSummary | null | undefined>;

export class AccountSession {
	#known = $state<AccountSummary | null | undefined>(undefined);
	#failed = $state(false);
	#attempt = $state(0);
	readonly #input: () => AccountInput;
	/** Path the session was last resolved or probed for (plain field, not reactive). */
	lastPath = '';

	/** Call during component initialisation (it registers an effect). */
	constructor(
		input: () => AccountInput,
		probe: AccountProbe = (signal) => fetchAccount(undefined, signal)
	) {
		this.#input = input;
		$effect(() => {
			void this.#attempt;
			// Reading `path` makes every navigation re-run this effect.
			const { user, resolved, path } = input();
			this.lastPath = path;
			if (resolved) {
				this.#known = user;
				this.#failed = false;
				return;
			}
			const controller = new AbortController();
			probe(controller.signal).then(
				(summary) => {
					if (controller.signal.aborted) return;
					this.#failed = summary === undefined;
					if (summary !== undefined) this.#known = summary;
				},
				(error: unknown) => {
					if (!controller.signal.aborted) {
						console.warn('Account probe failed', error);
						this.#failed = true;
					}
				}
			);
			return () => controller.abort();
		});
	}

	/** Signed-in summary, or null (anonymous or not known yet). */
	get current(): AccountSummary | null {
		const input = this.#input();
		return input.resolved ? input.user : (this.#known ?? null);
	}

	/** False until a prerendered page's probe answered for the first time. */
	get known(): boolean {
		return this.#input().resolved || (!this.#failed && this.#known !== undefined);
	}

	get failed(): boolean {
		return !this.#input().resolved && this.#failed;
	}

	retry(): void {
		this.#attempt++;
	}
}
