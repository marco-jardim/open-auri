<!--
	The open explanation (lazy chunk, FUX.B): the §4.3 bodies of every explainer, positioning,
	the glossary link and the close rules (Escape, close button, click outside). Explainer.svelte
	mounts it only while open and owns the trigger and focus return.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { explainers, type ExplainerId } from '#lib/comprehension/explainers.ts';
	import { floating } from '#lib/comprehension/floating.ts';
	import GlossaryLink from './GlossaryLink.svelte';

	let {
		term,
		id,
		trigger,
		onclose
	}: {
		term: ExplainerId;
		/** The trigger's `aria-controls` target. */
		id: string;
		trigger: () => HTMLElement | null;
		onclose: () => void;
	} = $props();
	let panel: HTMLDivElement | undefined = $state();
	const explanation = $derived(explainers[term]);

	function focusPanel(node: HTMLDivElement) {
		node.focus({ preventScroll: true });
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !event.defaultPrevented) {
			event.preventDefault();
			event.stopPropagation();
			onclose();
		}
	}

	function outside(event: MouseEvent) {
		if (
			event.target instanceof Node &&
			!trigger()?.contains(event.target) &&
			!panel?.contains(event.target)
		) {
			onclose();
		}
	}
</script>

<svelte:window onkeydown={keydown} onclick={outside} />

<div
	bind:this={panel}
	{id}
	class="explanation"
	popover="manual"
	role="dialog"
	aria-modal="false"
	aria-labelledby="{id}-title"
	aria-describedby="{id}-body"
	tabindex="-1"
	onkeydown={keydown}
	use:floating={{ anchor: trigger }}
	use:focusPanel
>
	<header>
		<h2 id="{id}-title">{explanation.title()}</h2>
		<button type="button" class="close" aria-label={m.explain_close()} onclick={onclose}>×</button>
	</header>
	<p id="{id}-body">{explanation.preview()}</p>
	{#if explanation.preview !== explanation.body}
		<details>
			<summary>{m.explain_full()}</summary>
			<p>{explanation.body()}</p>
		</details>
	{/if}
	{#if term === 'checklist'}
		<p class="warning">{explainers.checklist.warning()}</p>
	{/if}
	<GlossaryLink term={explanation.term}>{m.explain_glossary()}</GlossaryLink>
</div>

<style>
	.close {
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
	.explanation {
		position: fixed;
		inset: auto;
		z-index: 1000;
		box-sizing: border-box;
		width: min(360px, calc(100vw - 24px));
		max-height: calc(100dvh - 24px);
		overflow-y: auto;
		margin: 0;
		padding: 20px;
		border: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-lg, 8px);
		background: var(--ink-3, #1d1c1a);
		color: var(--text, #ece7dd);
		box-shadow: var(--elev-3, 0 24px 64px -16px rgba(0, 0, 0, 0.8));
		font: var(--fs-small, 13px)/1.55 var(--face-body, 'Geist', system-ui, sans-serif);
		font-synthesis: none;
	}
	header {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: 12px;
	}
	h2 {
		margin: 0;
		font: inherit;
		font-weight: 600;
	}
	p {
		color: var(--text-2, #cfc9be);
		margin: 12px 0;
	}
	.warning {
		color: var(--text, #ece7dd);
		font-weight: 600;
	}
	details {
		margin: 12px 0;
	}
	summary {
		color: var(--accent-text, #ff9a57);
		cursor: pointer;
	}
	summary:focus-visible,
	button:focus-visible,
	.explanation:focus-visible {
		outline: 2px solid var(--accent, #ff9a57);
		outline-offset: 3px;
	}
	@media (pointer: coarse) {
		.close {
			min-width: 44px;
			min-height: 44px;
		}
	}
</style>
