<!-- Test host: a positioned, isolated page root with plain sections, the art as its first child. -->
<script lang="ts">
	import type ComparArt from '#lib/components/art/ComparArt.svelte';
	import type CurvaArt from '#lib/components/art/CurvaArt.svelte';

	let {
		art: Art,
		sections = [180, 400, 220]
	}: { art: typeof CurvaArt | typeof ComparArt; sections?: number[] } = $props();
</script>

<main class="host">
	<Art />
	{#each sections as height, index (index)}
		<section style:height="{height}px">Section {index + 1}</section>
	{/each}
</main>

<style>
	.host {
		position: relative;
		isolation: isolate;
		display: grid;
		gap: 24px;
		width: 1200px;
		padding: 24px 24px 32px;
		background: #0f0f0e;
		color: #ece7dd;
	}
	section {
		background: #1d1c1a;
	}
</style>
