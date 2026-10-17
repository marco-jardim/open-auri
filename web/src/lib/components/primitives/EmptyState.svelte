<!--
	EmptyState (spec §2.6, §4.4): a thematic SVG illustration, a title, a sentence on WHY it is
	empty, a primary action and an "o que é isso?" link. Pages pass their own illustration
	(tape box, empty channel strip…); the default is a tape reel drawn in the page accent.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';

	interface Props {
		title: string;
		why: string;
		/** Heading level of the title (default 3). */
		level?: 2 | 3 | 4;
		illustration?: Snippet;
		/** Primary action (usually a Button). */
		action?: Snippet;
		/** Custom "o que é isso?" (FUX.3 Explainer); otherwise a link to `explainHref`. */
		explain?: Snippet;
		explainHref?: string;
		class?: string;
	}

	let {
		title,
		why,
		level = 3,
		illustration,
		action,
		explain,
		explainHref,
		class: className
	}: Props = $props();
	const uid = $props.id();
</script>

<section class={['empty-state', className]} aria-labelledby="{uid}-title">
	<div class="empty-state__art" aria-hidden="true">
		{#if illustration}
			{@render illustration()}
		{:else}
			<svg viewBox="0 0 96 64" width="96" height="64" fill="none" stroke="currentColor">
				<circle cx="24" cy="30" r="18" stroke-width="1.5" />
				<circle cx="24" cy="30" r="5" stroke-width="1.5" />
				<circle cx="72" cy="30" r="18" stroke-width="1.5" />
				<circle cx="72" cy="30" r="5" stroke-width="1.5" />
				<path d="M24 48h48" stroke-width="1.5" />
				<path d="M6 60h84" stroke-width="1" stroke-dasharray="3 4" opacity=".6" />
			</svg>
		{/if}
	</div>
	<svelte:element this={`h${level}`} id="{uid}-title" class="empty-state__title">
		{title}
	</svelte:element>
	<p class="empty-state__why">{why}</p>
	{#if action || explain || explainHref}
		<div class="empty-state__actions">
			{#if action}{@render action()}{/if}
			{#if explain}
				{@render explain()}
			{:else if explainHref}
				<a class="empty-state__explain" href={explainHref}>{m.fux1_what_is_this()}</a>
			{/if}
		</div>
	{/if}
</section>
