<script lang="ts">
	// "Minha biblioteca" (T4.14): the account shelves (creations with visibility controls,
	// favorites, installed, packs), the audience and share funnel of each creation, and the
	// explicit merge of the local library after sign-in. Signed out it is a single sign-in line;
	// offline it says so and the local library of the page keeps working. Never writes to a cable:
	// "Abrir" leads to /c/[id], where installing goes through `app.requestWrite`.
	import { tick, untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getHiddenStore } from '#lib/social/hidden-context.ts';
	import { authorHiddenId, isHidden } from '#lib/social/hidden.ts';
	import {
		isSocialApiError,
		rememberOrigin,
		requireLoginHref,
		type LibraryItem,
		type SocialApi,
		type SocialSession
	} from '#lib/social/index.ts';
	import {
		checkEnvelope,
		serverGateMessages,
		textIssueText,
		versionEnvelope,
		type TextIssue
	} from '#lib/components/pages/curva/social.ts';
	import CreationInsights from './CreationInsights.svelte';
	import MergeBanner from './MergeBanner.svelte';
	import YoloBadge from '#lib/components/yolo/YoloBadge.svelte';
	import YoloPublishAck from '#lib/components/yolo/YoloPublishAck.svelte';
	import {
		ackWaived,
		curveBadge,
		needsYoloAck,
		waivedLabels,
		yoloPublishBlock,
		yoloPublishText
	} from '#lib/components/yolo/yolo-curve.ts';
	import {
		accountKey,
		defaultStorage,
		errorKind,
		isAbort,
		type ErrorKind,
		type KeyValueStorage,
		type LocalLibraryItem
	} from './social.ts';

	type Shelf = 'created' | 'favorites' | 'installed';
	type Tab = Shelf | 'packs';
	type Visibility = LibraryItem['visibility'];
	interface PackRow {
		id: string;
		name: string;
		description: string;
		visibility: Visibility;
		moderation: LibraryItem['moderation'];
	}
	interface ShelfState<T> {
		items: T[];
		cursor: string | null;
		status: 'idle' | 'loading' | 'ready' | 'error';
		error: ErrorKind | null;
	}

	let {
		session,
		api,
		localItems = [],
		origin,
		locale,
		currentPath = '/biblioteca',
		storage = defaultStorage(),
		remember = rememberOrigin
	}: {
		session: Pick<SocialSession, 'signedIn' | 'verified' | 'nickname' | 'account' | 'known'>;
		/** Without `appendVersion`, own creations are not offered "Editar nome e descrição". */
		api: Pick<
			SocialApi,
			| 'myLibrary'
			| 'myPacks'
			| 'myShares'
			| 'setVisibility'
			| 'retractLineage'
			| 'restoreLineage'
			| 'mergeLibrary'
			| 'audience'
			| 'shareStats'
			| 'createShare'
		> &
			Partial<Pick<SocialApi, 'appendVersion'>>;
		localItems?: readonly LocalLibraryItem[];
		origin: string;
		locale: string;
		currentPath?: string;
		storage?: KeyValueStorage | null;
		remember?: typeof rememberOrigin;
	} = $props();
	const id = $props.id();
	const hidden = getHiddenStore();

	function empty<T>(): ShelfState<T> {
		return { items: [], cursor: null, status: 'idle', error: null };
	}
	let shelves = $state.raw<Record<Shelf, ShelfState<LibraryItem>>>({
		created: empty(),
		favorites: empty(),
		installed: empty()
	});
	let packs = $state.raw<ShelfState<PackRow>>(empty());
	let tab = $state<Tab>('created');
	let visibilityFilter = $state<Visibility | 'all'>('all');
	let open = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let notice = $state('');
	let reload = $state(0);
	let online = $state(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
	/** The own creation whose name and description are being edited (one at a time). */
	let editing = $state<string | null>(null);
	let editName = $state('');
	let editDescription = $state('');
	let editIssues = $state.raw<TextIssue[]>([]);
	let editMessage = $state('');
	let editGate = $state.raw<string[]>([]);
	let editRecovery: string | null = null;
	let editNameField = $state<HTMLInputElement | null>(null);
	let editDescriptionField = $state<HTMLTextAreaElement | null>(null);
	const editNameIssues = $derived(editIssues.filter((issue) => issue.field === 'name'));
	const editDescriptionIssues = $derived(
		editIssues.filter((issue) => issue.field === 'description')
	);
	const editOtherIssues = $derived(editIssues.filter((issue) => issue.field === null));

	const shelfTab = $derived<Shelf | null>(tab === 'packs' ? null : tab);
	const signedIn = $derived(session.signedIn);
	const verified = $derived(session.verified);
	const account = $derived(accountKey(session.account));
	const offline = $derived(
		!online ||
			[shelves.created, shelves.favorites, shelves.installed, packs].some(
				(shelf) => shelf.error === 'offline'
			)
	);
	const tabs = $derived([
		{ key: 'created', label: m.biblioteca_social_shelf_created() },
		{ key: 'favorites', label: m.biblioteca_social_shelf_favorites() },
		{ key: 'installed', label: m.biblioteca_social_shelf_installed() },
		{ key: 'packs', label: m.biblioteca_social_shelf_packs() }
	] as const);
	const visibilityLabels = $derived<Record<Visibility, string>>({
		public: m.biblioteca_social_visibility_public(),
		unlisted: m.biblioteca_social_visibility_unlisted(),
		private: m.biblioteca_social_visibility_private()
	});

	$effect(() => {
		const up = () => {
			online = true;
			// Retry what failed offline once the network is back (never in a loop).
			reload += 1;
		};
		const down = () => {
			online = false;
		};
		window.addEventListener('online', up);
		window.addEventListener('offline', down);
		return () => {
			window.removeEventListener('online', up);
			window.removeEventListener('offline', down);
		};
	});

	function setShelf(shelf: Shelf, next: ShelfState<LibraryItem>) {
		shelves = { ...shelves, [shelf]: next };
	}

	function track(items: readonly LibraryItem[]) {
		for (const item of items) {
			void remember({ s1: item.curve.s1, lineageId: item.id, versionId: item.head.id });
		}
	}

	async function loadShelf(shelf: Shelf, signal: AbortSignal, cursor: string | null = null) {
		const owner = account;
		const previous = shelves[shelf];
		setShelf(shelf, { ...previous, status: 'loading', error: null });
		try {
			const page = await api.myLibrary(
				{
					shelf,
					...(shelf === 'created' && visibilityFilter !== 'all'
						? { visibility: visibilityFilter }
						: {}),
					cursor
				},
				{ signal }
			);
			// A late answer for a cancelled load or a previous account is not this shelf's.
			if (signal.aborted || owner !== account) return;
			track(page.items);
			setShelf(shelf, {
				items: cursor === null ? page.items : [...shelves[shelf].items, ...page.items],
				cursor: page.nextCursor,
				status: 'ready',
				error: null
			});
		} catch (error) {
			if (signal.aborted || owner !== account || isAbort(error)) return;
			setShelf(shelf, { ...shelves[shelf], status: 'error', error: errorKind(error) });
		} finally {
			if (shelf === 'created' && !signal.aborted && owner === account && editRecovery !== null) {
				const lineageId = editRecovery;
				editRecovery = null;
				await focusEditRow(lineageId, owner, signal);
			}
		}
	}

	async function loadPacks(signal: AbortSignal, cursor: string | null = null) {
		const owner = account;
		packs = { ...packs, status: 'loading', error: null };
		try {
			// All own packs, any visibility (`GET /me/packs`).
			const page = await api.myPacks({ cursor }, { signal });
			if (signal.aborted || owner !== account) return;
			const rows = page.items.map((pack) => ({
				id: pack.id,
				name: pack.name,
				description: pack.description,
				visibility: pack.visibility,
				moderation: pack.moderation
			}));
			packs = {
				items: cursor === null ? rows : [...packs.items, ...rows],
				cursor: page.nextCursor,
				status: 'ready',
				error: null
			};
		} catch (error) {
			if (signal.aborted || owner !== account || isAbort(error)) return;
			packs = { ...packs, status: 'error', error: errorKind(error) };
		}
	}

	// Rows belong to one account: another account (even straight from a signed-in one) starts
	// from empty shelves, and the loaders below reload for it.
	let rowsOf: string | null = null;
	$effect(() => {
		const key = account;
		if (rowsOf !== null && rowsOf !== key) {
			shelves = { created: empty(), favorites: empty(), installed: empty() };
			packs = empty();
			editing = null;
			editRecovery = null;
			busy = null;
			notice = '';
		}
		rowsOf = key;
	});

	// The loaders read and write `shelves`/`packs`: run them untracked so only the listed inputs
	// (session, account, filter, reload) re-run the effects.
	$effect(() => {
		void reload;
		void account;
		if (!signedIn) return;
		const controller = new AbortController();
		untrack(() => {
			void loadShelf('favorites', controller.signal);
			void loadShelf('installed', controller.signal);
			void loadPacks(controller.signal);
		});
		return () => controller.abort();
	});

	$effect(() => {
		void reload;
		void visibilityFilter;
		void account;
		if (!signedIn) return;
		const controller = new AbortController();
		untrack(() => {
			void loadShelf('created', controller.signal);
		});
		return () => controller.abort();
	});

	function more(target: Tab) {
		const controller = new AbortController();
		if (target === 'packs') void loadPacks(controller.signal, packs.cursor);
		else void loadShelf(target, controller.signal, shelves[target].cursor);
	}

	function errorText(kind: ErrorKind): string {
		switch (kind) {
			case 'offline':
				return m.biblioteca_social_offline();
			case 'auth':
				return m.biblioteca_social_error_auth();
			case 'verify':
				return m.biblioteca_social_verify();
			case 'gate':
				return m.biblioteca_social_error_gate();
			case 'rate':
				return m.biblioteca_social_error_rate();
			case 'missing':
				return m.biblioteca_social_error_missing();
			default:
				return m.biblioteca_social_error_generic();
		}
	}

	function patch(
		lineageId: string,
		state: Pick<LibraryItem, 'status' | 'visibility' | 'moderation'>
	) {
		const update = (item: LibraryItem) =>
			item.id === lineageId
				? {
						...item,
						status: state.status,
						visibility: state.visibility,
						moderation: state.moderation
					}
				: item;
		shelves = {
			created: { ...shelves.created, items: shelves.created.items.map(update) },
			favorites: { ...shelves.favorites, items: shelves.favorites.items.map(update) },
			installed: { ...shelves.installed, items: shelves.installed.items.map(update) }
		};
	}

	/**
	 * The YOLO acknowledgement step of one row: opening a YOLO head to others (visibility unlisted
	 * or public, or restoring a lineage that is not private) needs it; null when none is shown.
	 */
	let ackFor = $state.raw<{
		id: string;
		action: 'visibility' | 'restore';
		value?: Visibility;
		waived: string[];
	} | null>(null);

	/** Leaves the step: the visibility picker shows the lineage's real visibility again. */
	function cancelAck(item: LibraryItem) {
		ackFor = null;
		const select = document.getElementById(`${id}-visibility-${item.id}`);
		if (select instanceof HTMLSelectElement) select.value = item.visibility;
	}

	/** Whether `action` would show the YOLO head of `item` to others. */
	function opensYolo(item: LibraryItem, action: 'visibility' | 'restore', value?: Visibility) {
		const target = action === 'visibility' ? value : item.visibility;
		return target !== undefined && needsYoloAck(item.curve.yolo === true, target);
	}

	/** `acknowledged`: the owner went through the YOLO step (sends `acknowledge: 'yolo'`). */
	async function act(
		item: LibraryItem,
		action: 'visibility' | 'retract' | 'restore',
		value?: Visibility,
		acknowledged = false
	) {
		if (busy) return;
		if (action !== 'retract' && !acknowledged && opensYolo(item, action, value)) {
			ackFor = { id: item.id, action, value, waived: waivedLabels(item.curve.waived) };
			notice = '';
			return;
		}
		busy = item.id;
		notice = '';
		try {
			if (action === 'visibility' && value) {
				patch(
					item.id,
					acknowledged
						? await api.setVisibility(item.id, value, { acknowledge: 'yolo' })
						: await api.setVisibility(item.id, value)
				);
				notice = m.biblioteca_social_saved_visibility();
			} else if (action === 'retract') {
				patch(item.id, await api.retractLineage(item.id));
				if (editing === item.id) editing = null;
				notice = m.biblioteca_social_retracted_done();
			} else if (action === 'restore') {
				patch(
					item.id,
					acknowledged
						? await api.restoreLineage(item.id, { acknowledge: 'yolo' })
						: await api.restoreLineage(item.id)
				);
				notice = m.biblioteca_social_restored_done();
			}
			if (ackFor?.id === item.id) ackFor = null;
		} catch (error) {
			const block = yoloPublishBlock(error);
			if (block === 'ack' && action !== 'retract') {
				// The server asks for the acknowledgement (409 YOLO_ACK_REQUIRED): show the step.
				ackFor = { id: item.id, action, value, waived: waivedLabels(ackWaived(error)) };
			} else if (block === 'off' || block === 'account-age') {
				notice = yoloPublishText(block);
			} else {
				notice = errorText(errorKind(error));
			}
		} finally {
			busy = null;
		}
	}

	// ---- Name and description of an own creation -------------------------------------------
	// Text lives on the (append-only) version: editing appends a version with the head's exact
	// curve, license, language and recipe, through the gate, with the head as its parent.

	/** Only active, unmoderated own creations can get a new version. */
	function editable(item: LibraryItem): boolean {
		return (
			item.own &&
			item.status === 'active' &&
			item.moderation === 'visible' &&
			api.appendVersion !== undefined
		);
	}

	function resetEditFeedback() {
		editIssues = [];
		editMessage = '';
		editGate = [];
	}

	async function openEdit(item: LibraryItem) {
		if (busy || !editable(item)) return;
		editing = item.id;
		editName = item.head.name;
		editDescription = item.head.description;
		resetEditFeedback();
		await tick();
		editNameField?.focus();
	}

	function closeEdit(lineageId: string) {
		editAck = null;
		if (editing !== lineageId) return;
		editing = null;
		resetEditFeedback();
		void tick().then(() => document.getElementById(`${id}-edit-${lineageId}`)?.focus());
	}

	function escapeEdit(event: KeyboardEvent, lineageId: string) {
		if (event.key !== 'Escape' || busy !== null) return;
		event.preventDefault();
		closeEdit(lineageId);
	}

	function renamed(lineageId: string, head: LibraryItem['head']) {
		const update = (item: LibraryItem) => (item.id === lineageId ? { ...item, head } : item);
		shelves = {
			created: { ...shelves.created, items: shelves.created.items.map(update) },
			favorites: { ...shelves.favorites, items: shelves.favorites.items.map(update) },
			installed: { ...shelves.installed, items: shelves.installed.items.map(update) }
		};
	}

	async function focusEditRow(lineageId: string, owner: string, signal?: AbortSignal) {
		await tick();
		if (signal?.aborted || owner !== account) return;
		(
			document.getElementById(`${id}-row-${lineageId}`) ??
			document.getElementById(`${id}-shelf-title`)
		)?.focus();
	}

	function unavailableEdit(message: string) {
		editRecovery = editing;
		editing = null;
		resetEditFeedback();
		notice = message;
		reload += 1;
		// Keep focus out of the removed form while loading, then restore it against the fresh rows.
		if (editRecovery !== null) void focusEditRow(editRecovery, account);
	}

	function editFailed(error: unknown) {
		if (isSocialApiError(error) && !error.unreachable) {
			if (error.code === 'HEAD_MOVED') {
				// Edited elsewhere: reload the rows so the next save starts from the current head.
				editMessage = m.cvedit_head_moved_reload();
				reload += 1;
				return;
			}
			if (error.code === 'CONFLICT') {
				unavailableEdit(m.cvedit_edit_unavailable());
				return;
			}
			if (error.code === 'GATE_REJECTED') {
				editMessage = errorText('gate');
				editGate = serverGateMessages(error.details);
				return;
			}
			if (error.code === 'INVALID_CURVE') {
				editMessage = m.curva_social_invalid();
				return;
			}
		}
		const kind = errorKind(error);
		if (kind === 'missing') unavailableEdit(errorText(kind));
		else editMessage = errorText(kind);
	}

	/** The renamed version of a YOLO head in a lineage others see needs the YOLO step too. */
	let editAck = $state<string | null>(null);

	async function saveEdit(item: LibraryItem, acknowledged = false) {
		const append = api.appendVersion;
		if (busy || editing !== item.id || !append || !editable(item)) return;
		resetEditFeedback();
		const checked = checkEnvelope(
			versionEnvelope(
				{
					s1: item.curve.s1,
					license: item.head.license,
					lang: item.head.lang,
					recipe: item.head.recipe,
					// A rename keeps the version's filter labels.
					labels: item.head.labels ?? null
				},
				{ name: editName, description: editDescription }
			)
		);
		if (!checked.ok) {
			editIssues = checked.issues;
			editMessage = m.cvedit_invalid();
			if (checked.issues.some((issue) => issue.field === 'name')) editNameField?.focus();
			else if (checked.issues.some((issue) => issue.field === 'description')) {
				editDescriptionField?.focus();
			}
			return;
		}
		if (checked.name === item.head.name && checked.description === item.head.description) {
			closeEdit(item.id);
			notice = m.cvedit_edit_unchanged();
			return;
		}
		if (!acknowledged && opensYolo(item, 'restore')) {
			editAck = item.id;
			return;
		}
		const owner = account;
		busy = item.id;
		notice = '';
		try {
			const result = await append(item.id, {
				parentVersionId: item.head.id,
				envelope: checked.envelope,
				...(acknowledged ? { acknowledge: 'yolo' as const } : {})
			});
			editAck = null;
			if (owner !== account) return;
			renamed(item.id, {
				...item.head,
				id: result.versionId,
				parentId: item.head.id,
				name: checked.name,
				description: checked.description,
				createdAt: Date.now()
			});
			void remember({ s1: item.curve.s1, lineageId: item.id, versionId: result.versionId });
			closeEdit(item.id);
			notice = m.cvedit_edit_done({ name: checked.name });
		} catch (error) {
			if (owner === account) {
				const block = yoloPublishBlock(error);
				if (block === 'ack') editAck = item.id;
				else if (block !== null) editMessage = yoloPublishText(block);
				else if (!isAbort(error)) editFailed(error);
			}
		} finally {
			if (owner === account) busy = null;
		}
	}

	function current(tabKey: Tab): ShelfState<LibraryItem | PackRow> {
		return tabKey === 'packs' ? packs : shelves[tabKey];
	}

	function emptyText(tabKey: Tab): string {
		switch (tabKey) {
			case 'created':
				return m.biblioteca_social_empty_created();
			case 'favorites':
				return m.biblioteca_social_empty_favorites();
			case 'installed':
				return m.biblioteca_social_empty_installed();
			default:
				return m.biblioteca_social_empty_packs_own();
		}
	}
</script>

<section class="mine" aria-labelledby="{id}-title">
	<div class="mine-head">
		<h2 id="{id}-title">{m.biblioteca_social_title()}</h2>
		{#if signedIn}<p>{m.biblioteca_social_note()}</p>{/if}
	</div>
	{#if !session.known}
		<p aria-busy="true">{m.biblioteca_social_loading()}</p>
	{:else if !signedIn}
		<p class="invite">
			{m.biblioteca_social_signin()}
			<a href={requireLoginHref(currentPath)}>{m.biblioteca_social_signin_link()}</a>
		</p>
	{:else}
		{#if offline}<p class="offline" role="status">{m.biblioteca_social_offline()}</p>{/if}
		{#if !offline}
			<MergeBanner
				items={localItems}
				{account}
				{verified}
				{api}
				{storage}
				{locale}
				onMerged={() => {
					reload += 1;
				}}
			/>
		{/if}
		<div class="tabs" role="tablist" aria-label={m.biblioteca_social_shelves()}>
			{#each tabs as entry (entry.key)}
				<button
					type="button"
					class="tab"
					role="tab"
					id="{id}-tab-{entry.key}"
					aria-controls="{id}-panel"
					aria-selected={tab === entry.key}
					tabindex={tab === entry.key ? 0 : -1}
					onclick={() => {
						tab = entry.key;
					}}
					onkeydown={(event) => {
						if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
						const index = tabs.findIndex((other) => other.key === tab);
						const step = event.key === 'ArrowRight' ? 1 : tabs.length - 1;
						tab = tabs[(index + step) % tabs.length]?.key ?? 'created';
						document.getElementById(`${id}-tab-${tab}`)?.focus();
					}}
					>{entry.label}
					<span class="badge">{current(entry.key).items.length}</span></button
				>
			{/each}
		</div>
		<div class="panel" role="tabpanel" id="{id}-panel" aria-labelledby="{id}-tab-{tab}">
			<h3 class="shelf-title" id="{id}-shelf-title" tabindex="-1">
				{tabs.find((entry) => entry.key === tab)?.label}
			</h3>
			{#if tab === 'created'}
				<label class="filter"
					>{m.biblioteca_social_filter_visibility()}
					<select bind:value={visibilityFilter}>
						<option value="all">{m.biblioteca_social_filter_all()}</option>
						<option value="public">{visibilityLabels.public}</option>
						<option value="unlisted">{visibilityLabels.unlisted}</option>
						<option value="private">{visibilityLabels.private}</option>
					</select></label
				>
				{#if !verified}<p class="hint">{m.biblioteca_social_verify()}</p>{/if}
			{/if}
			{#if current(tab).status === 'error' && current(tab).error !== 'offline'}
				<p role="alert">{errorText(current(tab).error ?? 'generic')}</p>
				<button
					type="button"
					onclick={() => {
						reload += 1;
					}}>{m.biblioteca_social_retry()}</button
				>
			{:else if current(tab).status === 'error'}
				<!-- The offline notice above stands in for the list: never an empty state. -->
			{:else if current(tab).status !== 'ready' && current(tab).items.length === 0}
				<p aria-busy="true">{m.biblioteca_social_loading()}</p>
			{:else if current(tab).items.length === 0}
				<p class="empty">{emptyText(tab)}</p>
			{:else if tab === 'packs'}
				<ul class="rows">
					{#each packs.items as pack (pack.id)}
						<li class="row">
							<div class="row-head">
								<strong>{pack.name}</strong>
								<span class="badge vis-{pack.visibility}">{visibilityLabels[pack.visibility]}</span>
								{#if pack.moderation !== 'visible'}<span class="badge warn"
										>{m.biblioteca_social_moderated()}</span
									>{/if}
							</div>
							{#if pack.description}<span class="desc">{pack.description}</span>{/if}
						</li>
					{/each}
				</ul>
			{:else if shelfTab}
				{@const shelf = shelfTab}
				<ul class="rows">
					{#each ($hidden.ready ? shelves[shelf].items.filter((item) => !isHidden($hidden, item.id, authorHiddenId(item.author))) : []) as item (item.id)}
						<li class="row" id="{id}-row-{item.id}" tabindex="-1">
							<div class="row-head">
								<strong>{item.head.name}</strong>
								{#if shelf === 'created'}<span class="badge vis-{item.visibility}"
										>{visibilityLabels[item.visibility]}</span
									>{/if}
								{#if item.status === 'retracted'}<span class="badge warn"
										>{m.biblioteca_social_retracted()}</span
									>{/if}
								{#if item.moderation !== 'visible'}<span class="badge warn"
										>{m.biblioteca_social_moderated()}</span
									>{/if}
								{#if curveBadge(item.curve) === 'yolo'}<YoloBadge
										badge="yolo"
									/>{:else if curveBadge(item.curve) === 'warn'}<span
										class="badge warn"
										data-curve-badge="warn">{m.biblioteca_social_gate_failed()}</span
									>{/if}
							</div>
							{#if shelf !== 'created'}<span class="desc"
									>{#if item.author}{m.biblioteca_social_by({
											name: item.author.displayUsername
										})}{:else}{m.biblioteca_social_author_removed()}{/if}</span
								>{:else if item.head.description}<span class="desc">{item.head.description}</span
								>{/if}
							{#if ackFor?.id === item.id}
								{@const pending = ackFor}
								<YoloPublishAck
									waived={pending.waived}
									busy={busy === item.id}
									headingLevel={4}
									onconfirm={() => void act(item, pending.action, pending.value, true)}
									oncancel={() => cancelAck(item)}
								/>
							{/if}
							<div class="row-actions">
								{#if item.status === 'active'}<a
										href="/c/{encodeURIComponent(item.id)}"
										aria-label={m.biblioteca_social_open_label({ name: item.head.name })}
										>{m.biblioteca_social_open()}</a
									>{/if}
								{#if shelf === 'created' && item.own}
									<label
										>{m.biblioteca_social_visibility()}
										<select
											id="{id}-visibility-{item.id}"
											value={item.visibility}
											disabled={!verified || busy !== null || item.status === 'retracted'}
											aria-label={m.biblioteca_social_change_visibility({ name: item.head.name })}
											onchange={(event) => {
												const next = event.currentTarget.value;
												if (next === 'public' || next === 'unlisted' || next === 'private') {
													void act(item, 'visibility', next);
												}
											}}
										>
											<option value="public">{visibilityLabels.public}</option>
											<option value="unlisted">{visibilityLabels.unlisted}</option>
											<option value="private">{visibilityLabels.private}</option>
										</select></label
									>
									{#if item.status === 'active'}
										<button
											type="button"
											disabled={busy !== null}
											onclick={() => act(item, 'retract')}>{m.biblioteca_social_retract()}</button
										>
									{:else}
										<button
											type="button"
											disabled={!verified || busy !== null}
											onclick={() => act(item, 'restore')}>{m.biblioteca_social_restore()}</button
										>
									{/if}
									{#if editable(item)}
										<button
											type="button"
											id="{id}-edit-{item.id}"
											aria-label={m.cvedit_edit_label({ name: item.head.name })}
											aria-expanded={editing === item.id}
											aria-controls={editing === item.id ? `${id}-edit-form-${item.id}` : undefined}
											disabled={!verified || busy !== null}
											onclick={() => {
												if (editing === item.id) closeEdit(item.id);
												else void openEdit(item);
											}}>{m.cvedit_edit()}</button
										>
									{/if}
									<button
										type="button"
										aria-expanded={open === item.id}
										onclick={() => {
											open = open === item.id ? null : item.id;
										}}>{m.biblioteca_social_insights()}</button
									>
								{/if}
							</div>
							{#if shelf === 'created' && editing === item.id && editable(item)}
								<form
									class="edit"
									id="{id}-edit-form-{item.id}"
									aria-labelledby="{id}-edit-title-{item.id}"
									onsubmit={(event) => {
										event.preventDefault();
										void saveEdit(item);
									}}
								>
									<h3 id="{id}-edit-title-{item.id}">
										{m.cvedit_edit_title({ name: item.head.name })}
									</h3>
									<label class="field"
										>{m.curva_social_name()}
										<input
											bind:this={editNameField}
											bind:value={editName}
											required
											maxlength="48"
											disabled={busy !== null}
											aria-invalid={editNameIssues.length > 0 ? 'true' : undefined}
											aria-describedby={editNameIssues.length > 0
												? `${id}-edit-name-issue`
												: undefined}
											onkeydown={(event) => escapeEdit(event, item.id)}
										/></label
									>
									{#if editNameIssues.length}
										<p class="issue" id="{id}-edit-name-issue">
											{editNameIssues.map(textIssueText).join(' ')}
										</p>
									{/if}
									<label class="field"
										>{m.curva_social_description()}
										<textarea
											bind:this={editDescriptionField}
											bind:value={editDescription}
											maxlength="280"
											rows="3"
											disabled={busy !== null}
											aria-invalid={editDescriptionIssues.length > 0 ? 'true' : undefined}
											aria-describedby={editDescriptionIssues.length > 0
												? `${id}-edit-description-issue`
												: `${id}-edit-description-hint`}
											onkeydown={(event) => escapeEdit(event, item.id)}></textarea></label
									>
									{#if editDescriptionIssues.length}
										<p class="issue" id="{id}-edit-description-issue">
											{editDescriptionIssues.map(textIssueText).join(' ')}
										</p>
									{:else}
										<p class="hint" id="{id}-edit-description-hint">
											{m.cvedit_description_hint()}
										</p>
									{/if}
									<p class="hint">{m.cvedit_edit_version()}</p>
									{#if curveBadge(item.curve) === 'warn'}
										<p class="hint">{m.biblioteca_edit_gate_refused_hint()}</p>
									{/if}
									{#if editAck === item.id}
										<YoloPublishAck
											waived={waivedLabels(item.curve.waived)}
											busy={busy === item.id}
											headingLevel={4}
											onconfirm={() => void saveEdit(item, true)}
											oncancel={() => (editAck = null)}
										/>
									{/if}
									<div class="edit-status" role="status" aria-live="polite">
										{editMessage}
										{#if editOtherIssues.length}
											<ul>
												{#each editOtherIssues as issue (issue.code)}
													<li>{textIssueText(issue)}</li>
												{/each}
											</ul>
										{/if}
										{#if editGate.length}
											<ul>
												{#each editGate as text, index (`${index}:${text}`)}
													<li>{text}</li>
												{/each}
											</ul>
										{/if}
									</div>
									<div class="row-actions">
										<button
											type="submit"
											disabled={!verified || busy !== null}
											onkeydown={(event) => escapeEdit(event, item.id)}
											>{busy === item.id ? m.cvedit_saving() : m.cvedit_save_confirm()}</button
										>
										<button
											type="button"
											disabled={busy !== null}
											onkeydown={(event) => escapeEdit(event, item.id)}
											onclick={() => closeEdit(item.id)}>{m.cvedit_cancel()}</button
										>
									</div>
								</form>
							{/if}
							{#if shelf === 'created' && open === item.id}
								<CreationInsights
									lineageId={item.id}
									name={item.head.name}
									{verified}
									{api}
									{origin}
								/>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if current(tab).cursor && current(tab).status === 'ready'}
				<button type="button" onclick={() => more(tab)}>{m.biblioteca_social_more()}</button>
			{/if}
		</div>
		<p class="notice" role="status">{notice}</p>
	{/if}
</section>

<style>
	.mine {
		margin: 0 0 26px;
		padding: 18px 0 8px;
		border-top: 1px solid #b99c6a44;
		color: #e0cdae;
		font:
			12px/1.6 'JetBrains Mono',
			monospace;
	}
	.mine-head {
		margin-bottom: 14px;
	}
	h2 {
		margin: 0;
		color: #ede0bf;
		font:
			30px/1.1 'Instrument Serif',
			Georgia,
			serif;
	}
	p {
		margin: 6px 0;
	}
	.invite a,
	.row a {
		color: #f4c66e;
		text-underline-offset: 3px;
	}
	.offline {
		color: #ffdf9d;
	}
	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 12px;
	}
	.tab {
		min-height: 36px;
		padding: 6px 10px;
		background: linear-gradient(#454b3e, #282e24);
		border: 1px solid #171c15;
		color: #f3efd9;
		font:
			11px 'JetBrains Mono',
			monospace;
		cursor: pointer;
	}
	.tab[aria-selected='true'] {
		background: linear-gradient(#edc57a, #bc8e3a);
		color: #211e15;
	}
	.badge {
		display: inline-block;
		padding: 0 6px;
		margin-left: 6px;
		border: 1px solid currentColor;
		border-radius: 2px;
		font-size: 10px;
	}
	.badge.warn {
		color: #ffb48a;
	}
	.vis-public {
		color: #b7e3a1;
	}
	.vis-unlisted {
		color: #f4c66e;
	}
	.vis-private {
		color: #d8cfc0;
	}
	.filter,
	.row-actions label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	select {
		padding: 6px 4px;
		color: #f3eed5;
		background: #293023;
		border: 1px solid #abb28c66;
		font: inherit;
	}
	.rows {
		list-style: none;
		margin: 10px 0;
		padding: 0;
	}
	.row {
		padding: 12px 0;
		border-top: 1px solid #b99c6a33;
	}
	.row strong {
		color: #ede0bf;
		font:
			700 17px 'Courier Prime',
			monospace;
		overflow-wrap: anywhere;
	}
	.desc {
		display: block;
		color: #cdbb98;
		overflow-wrap: anywhere;
		white-space: pre-line;
	}
	.shelf-title {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}
	.row-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
	}
	button:not(.tab) {
		min-height: 36px;
		padding: 8px 12px;
		border: 1px solid #b5ae9477;
		border-radius: 2px;
		background: #272d23;
		color: #ece7dd;
		cursor: pointer;
		font-family: inherit;
	}
	button:disabled,
	select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.notice:empty {
		margin: 0;
	}
	.edit {
		max-width: 34rem;
		margin-top: 10px;
		padding: 10px 12px;
		border: 1px solid #b99c6a44;
	}
	.edit h3 {
		margin: 0 0 6px;
		color: #ede0bf;
		font: inherit;
		font-weight: 700;
		overflow-wrap: anywhere;
	}
	.field {
		display: grid;
		gap: 4px;
		margin: 8px 0 4px;
	}
	.field input,
	.field textarea {
		box-sizing: border-box;
		width: 100%;
		min-height: 36px;
		padding: 6px 8px;
		color: #f3eed5;
		background: #293023;
		border: 1px solid #abb28c66;
		font: inherit;
	}
	.field textarea {
		resize: vertical;
	}
	.field [aria-invalid='true'] {
		border-color: #ffb48a;
	}
	.edit .issue {
		color: #ffb48a;
	}
	.edit .hint {
		color: #cdbb98;
	}
	.field :where(input, textarea):focus-visible {
		outline: 3px solid #f6bd55;
		outline-offset: 2px;
	}
	:where(button, a, select, .row):focus-visible {
		outline: 3px solid #f6bd55;
		outline-offset: 4px;
	}
</style>
