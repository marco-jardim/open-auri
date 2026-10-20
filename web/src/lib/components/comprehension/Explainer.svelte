<!--
	Explainer trigger (eager, tiny). Only the localized title is in the page's chunk, for the
	accessible name; the explanation panel and the §4.3 bodies load on first intent (hover, focus
	or press) and open once they are there (FUX.B). The trigger owns open state and focus return.
	Two looks share that behaviour: `icon` (default), the round "?" button beside a term, and
	`term`, where the visible technical word itself (the children, else the explainer's title) is
	the trigger, set in its label's own type with a dotted underline and no extra glyph. Its
	accessible name is that word followed by "O que é isso?".
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { explainerHeadings, type ExplainerId } from '#lib/comprehension/explainer-titles.ts';
	import { explainerPanel } from './panels.ts';
	import { registerNativeBack } from '#lib/components/chrome/native-back.ts';

	let {
		term,
		variant = 'icon',
		children
	}: {
		term: ExplainerId;
		/** `icon`: a "?" button next to the term. `term`: the visible word is the trigger. */
		variant?: 'icon' | 'term';
		/** The visible term of the `term` variant (defaults to the explainer's title). */
		children?: Snippet;
	} = $props();
	const id = $props.id();
	let open = $state(false);
	$effect(() => {
		if (!open) return;
		return registerNativeBack({ canDismiss: () => true, dismiss: close });
	});
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

{#snippet explanation()}
	{#if open && explainerPanel.current}
		{@const Panel = explainerPanel.current}
		<Panel {term} {id} trigger={() => trigger ?? null} onclose={close} />
	{/if}
{/snippet}

<!-- The term variant sits inside running text: no whitespace between its nodes. -->
{#if variant === 'term'}
	<button
		bind:this={trigger}
		type="button"
		class="term"
		aria-labelledby="{id}-term {id}-ask"
		aria-expanded={open}
		aria-controls={id}
		aria-haspopup="dialog"
		onpointerenter={() => explainerPanel.request()}
		onfocus={() => explainerPanel.request()}
		onclick={toggle}
		><span id="{id}-term"
			>{#if children}{@render children()}{:else}{heading.title()}{/if}</span
		></button
	><span id="{id}-ask" hidden>{m.fux1_what_is_this()}</span>{@render explanation()}
{:else}
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

	{@render explanation()}
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
	/* Term variant: the word keeps its label's type and colour; only a dotted underline marks it. */
	.term {
		position: relative;
		display: inline;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: var(--rad-xs, 2px);
		appearance: none;
		background: none;
		color: inherit;
		font: inherit;
		letter-spacing: inherit;
		word-spacing: inherit;
		text-align: inherit;
		text-indent: inherit;
		text-shadow: inherit;
		text-transform: inherit;
		text-decoration: underline dotted;
		text-decoration-color: currentColor;
		text-decoration-thickness: 1px;
		text-underline-offset: 3px;
		cursor: help;
	}
	.term:hover,
	.term:focus-visible,
	.term[aria-expanded='true'] {
		text-decoration-color: var(--accent, #ff9a57);
	}
	.term:focus-visible {
		outline: var(--focus-width, 2px) solid var(--accent, #ff9a57);
		outline-offset: var(--focus-offset, 3px);
	}
	@media (pointer: coarse) {
		.trigger {
			min-width: 44px;
			min-height: 44px;
		}
		/* A 44px touch target centred on the word, out of flow: the text does not move. */
		.term::after {
			content: '';
			position: absolute;
			top: 50%;
			left: 50%;
			width: 100%;
			height: 100%;
			min-width: 44px;
			min-height: 44px;
			transform: translate(-50%, -50%);
		}
	}
</style>
