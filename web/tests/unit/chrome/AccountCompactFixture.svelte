<!-- AccountEntry inside the compact bar (an ancestor with `.bar-compact`), as CableBar renders it. -->
<script lang="ts">
	import AccountEntry from '#lib/components/chrome/AccountEntry.svelte';
	import type { AccountSummary } from '#lib/components/chrome/account.ts';

	let { user, currentPath = '/' }: { user: AccountSummary | null; currentPath?: string } = $props();
</script>

<div class="bar-compact">
	<AccountEntry
		{user}
		{currentPath}
		signOut={async () => undefined}
		onSignedOut={() => undefined}
	/>
</div>
