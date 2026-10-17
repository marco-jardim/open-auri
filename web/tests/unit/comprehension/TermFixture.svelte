<script lang="ts">
	import Explainer from '#lib/components/comprehension/Explainer.svelte';
	import type { ExplainerId } from '#lib/comprehension/explainer-titles.ts';
	let { term = 'q', label = 'Q' }: { term?: ExplainerId; label?: string } = $props();
</script>

<!-- An engraved label in running text: the term must take its type and sit flush in the line. -->
<p class="engraved">Antes <Explainer {term} variant="term">{label}</Explainer>, depois</p>
<button type="button">Fora</button>

<style>
	.engraved {
		color: rgb(10, 20, 30);
		font: 600 11px / 1.2 serif;
		letter-spacing: 3px;
		text-transform: uppercase;
	}
</style>
