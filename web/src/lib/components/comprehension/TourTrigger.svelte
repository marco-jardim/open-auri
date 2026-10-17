<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { tour, type TourController } from '#lib/comprehension/tour.svelte.ts';
	import type { TourPage } from '#lib/comprehension/steps.ts';

	let { page, controller = tour }: { page: TourPage; controller?: TourController } = $props();
</script>

<button
	type="button"
	aria-label={m.tour_trigger_label()}
	aria-haspopup="dialog"
	aria-expanded={controller.activePage === page}
	onclick={() => controller.open(page)}
>
	<span class="symbol" aria-hidden="true">?</span>
	<span>{m.tour_trigger()}</span>
</button>

<style>
	button {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 36px;
		padding: 6px 10px;
		border: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-lg, 8px);
		background: var(--ink-3, #1d1c1a);
		color: var(--text, #ece7dd);
		font: 500 var(--fs-small, 13px)/1.4 var(--face-body, 'Geist', system-ui, sans-serif);
		cursor: pointer;
	}
	.symbol {
		color: var(--accent-text, #ff9a57);
	}
	button:focus-visible {
		outline: 2px solid var(--accent, #ff9a57);
		outline-offset: 3px;
	}
	@media (pointer: coarse) {
		button {
			min-height: 44px;
		}
	}
</style>
