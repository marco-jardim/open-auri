<!-- Header account entry: "Entrar" when anonymous, the nickname (or "Conta") when signed in. -->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { ACCOUNT_HREF, signInHref, type AccountSummary } from './account.ts';

	interface Props {
		user: AccountSummary | null;
		currentPath?: string;
		/** True while a prerendered page still asks who is signed in. */
		pending?: boolean;
	}

	let { user, currentPath = '/', pending = false }: Props = $props();
	const pathname = $derived(currentPath.split(/[?#]/, 1)[0] ?? '/');
	const onAccount = $derived(pathname === ACCOUNT_HREF || pathname.startsWith(`${ACCOUNT_HREF}/`));
</script>

{#if user}
	<a
		class="account"
		href={ACCOUNT_HREF}
		aria-current={onAccount ? 'page' : undefined}
		data-account="signed-in"
	>
		<span class="dot" class:warn={!user.emailVerified} aria-hidden="true"></span>
		{#if user.username}
			<span class="sr-only">{m.auth_account_label()}:</span>
			<span class="name">{user.username}</span>
		{:else}
			{m.auth_account_label()}
		{/if}
		{#if !user.emailVerified}<span class="sr-only">({m.auth_account_unverified()})</span>{/if}
	</a>
{:else}
	<a
		class="account"
		href={signInHref(currentPath)}
		aria-current={pathname === '/entrar' ? 'page' : undefined}
		data-account={pending ? 'pending' : 'anonymous'}
	>
		{m.auth_account_signin()}
	</a>
{/if}

<style>
	.account {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		max-width: 160px;
		padding: 0 10px;
		border: 1px solid #57554e;
		border-radius: 3px;
		color: inherit;
		font: 11px/1.2 var(--ui, 'Geist', system-ui, sans-serif);
		text-decoration: none;
		white-space: nowrap;
	}

	.account:hover {
		border-color: #aaa499;
	}

	.account[aria-current='page'] {
		border-color: var(--accent, #ff7a2f);
	}

	.account:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 3px;
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
		background: #3ddc97;
	}

	.dot.warn {
		background: #f2b33d;
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
