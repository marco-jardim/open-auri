<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { CableService } from '#lib/cable/service.ts';
	import type { CableState } from '#lib/cable/types.ts';

	interface Props {
		service: CableService;
		/**
		 * Opens the pre-write checklist with Neutro (`NEUTRAL_CURVE`) or another known curve.
		 * The rescue write goes through the same checklist and gesture as any write.
		 */
		onrescue: () => void;
	}

	let { service, onrescue }: Props = $props();

	let cable = $state.raw<CableState>(untrack(() => service.getState()));
	$effect(() => service.subscribe((next) => (cable = next)));

	const titleId = $props.id();
</script>

{#if cable.rescue !== null}
	<section
		role="alert"
		aria-labelledby={`${titleId}-title`}
		class="flex flex-col gap-2 rounded border-2 border-current p-3"
	>
		<h2 id={`${titleId}-title`} class="font-semibold">{m.cable_rescue_title()}</h2>
		<p>{m.cable_rescue_body()}</p>
		{#if cable.rescue.reportsSent !== null}
			<p class="text-sm">{m.cable_rescue_reports({ count: String(cable.rescue.reportsSent) })}</p>
		{/if}
		{#if cable.rescue.deviceLabel !== null}
			<p class="text-sm">{m.cable_rescue_device({ device: cable.rescue.deviceLabel })}</p>
		{/if}
		<p class="text-sm opacity-80">{m.cable_rescue_note()}</p>
		<div class="flex flex-wrap gap-2">
			<button
				type="button"
				class="rounded border-2 border-current px-3 py-1 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2"
				disabled={cable.writing}
				onclick={onrescue}
			>
				{m.cable_rescue_action()}
			</button>
			<button
				type="button"
				class="rounded border border-current px-3 py-1 focus-visible:outline-2 focus-visible:outline-offset-2"
				onclick={() => service.dismissRescue()}
			>
				{m.cable_rescue_dismiss()}
			</button>
		</div>
	</section>
{/if}
