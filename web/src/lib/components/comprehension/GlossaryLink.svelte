<script lang="ts">
	import type { Snippet } from 'svelte';
	import { glossary, type GlossaryTerm } from '#lib/comprehension/glossary.ts';

	let { term, children }: { term: GlossaryTerm; children?: Snippet } = $props();
</script>

<a href={glossary[term].href}>
	{#if children}{@render children()}{:else}{glossary[term].title()}{/if}
</a>

<style>
	a {
		color: var(--accent-text, #ff9a57);
		font-family: var(--face-body, 'Geist', system-ui, sans-serif);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	a:focus-visible {
		outline: 2px solid var(--accent, #ff9a57);
		outline-offset: 3px;
	}
</style>
