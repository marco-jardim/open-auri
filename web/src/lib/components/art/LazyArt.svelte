<!--
	Loads a decorative art layer (FUX.ART) after the page is interactive, so the art never
	weighs on a route's initial JavaScript. The layer is absolutely positioned under the content,
	so arriving later shifts nothing; its entrance reveals start when it is first seen anyway.
	A failed load only logs: the page is complete without its art.
-->
<script lang="ts" generics="P extends Record<string, unknown>">
	import type { Component } from 'svelte';

	interface Props {
		load: () => Promise<{ default: Component<P> }>;
		props?: P;
	}

	let { load, props }: Props = $props();
	let Art = $state.raw<Component<P> | null>(null);

	$effect(() => {
		let alive = true;
		const run = () => {
			load().then(
				(module) => {
					if (alive) Art = module.default;
				},
				(cause: unknown) => console.warn('Decorative art failed to load', cause)
			);
		};
		if (typeof requestIdleCallback === 'function') {
			const handle = requestIdleCallback(run, { timeout: 2000 });
			return () => {
				alive = false;
				cancelIdleCallback(handle);
			};
		}
		const timer = setTimeout(run, 300);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	});
</script>

{#if Art}<Art {...props ?? ({} as P)} />{/if}
