<!--
	Explainer trigger (eager, tiny). Only the localized title is in the page's chunk, for the
	accessible name; the explanation panel and the §4.3 bodies load on first intent (hover, focus
	or press) and open once they are there (FUX.B). The trigger owns open state and focus return.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { explainerHeadings, type ExplainerId } from '#lib/comprehension/explainer-titles.ts';
	import { explainerPanel } from './panels.ts';

	let { term }: { term: ExplainerId } = $props();
	const id = $props.id();
	let open = $state(false);
	let trigger: HTMLButtonElement | undefined = $state();
	const heading = $derived(explainerHeadings[term]);

	function close() {
		if (!open) return;
		open = false;
		trigger?.focus({ preventScroll: true });
	}

	function toggle() {
		if (open) {
			close();
			return;
		}
		// Opens once the panel chunk is there (at once after the first load, or warmed by intent).
		explainerPanel.load().then(
			() => {
				open = true;
			},
			(error: unknown) => console.error('The explanation could not load', error)
		);
	}
</script>

<button
	bind:this={trigger}
	type="button"
	class="trigger"
	aria-label={m.explain_trigger({ term: heading.title() })}
	aria-expanded={open}
	aria-controls={id}
	aria-haspopup="dialog"
	onpointerenter={() => explainerPanel.request()}
	onfocus={() => explainerPanel.request()}
	onclick={toggle}><span aria-hidden="true">?</span></button
>

{#if open && explainerPanel.current}
	{@const Panel = explainerPanel.current}
	<Panel {term} {id} trigger={() => trigger ?? null} onclose={close} />
{/if}

<style>
	.trigger {
		display: inline-grid;
		place-items: center;
		min-width: 24px;
		min-height: 24px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--text-2, #cfc9be);
		font: 500 var(--fs-small, 13px)/1 var(--face-body, 'Geist', system-ui, sans-serif);
		cursor: pointer;
	}
	.trigger span {
		display: grid;
		place-items: center;
		box-sizing: border-box;
		width: 24px;
		height: 24px;
		border: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: 50%;
	}
	.trigger:focus-visible {
		outline: 2px solid var(--accent, #ff9a57);
		outline-offset: 3px;
	}
	@media (pointer: coarse) {
		.trigger {
			min-width: 44px;
			min-height: 44px;
		}
	}
</style>
