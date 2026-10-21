<script lang="ts" module>
	import type { FlushReport } from '#lib/social/index.ts';

	/** What the optional indicator snippet receives. */
	export interface SocialSyncStatus {
		online: boolean;
		/** Activity events still queued (known after the first flush). */
		pending: number;
		last: FlushReport | null;
	}
</script>

<script lang="ts">
	// Headless social sync (T4.14): flushes the activity outbox on mount, on the window `online`
	// event, when the tab becomes visible again and when the session turns signed-in + verified.
	// Mount once in the root layout. No UI besides the optional `children` indicator snippet.
	// FX4.2: queued activity belongs to the account that acted. When the signed-in account goes
	// away (sign-out) or changes (switch), the events it does not own are purged here; the outbox's
	// own flush sends only the current account's events and leaves other owners' ones queued for
	// that purge (#25), so nothing is ever sent as someone else.
	// FX4.10: a session read as signed out is confirmed with a probe that tells a definitive
	// "nobody is signed in" from a failure (`probeAccount`); only the former purges (a failed probe
	// keeps the queue and is confirmed again when the tab comes back online or visible). The
	// community origins (`#lib/social/origins.ts`) are bound to the same account and purged with
	// the outbox. A flush answered `actor-mismatch` (the cookie belongs to another account now)
	// re-reads the session; an account switch flushes for the new account.
	import { untrack, type Snippet } from 'svelte';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import {
		probeAccount,
		type AccountProbeResult,
		type AccountSummary
	} from '#lib/components/chrome/account.ts';
	import {
		createSocialApi,
		createSocialOutbox,
		createSocialSession,
		purgeOrigins,
		setOriginsActor,
		type OutboxStore,
		type SocialApi,
		type SocialOutbox,
		type SocialSession
	} from '#lib/social/index.ts';

	let {
		app = null,
		account,
		session: givenSession,
		api: givenApi,
		outbox: givenOutbox,
		probe = (signal: AbortSignal) => probeAccount(undefined, signal),
		children
	}: {
		app?: ClientApp | null;
		/** Account summary known by the layout; `undefined` = this component reads the session. */
		account?: AccountSummary | null;
		session?: SocialSession;
		api?: Pick<SocialApi, 'postActivityOutbox'>;
		/** Injected outbox (tests); default: one over `app.state.outbox`. */
		outbox?: Pick<SocialOutbox, 'flush' | 'pending' | 'purge'> | null;
		/** Session probe that tells signed out from a failure; default `probeAccount`. */
		probe?: (signal: AbortSignal) => Promise<AccountProbeResult>;
		children?: Snippet<[SocialSyncStatus]>;
	} = $props();

	const session = untrack(() => givenSession ?? createSocialSession());
	const api = untrack(() => givenApi ?? createSocialApi());
	const ownsSession = untrack(() => givenSession === undefined);
	const controller = new AbortController();

	let cache: { store: OutboxStore; outbox: SocialOutbox } | null = null;
	const outbox = $derived.by(() => {
		if (givenOutbox !== undefined) return givenOutbox;
		const store = app?.state.outbox;
		if (!store) return null;
		if (cache?.store !== store) cache = { store, outbox: createSocialOutbox({ store, session }) };
		return cache.outbox;
	});
	const ready = $derived(session.signedIn && session.verified);

	let online = $state(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
	let pending = $state(0);
	let last = $state.raw<FlushReport | null>(null);
	let destroyed = false;

	async function countPending(target: Pick<SocialOutbox, 'pending'>) {
		try {
			pending = (await target.pending()).length;
		} catch (error) {
			console.warn(JSON.stringify({ event: 'social.sync.pending', error: (error as Error).name }));
		}
	}

	async function flush() {
		const target = outbox;
		if (!target || destroyed) return;
		const report = await target.flush(api);
		if (destroyed) return;
		last = report;
		await countPending(target);
		if (report.status === 'actor-mismatch') void recheck();
	}

	async function purge(target: Pick<SocialOutbox, 'pending' | 'purge'>, keep: string | null) {
		await target.purge(keep);
		if (!destroyed) await countPending(target);
	}

	// Outbox purge asked for before the outbox existed (`undefined` = none).
	let deferredPurge: string | null | undefined;
	function purgeQueue(keep: string | null) {
		const target = untrack(() => outbox);
		if (target) void purge(target, keep);
		else deferredPurge = keep;
	}
	$effect(() => {
		const target = outbox;
		if (!target) return;
		untrack(() => {
			if (deferredPurge === undefined) return;
			const keep = deferredPurge;
			deferredPurge = undefined;
			void purge(target, keep);
		});
	});

	/** Asks the auth API who is signed in; null when the probe threw (treated as a failure). */
	async function ask(): Promise<AccountProbeResult | null> {
		try {
			return await probe(controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) {
				console.warn(JSON.stringify({ event: 'social.sync.probe', error: (error as Error).name }));
			}
			return null;
		}
	}

	/** Purges everything local to the departed account (definitive sign-out only). */
	function purgeAll() {
		purgeOrigins(null);
		purgeQueue(null);
	}

	// Last signed-in account seen by this tab (`null` = none yet or signed out). A session read as
	// signed out before any account was seen (anonymous visit, or offline at load) purges nothing.
	let lastOwner: string | null = null;
	// A signed-out read not confirmed yet (offline or the probe failed): retried on online/visible.
	let unconfirmed = false;

	/** Purges only when the auth API answers that nobody is signed in (FX4.10, R2-3). */
	async function confirmSignOut() {
		if (!online) {
			unconfirmed = true;
			return;
		}
		unconfirmed = false;
		const result = await ask();
		if (destroyed || lastOwner !== null || session.signedIn) return;
		if (result?.status === 'signed-out') purgeAll();
		// The signed-out read was wrong (an AUTH_REQUIRED answer or layout data older than a sign-in
		// in another tab; a failed `session.refresh` leaves the session unknown and never reads as
		// signed out): nothing is purged and the session follows the probe at once, so the outbox
		// flushes again instead of refusing events until the tab next turns visible (#26).
		else if (result?.status === 'signed-in') session.set(result.account);
		else unconfirmed = true;
	}

	/** After an `actor-mismatch` flush: reads the session again and follows the server's answer. */
	async function recheck() {
		const result = await ask();
		if (destroyed || result === null || result.status === 'error') return;
		if (result.status === 'signed-in') {
			session.set(result.account);
		} else {
			// Definitive sign-out: purge now, then the session effect has nothing left to confirm.
			lastOwner = null;
			unconfirmed = false;
			setOriginsActor(null);
			purgeAll();
			session.set(null);
		}
	}

	// Layout-provided summary: keep the session in step with it.
	$effect(() => {
		if (account !== undefined) session.set(account);
	});

	$effect(() => {
		if (!session.known) return;
		const owner = session.signedIn ? session.accountId : null;
		untrack(() => {
			const previous = lastOwner;
			if (owner !== null && owner !== previous) {
				// Signed in (first seen or switched): drop every other account's events and origins.
				lastOwner = owner;
				unconfirmed = false;
				setOriginsActor(owner);
				purgeOrigins(owner);
				purgeQueue(owner);
			} else if (owner === null && previous !== null) {
				// Read as signed out: stop using the account's origins now, but purge only once the
				// auth API confirms nobody is signed in (the read may be stale; a failed probe never
				// gets here, it leaves the session unknown; the flush only ever sends the events of the
				// account signed in at that time).
				lastOwner = null;
				setOriginsActor(null);
				void confirmSignOut();
			}
		});
	});

	// Mount, and every time the outbox becomes available, the session becomes signed-in + verified
	// or the signed-in account changes (switch between two verified accounts).
	$effect(() => {
		if (!outbox) return;
		void ready;
		void session.accountId;
		untrack(() => {
			void flush();
		});
	});

	$effect(() => {
		if (ownsSession && untrack(() => account) === undefined) {
			void session.refresh(controller.signal);
		}
		const retryConfirm = () => {
			if (unconfirmed && lastOwner === null && !session.signedIn) void confirmSignOut();
		};
		const up = () => {
			online = true;
			retryConfirm();
			void flush();
		};
		const down = () => {
			online = false;
		};
		const visible = () => {
			if (document.visibilityState !== 'visible') return;
			if (ownsSession && account === undefined) {
				// Sign-in elsewhere: the session effect above flushes when it turns verified.
				void session.refresh(controller.signal);
			}
			retryConfirm();
			void flush();
		};
		window.addEventListener('online', up);
		window.addEventListener('offline', down);
		document.addEventListener('visibilitychange', visible);
		return () => {
			destroyed = true;
			controller.abort();
			setOriginsActor(null);
			window.removeEventListener('online', up);
			window.removeEventListener('offline', down);
			document.removeEventListener('visibilitychange', visible);
		};
	});
</script>

{@render children?.({ online, pending, last })}
