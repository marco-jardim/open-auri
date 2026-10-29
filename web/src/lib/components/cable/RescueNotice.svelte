<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { CableService } from '#lib/cable/service.ts';
	import type { CableState } from '#lib/cable/types.ts';
	import Button from '#lib/components/primitives/Button.svelte';

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
	/**
	 * Never open a second write while one sends bytes. The Button says why (T8), stays focusable
	 * and blocks click, Enter and Space, so `onrescue` is never called meanwhile.
	 */
	const rescueReason = $derived(cable.writing ? m.cabo_fux_busy_writing() : null);
</script>

{#if cable.rescue !== null}
	<!-- A labelled region with buttons; only the body is live. An interruption detected in this
	     session is announced assertively, once; one restored from the journal on load is polite. -->
	<section
		aria-labelledby={`${titleId}-title`}
		class="flex flex-col gap-2 rounded border-2 border-current p-3"
	>
		<h2 id={`${titleId}-title`} class="font-semibold">{m.cable_rescue_title()}</h2>
		<p role={cable.rescue.fresh === true ? 'alert' : 'status'}>{m.cable_rescue_body()}</p>
		{#if cable.rescue.reportsSent !== null}
			<p class="text-sm">{m.cable_rescue_reports({ count: String(cable.rescue.reportsSent) })}</p>
		{/if}
		<!-- B12: the data reports reach the cable before the commit, so it may already play them;
		     B12b: only once report 8 went out. Unknown count (restored from the journal): said too. -->
		{#if cable.rescue.reportsSent === null || cable.rescue.reportsSent >= 8}
			<p class="text-sm">{m.cable_rescue_live()}</p>
		{/if}
		{#if cable.rescue.deviceLabel !== null}
			<p class="text-sm">{m.cable_rescue_device({ device: cable.rescue.deviceLabel })}</p>
		{/if}
		<p class="text-sm opacity-80">{m.cable_rescue_note()}</p>
		<div class="flex flex-wrap gap-2">
			<Button variant="primary" disabledReason={rescueReason} onclick={onrescue}>
				{m.cable_rescue_action()}
			</Button>
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
