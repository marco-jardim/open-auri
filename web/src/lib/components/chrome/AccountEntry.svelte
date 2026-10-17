<!--
	Header account entry: "Entrar" when anonymous; when signed in, the nickname (or "Conta")
	opens the user menu (FUX.1, spec §2.6): Minha conta, Meu perfil público, Minha biblioteca,
	Admin (only when the admin role is effective in this session) and Sair.
	FUX.NAV: inside the compact bar (an ancestor with `.bar-compact`) it is a square bar button,
	a monogram (or a person glyph for "Entrar") with a tooltip, the name kept for screen readers;
	in the mobile menu sheet it shows the full name.
	Sair uses the existing Better Auth sign-out (POST /api/auth/sign-out, allowed even in
	read-only mode), then reloads so every per-account view resets; it waits while a cable write
	sends bytes, and says so.
-->
<script module lang="ts">
	/** Better Auth sign-out (allowlisted in read-only mode, lib/server/admin/read-only.ts). */
	export const SIGN_OUT_ENDPOINT = '/api/auth/sign-out';
</script>

<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { isWriteInProgress, onWriteProgress } from '#lib/cable/write-flag.ts';
	import Tooltip from '#lib/components/primitives/Tooltip.svelte';
	import type { MenuItem } from '#lib/components/primitives/Menu.svelte';
	// The menu itself is its own chunk, loaded on the trigger's first hover, focus or press.
	import LazyMenu from './LazyMenu.svelte';
	import { ACCOUNT_HREF, signInHref, type AccountSummary } from './account.ts';

	interface Props {
		user: AccountSummary | null;
		currentPath?: string;
		/** True while a prerendered page still asks who is signed in. */
		pending?: boolean;
		/** The admin role is effective in this session (layout data); shows the Admin item. */
		admin?: boolean;
		/** Ends the session; rejects on failure (default: POST /api/auth/sign-out). */
		signOut?: () => Promise<void>;
		/** After a successful sign-out (default: full reload, home for private pages). */
		onSignedOut?: (target: string) => void;
	}

	let {
		user,
		currentPath = '/',
		pending = false,
		admin = false,
		signOut = defaultSignOut,
		onSignedOut = (target: string) => window.location.assign(target)
	}: Props = $props();

	const pathname = $derived(currentPath.split(/[?#]/, 1)[0] ?? '/');
	const within = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
	const onAccount = $derived(within(ACCOUNT_HREF));
	const profileHref = $derived(user?.username ? `/u/${encodeURIComponent(user.username)}` : null);

	let menuOpen = $state(false);
	let triggerElement: HTMLButtonElement | undefined = $state();
	let signInElement: HTMLAnchorElement | undefined = $state();
	/** Rendered in the compact bar (not in the menu sheet): the name lives in a tooltip. */
	let compact = $state(false);
	let tipOpen = $state(false);
	$effect(() => {
		const element = triggerElement ?? signInElement;
		compact = element?.closest('.bar-compact') != null;
	});
	// The open menu shows the destinations; the name tooltip would cover them.
	$effect(() => {
		if (menuOpen && tipOpen) tipOpen = false;
	});
	const initial = $derived(user?.username ? Array.from(user.username)[0]?.toUpperCase() : null);
	let signingOut = $state(false);
	let failure = $state<string | null>(null);
	let writing = $state(false);
	$effect(() => {
		writing = isWriteInProgress();
		return onWriteProgress(() => {
			writing = isWriteInProgress();
		});
	});

	async function defaultSignOut(): Promise<void> {
		const response = await fetch(SIGN_OUT_ENDPOINT, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: '{}'
		});
		if (!response.ok) throw new Error(`Sign-out failed with HTTP ${response.status}`);
	}

	async function leave(): Promise<void> {
		if (signingOut || isWriteInProgress()) return;
		signingOut = true;
		failure = null;
		try {
			await signOut();
			// Private areas need a session: go home. Elsewhere stay on the same page.
			onSignedOut(within(ACCOUNT_HREF) || within('/admin') ? '/' : currentPath);
		} catch (error) {
			console.warn('Sign-out failed', error);
			failure = m.fux1_menu_signout_failed();
			menuOpen = true;
		} finally {
			signingOut = false;
		}
	}

	const items = $derived.by((): MenuItem[] => {
		const list: MenuItem[] = [
			{ id: 'account', label: m.fux1_menu_account(), href: ACCOUNT_HREF, current: onAccount }
		];
		if (profileHref) {
			list.push({
				id: 'profile',
				label: m.fux1_menu_profile(),
				href: profileHref,
				current: pathname === profileHref
			});
		}
		list.push({
			id: 'library',
			label: m.fux1_menu_library(),
			href: '/biblioteca',
			current: pathname === '/biblioteca'
		});
		if (admin) {
			list.push({
				id: 'admin',
				label: m.fux1_menu_admin(),
				href: '/admin',
				current: within('/admin')
			});
		}
		list.push({
			id: 'signout',
			label: m.fux1_menu_signout(),
			separated: true,
			disabledReason: writing ? m.fux1_menu_signout_writing() : null,
			onselect: () => void leave()
		});
		return list;
	});
</script>

{#if user}
	{@const account = user}
	<div class="account-entry">
		<LazyMenu
			{items}
			bind:open={menuOpen}
			bind:triggerElement
			note={failure}
			class={[
				'btn',
				'btn--plate',
				'btn--sm',
				'btn--bar',
				'account-trigger',
				onAccount && 'is-current'
			]}
			data-account="signed-in"
			aria-busy={signingOut ? 'true' : undefined}
		>
			{#snippet trigger()}
				<span class="avatar" aria-hidden="true">
					{#if initial}{initial}{:else}{@render person()}{/if}
					<span class="dot" class:warn={!account.emailVerified}></span>
				</span>
				{#if account.username}
					<span class="sr-only">{m.auth_account_label()}:</span>
					<span class="name">{account.username}</span>
				{:else}
					<span class="name">{m.auth_account_label()}</span>
				{/if}
				{#if !account.emailVerified}
					<span class="sr-only">({m.auth_account_unverified()})</span>
				{/if}
				<svg class="caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
					<path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
				</svg>
			{/snippet}
		</LazyMenu>
		{#if compact}
			<Tooltip
				text={account.username ?? m.auth_account_label()}
				anchor={menuOpen ? null : triggerElement}
				bind:open={tipOpen}
			/>
		{/if}
		<span class="sr-only" role="status">{failure ?? ''}</span>
	</div>
{:else}
	<a
		bind:this={signInElement}
		class="account btn btn--plate btn--sm btn--bar"
		href={signInHref(currentPath)}
		aria-current={pathname === '/entrar' ? 'page' : undefined}
		data-account={pending ? 'pending' : 'anonymous'}
	>
		<span class="glyph" aria-hidden="true">{@render person()}</span>
		<span class="name">{m.auth_account_signin()}</span>
	</a>
	{#if compact}
		<Tooltip text={m.auth_account_signin()} anchor={signInElement} />
	{/if}
{/if}

{#snippet person()}
	<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
		<circle cx="8" cy="5.5" r="2.75" fill="none" stroke="currentColor" stroke-width="1.4" />
		<path
			d="M2.75 14c.6-2.9 2.7-4.5 5.25-4.5s4.65 1.6 5.25 4.5"
			fill="none"
			stroke="currentColor"
			stroke-width="1.4"
			stroke-linecap="round"
		/>
	</svg>
{/snippet}

<style>
	.account-entry {
		display: contents;
	}

	.account-entry :global(.account-trigger) {
		max-width: 180px;
	}

	.account-entry :global(.account-trigger.is-current),
	.account[aria-current='page'] {
		--btn-border: var(--accent);
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Monogram in the display face, on an elevated well; the lamp is the e-mail state. */
	.avatar {
		position: relative;
		display: inline-grid;
		flex: none;
		place-items: center;
		width: 22px;
		height: 22px;
		border: 1px solid var(--rule-control);
		border-radius: 50%;
		background: var(--ink-4);
		box-shadow: var(--bevel);
		color: var(--text);
		font: italic 400 var(--fs-body) / 1 var(--face-display);
	}

	.dot {
		position: absolute;
		right: -2px;
		bottom: -2px;
		width: 7px;
		height: 7px;
		border: 2px solid var(--bar-bg);
		border-radius: 50%;
		background: var(--ok);
	}

	.dot.warn {
		background: var(--warn);
	}

	.glyph {
		display: inline-grid;
		place-items: center;
	}

	.caret {
		flex: none;
		opacity: 0.8;
	}

	/* Compact bar: a square button; the name stays in the accessible name and the tooltip. */
	:global(.bar-compact) .account-entry :global(.account-trigger),
	:global(.bar-compact) .account {
		width: var(--btn-h);
		padding: 0;
	}

	:global(.bar-compact) .name {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	:global(.bar-compact) .caret {
		display: none;
	}
</style>
