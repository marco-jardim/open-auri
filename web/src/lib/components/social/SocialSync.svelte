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
	// own flush also drops other owners' events, so nothing is ever sent as someone else.
	import { untrack, type Snippet } from 'svelte';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { AccountSummary } from '#lib/components/chrome/account.ts';
	import {
		createSocialApi,
		createSocialOutbox,
		createSocialSession,
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
		children
	}: {
		app?: ClientApp | null;
		/** Account summary known by the layout; `undefined` = this component reads the session. */
		account?: AccountSummary | null;
		session?: SocialSession;
		api?: Pick<SocialApi, 'postActivityOutbox'>;
		/** Injected outbox (tests); default: one over `app.state.outbox`. */
		outbox?: Pick<SocialOutbox, 'flush' | 'pending' | 'purge'> | null;
		children?: Snippet<[SocialSyncStatus]>;
	} = $props();

	const session = untrack(() => givenSession ?? createSocialSession());
	const api = untrack(() => givenApi ?? createSocialApi());
	const ownsSession = untrack(() => givenSession === undefined);

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
	}

	async function purge(target: Pick<SocialOutbox, 'pending' | 'purge'>, keep: string | null) {
		await target.purge(keep);
		if (!destroyed) await countPending(target);
	}

	// Layout-provided summary: keep the session in step with it.
	$effect(() => {
		if (account !== undefined) session.set(account);
	});

	// Last signed-in account seen by this tab (`null` = none yet or signed out). A session read as
	// signed out before any account was seen (anonymous visit, or offline at load) purges nothing.
	let lastOwner: string | null = null;
	$effect(() => {
		const target = outbox;
		if (!target || !session.known) return;
		const owner = session.signedIn ? session.accountId : null;
		untrack(() => {
			const previous = lastOwner;
			if (owner !== null && owner !== previous) {
				// Signed in (first seen or switched): drop every other account's events.
				lastOwner = owner;
				void purge(target, owner);
			} else if (owner === null && previous !== null && online) {
				// Signed out: nothing stays queued for whoever signs in next. Offline, a failed session
				// probe also reads as signed out, so the queue is kept (the flush only ever sends the
				// events of the account signed in at that time).
				lastOwner = null;
				void purge(target, null);
			}
		});
	});

	// Mount, and every time the outbox becomes available or the session becomes signed-in + verified.
	$effect(() => {
		if (!outbox) return;
		void ready;
		untrack(() => {
			void flush();
		});
	});

	$effect(() => {
		const controller = new AbortController();
		if (ownsSession && untrack(() => account) === undefined) {
			void session.refresh(controller.signal);
		}
		const up = () => {
			online = true;
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
			void flush();
		};
		window.addEventListener('online', up);
		window.addEventListener('offline', down);
		document.addEventListener('visibilitychange', visible);
		return () => {
			destroyed = true;
			controller.abort();
			window.removeEventListener('online', up);
			window.removeEventListener('offline', down);
			document.removeEventListener('visibilitychange', visible);
		};
	});
</script>

{@render children?.({ online, pending, last })}
