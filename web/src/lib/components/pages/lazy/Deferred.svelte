<!--
	Below-the-fold island (FUX.B, spec §5.3/§5.5). Until its chunk is there, it holds the panel's
	box: a static placeholder of the same geometry (`height`, or `aspect` for fixed-ratio scenes),
	so nothing below moves when the panel arrives. The chunk is requested when the box comes within
	`margin` of the viewport, or when the main thread is idle (at the latest after 1.5 s), whichever
	comes first; a failed import (offline before the chunk was cached) is retried on the next
	approach. SSR renders the placeholder; the panel itself only ever renders in the browser.
	Never for meters: those show DADOS or APAGADO at once (plan §0.12, spec §5.5).
-->
<script lang="ts" generics="T">
	import type { Snippet } from 'svelte';
	import type { LazyModule } from '#lib/app/lazy.svelte.ts';
	import { whenIdle } from '#lib/app/runtime.ts';
	import { m } from '#lib/paraglide/messages.js';

	let {
		module,
		height,
		aspect,
		margin = '600px',
		idle = true,
		label,
		children
	}: {
		module: LazyModule<T>;
		/** Reserved block size (CSS length), measured from the panel's own layout. */
		height?: string;
		/** Reserved aspect ratio (e.g. `820 / 245`) for fixed-ratio panels; width is the column's. */
		aspect?: string;
		/** How far ahead of the viewport the chunk starts loading. */
		margin?: string;
		/** Also load on idle (default). Off for heavy panels that only matter once scrolled to. */
		idle?: boolean;
		/** Accessible text of the placeholder; defaults to the shared "Loading" string. */
		label?: string;
		children: Snippet<[T]>;
	} = $props();

	let host: HTMLDivElement | undefined = $state();

	$effect(() => {
		const node = host;
		if (module.current || !node) return;
		const load = () => module.request();
		const observer =
			typeof IntersectionObserver === 'function'
				? new IntersectionObserver(
						(entries) => {
							if (entries.some((entry) => entry.isIntersecting)) load();
						},
						{ rootMargin: `${margin} 0px` }
					)
				: undefined;
		if (observer) observer.observe(node);
		else load();
		const cancel = idle ? whenIdle(load) : () => undefined;
		return () => {
			observer?.disconnect();
			cancel();
		};
	});
</script>

{#if module.current}
	{@render children(module.current)}
{:else}
	<div
		bind:this={host}
		class="deferred"
		aria-busy="true"
		style:min-height={height}
		style:aspect-ratio={aspect}
	>
		<span class="sr-only">{label ?? m.fux1_loading()}</span>
	</div>
{/if}

<style>
	.deferred {
		box-sizing: border-box;
		width: 100%;
		border: 1px dashed var(--rule, rgba(236, 231, 221, 0.16));
		border-radius: var(--rad-md, 6px);
		background: var(--ink-2, transparent);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
		border: 0;
	}
</style>
