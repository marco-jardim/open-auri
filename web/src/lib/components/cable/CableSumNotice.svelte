<script lang="ts">
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import { m } from '#lib/paraglide/messages.js';
	import Button from '#lib/components/primitives/Button.svelte';

	interface Props {
		app: ClientApp | null;
		flat: boolean;
		comparing: boolean;
		variant?: 'ab' | 'blind';
	}

	let { app, flat, comparing, variant = 'ab' }: Props = $props();
	const cable = $derived(app?.cableState ?? null);
	const connected = $derived(cable?.connection === 'connected');
</script>

{#if cable?.liveOrphan}
	<div class="orphan" role="note" data-live-orphan>
		<p>{m.cable_live_orphan()}</p>
		<Button
			variant="ghost"
			size="sm"
			onclick={() => app?.cable.dismissLiveOrphan()}
			data-live-orphan-dismiss>{m.cable_live_orphan_dismiss()}</Button
		>
	</div>
{:else if variant === 'blind' && connected}
	<p role="note">{m.cable_sum_blind()}</p>
{:else if flat && !comparing}
	<p role="note">{m.cable_sum_flat()}</p>
{:else if connected && !flat}
	<p role="note">
		{m.cable_sum_note()}
		{cable?.liveCapable ? m.cable_sum_hint() : m.cable_sum_hint_output()}
	</p>
{/if}
