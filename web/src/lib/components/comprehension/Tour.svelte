<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { floating } from '#lib/comprehension/floating.ts';
	import { tourSteps, type TourPage } from '#lib/comprehension/steps.ts';
	import { tour, type TourController } from '#lib/comprehension/tour.svelte.ts';

	let {
		page,
		controller = tour,
		autoOpen = true
	}: {
		page: TourPage;
		controller?: TourController;
		autoOpen?: boolean;
	} = $props();
	const id = $props.id();
	let heading: HTMLHeadingElement | undefined = $state();
	const steps = $derived(tourSteps[page]);
	const index = $derived(Math.min(controller.stepIndex, steps.length - 1));
	const step = $derived(steps[index]);
	const visible = $derived(controller.activePage === page);

	onMount(() => {
		if (autoOpen && controller.shouldAutoOpen(page)) controller.open(page);
		return () => {
			if (controller.activePage === page) controller.dismiss(page);
		};
	});

	function focusPanel(node: HTMLDivElement) {
		const previous = document.activeElement;
		node.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
		return {
			destroy() {
				// Do not steal focus from a background control the reader chose to use.
				if (
					previous instanceof HTMLElement &&
					previous.isConnected &&
					(node.contains(document.activeElement) || document.activeElement === document.body)
				) {
					previous.focus({ preventScroll: true });
				}
			}
		};
	}

	async function move(next: number) {
		controller.goTo(next);
		await tick();
		heading?.focus({ preventScroll: true });
	}

	function keydown(event: KeyboardEvent) {
		if (visible && event.key === 'Escape' && !event.defaultPrevented) {
			event.preventDefault();
			controller.dismiss(page);
		}
	}
</script>

<svelte:window onkeydown={keydown} />

{#if visible}
	<div
		class="tour"
		popover="manual"
		role="dialog"
		aria-modal="false"
		aria-labelledby="{id}-title"
		aria-describedby="{id}-body {id}-counter"
		use:floating={{ selector: step.selector, highlight: true }}
		use:focusPanel
	>
		<p class="counter" id="{id}-counter" aria-live="polite">
			{m.tour_counter({ current: index + 1, total: steps.length })}
		</p>
		<h2 bind:this={heading} id="{id}-title" tabindex="-1">{step.title()}</h2>
		<p id="{id}-body">{step.body()}</p>
		<nav aria-label={m.tour_trigger()}>
			<button type="button" class="skip" onclick={() => controller.dismiss(page)}
				>{m.tour_skip()}</button
			>
			{#if index > 0}
				<button type="button" onclick={() => move(index - 1)}>{m.tour_back()}</button>
			{/if}
			{#if index < steps.length - 1}
				<button type="button" class="next" onclick={() => move(index + 1)}>{m.tour_next()}</button>
			{:else}
				<button type="button" class="next" onclick={() => controller.markSeen(page)}
					>{m.tour_finish()}</button
				>
			{/if}
		</nav>
	</div>
{/if}

<style>
	.tour {
		position: fixed;
		inset: auto;
		z-index: 1000;
		box-sizing: border-box;
		width: min(400px, calc(100vw - 24px));
		max-height: calc(100dvh - 24px);
		overflow-y: auto;
		margin: 0;
		padding: 24px;
		border: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-lg, 8px);
		background: var(--ink-3, #1d1c1a);
		color: var(--text, #ece7dd);
		box-shadow: var(--elev-3, 0 24px 64px -16px rgba(0, 0, 0, 0.8));
		font: var(--fs-small, 13px)/1.55 var(--face-body, 'Geist', system-ui, sans-serif);
		font-synthesis: none;
	}
	.counter {
		margin: 0 0 12px;
		color: var(--muted-hi, #a39d92);
		font: 400 var(--fs-caption, 12px)/1.4 var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	h2 {
		margin: 0;
		font: inherit;
		font-weight: 600;
	}
	p {
		color: var(--text-2, #cfc9be);
	}
	nav {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 20px;
	}
	button {
		min-height: 36px;
		padding: 6px 10px;
		border: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-lg, 8px);
		background: transparent;
		color: var(--text, #ece7dd);
		font: 500 var(--fs-small, 13px)/1.4 var(--face-body, 'Geist', system-ui, sans-serif);
		cursor: pointer;
	}
	.skip {
		margin-right: auto;
		color: var(--text-2, #cfc9be);
	}
	.next {
		border-color: var(--accent, #ff9a57);
		color: var(--accent-text, #ff9a57);
	}
	button:focus-visible,
	h2:focus-visible {
		outline: 2px solid var(--accent, #ff9a57);
		outline-offset: 3px;
	}
	:global([data-tour-active]) {
		outline: 2px solid var(--accent, #ff9a57);
		outline-offset: 4px;
		transition: outline-color var(--dur-base, 0.2s) var(--ease-out, ease-out);
	}
	@media (pointer: coarse) {
		button {
			min-height: 44px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global([data-tour-active]) {
			transition: none;
			animation: none;
		}
	}
</style>
