<!--
	Panel (spec §2.6): `.panel` (raised ink-3), `.panel--hardware` (the page's material, via
	--panel-material, default ink-4) and `.panel--paper`. Header: eyebrow (mono caps), serif
	title and a slot for the "o que é isso?" explainer. Inside a panel, --muted resolves to the
	brighter --muted-hi so muted text keeps 4.5:1 (T7).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'title'> {
		variant?: 'default' | 'hardware' | 'paper';
		eyebrow?: string;
		title?: string;
		/** Heading level of the title (default 2). */
		level?: 2 | 3 | 4;
		explain?: Snippet;
		children: Snippet;
	}

	let {
		variant = 'default',
		eyebrow,
		title,
		level = 2,
		explain,
		class: className,
		children,
		...rest
	}: Props = $props();
	const uid = $props.id();
	const titleId = `${uid}-title`;
</script>

<section
	{...rest}
	class={['panel', variant !== 'default' && `panel--${variant}`, className]}
	aria-labelledby={title ? titleId : rest['aria-labelledby']}
>
	{#if eyebrow || title || explain}
		<header class="panel__head">
			{#if eyebrow}<p class="panel__eyebrow">{eyebrow}</p>{/if}
			{#if title}
				<svelte:element this={`h${level}`} id={titleId} class="panel__title">{title}</svelte:element
				>
			{/if}
			{#if explain}<div class="panel__explain">{@render explain()}</div>{/if}
		</header>
	{/if}
	{@render children()}
</section>
