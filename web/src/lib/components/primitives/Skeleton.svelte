<!--
	Skeleton (spec §2.6, §5.5): same geometry as the final content (pass its width, height and
	radius) so nothing moves when it arrives (CLS zero). The container carries aria-busy and a
	"Carregando…" for screen readers only; the shimmer (1.2 s) stops under reduced motion.
	Meters never get a skeleton: they show DATA or OFF at once (plan §3.6).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';

	interface Props {
		/** True while the real content is not there yet. */
		loading?: boolean;
		width?: string;
		height?: string;
		radius?: string;
		/** Screen-reader text while loading (default "Carregando…"). */
		label?: string;
		class?: string;
		/** Real content, rendered once loading is false. */
		children?: Snippet;
	}

	let {
		loading = true,
		width,
		height,
		radius,
		label,
		class: className,
		children
	}: Props = $props();
</script>

<div
	class={['skeleton-box', className]}
	aria-busy={loading ? 'true' : 'false'}
	style:width={loading ? width : null}
	style:height={loading ? height : null}
>
	{#if loading}
		<span class="skeleton" style:border-radius={radius} aria-hidden="true"></span>
		<span class="sr-only">{label ?? m.fux1_loading()}</span>
	{:else if children}
		{@render children()}
	{/if}
</div>
