<!--
	Header account entry: "Entrar" when anonymous; when signed in, the nickname (or "Conta")
	opens the user menu (FUX.1, spec §2.6): Minha conta, Meu perfil público, Minha biblioteca,
	Admin (only when the admin role is effective in this session) and Sair.
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
	import { Menu, type MenuItem } from '#lib/components/primitives/index.ts';
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
		<Menu
			{items}
			bind:open={menuOpen}
			note={failure}
			class={['btn', 'btn--plate', 'btn--sm', 'account-trigger', onAccount && 'is-current']}
			data-account="signed-in"
			aria-busy={signingOut ? 'true' : undefined}
		>
			{#snippet trigger()}
				<span class="dot" class:warn={!account.emailVerified} aria-hidden="true"></span>
				{#if account.username}
					<span class="sr-only">{m.auth_account_label()}:</span>
					<span class="name">{account.username}</span>
				{:else}
					{m.auth_account_label()}
				{/if}
				{#if !account.emailVerified}
					<span class="sr-only">({m.auth_account_unverified()})</span>
				{/if}
				<svg class="caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
					<path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
				</svg>
			{/snippet}
		</Menu>
		<span class="sr-only" role="status">{failure ?? ''}</span>
	</div>
{:else}
	<a
		class="account btn btn--plate btn--sm"
		href={signInHref(currentPath)}
		aria-current={pathname === '/entrar' ? 'page' : undefined}
		data-account={pending ? 'pending' : 'anonymous'}
	>
		{m.auth_account_signin()}
	</a>
{/if}

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

	.dot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--ok);
	}

	.dot.warn {
		background: var(--warn);
	}

	.caret {
		flex: none;
		opacity: 0.8;
	}
</style>
