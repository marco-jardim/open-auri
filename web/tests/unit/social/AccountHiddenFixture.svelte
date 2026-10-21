<script lang="ts">
	import { AccountSession, type AccountProbe } from '#lib/components/chrome/account.svelte.ts';
	import { createAccountHiddenStore } from '#lib/social/account-hidden.svelte.ts';
	import { setHiddenStore } from '#lib/social/hidden-context.ts';
	import { isHidden } from '#lib/social/hidden.ts';
	import HiddenItems from '#lib/components/social/HiddenItems.svelte';
	let { probe }: { probe: AccountProbe } = $props();
	const account = new AccountSession(
		() => ({ user: null, resolved: false, path: '/docs' }),
		(signal) => probe(signal)
	);
	const hidden = setHiddenStore(createAccountHiddenStore(account));
</script>

<output
	data-known={account.known}
	data-ready={$hidden.ready}
	data-signed-in={$hidden.signedIn}
	data-curves={$hidden.curves.join(',')}
></output>
<!-- Stands in for a navigation or the chrome's retry: the layout probes the session again. -->
<button type="button" data-testid="probe-again" onclick={() => account.retry()}>probe</button>
<HiddenItems />
{#each ['local-blocked', 'remote-blocked', 'zoe-blocked', 'allowed'] as id (id)}
	{#if $hidden.ready && !isHidden($hidden, id)}<p data-source={id}>{id}</p>{/if}
{/each}
