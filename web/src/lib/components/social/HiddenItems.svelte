<script lang="ts">
	import Button from '#lib/components/primitives/Button.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getHiddenStore } from '#lib/social/hidden-context.ts';
	import { hiddenLabel, type HiddenType } from '#lib/social/hidden.ts';
	const hidden = getHiddenStore();
	/** A failed "Show again" from this list, announced next to it. */
	let unhideFailed = $state(false);
	$effect(() => {
		if (!$hidden.error) unhideFailed = false;
	});
	async function unhide(type: HiddenType, id: string) {
		unhideFailed = false;
		try {
			await hidden.unhide(type, id);
		} catch (error) {
			unhideFailed = true;
			console.warn('Could not unhide item', error);
		}
	}
</script>

<!-- Only a failed list load is announced here: a failed hide/unhide is announced once, by the
	 action that started it (HideActions), never a second time at page level. -->
{#if $hidden.loadError}
	<div class="hidden-error" role="alert">
		<p>{m.hidden_error()}</p>
		<Button size="sm" loading={$hidden.busy} onclick={() => hidden.retry()}
			>{m.hidden_retry()}</Button
		>
	</div>
{/if}
<details class="hidden-items" id="itens-ocultos">
	<summary>{m.hidden_title()}</summary>
	<p>{$hidden.signedIn ? m.hidden_account_hint() : m.hidden_local_hint()}</p>
	{#if !$hidden.ready && !$hidden.loadError}<p role="status">{m.hidden_loading()}</p>{/if}
	{#if unhideFailed && !$hidden.loadError}<p role="alert">{m.hidden_error()}</p>{/if}
	{#if !$hidden.authors.length && !$hidden.curves.length}
		{#if $hidden.ready}<p>{m.hidden_empty()}</p>{/if}
	{:else}
		<ul>
			{#each $hidden.authors as author (author)}
				{@const name = hiddenLabel($hidden, 'author', author) ?? m.hidden_author()}
				<li>
					<span>{m.hidden_author()} @{name}</span>
					<Button
						size="sm"
						loading={$hidden.busy}
						onclick={() => unhide('author', author)}
						aria-label={m.hidden_unhide_named({ name })}>{m.hidden_unhide()}</Button
					>
				</li>
			{/each}
			{#each $hidden.curves as curve (curve)}
				{@const name = hiddenLabel($hidden, 'curve', curve) ?? m.hidden_curve()}
				<li>
					<span>{m.hidden_curve()} {name}</span>
					<Button
						size="sm"
						loading={$hidden.busy}
						onclick={() => unhide('curve', curve)}
						aria-label={m.hidden_unhide_named({ name })}>{m.hidden_unhide()}</Button
					>
				</li>
			{/each}
		</ul>
	{/if}
</details>

<style>
	.hidden-items {
		padding: var(--space-3);
		border: 1px solid var(--rule);
		border-radius: var(--rad-md);
	}
	ul {
		max-height: 24rem;
		overflow: auto;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-2);
		overflow-wrap: anywhere;
	}
</style>
