<script lang="ts">
	let { text }: { text: string } = $props();
	const tokens = $derived.by(() => {
		const occurrences: Record<string, number> = {};
		return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^)]+\))/g).map((token) => {
			const occurrence = occurrences[token] ?? 0;
			occurrences[token] = occurrence + 1;
			return { token, key: `${token}:${occurrence}` };
		});
	});
</script>

{#each tokens as { token, key } (key)}
	{#if token.startsWith('**') && token.endsWith('**')}<strong>{token.slice(2, -2)}</strong>
	{:else if token.startsWith('`') && token.endsWith('`')}<code>{token.slice(1, -1)}</code>
	{:else if /^\[[^\]]+\]\(https:\/\/[^)]+\)$/.test(token)}
		<a href={token.slice(token.indexOf('](') + 2, -1)}>{token.slice(1, token.indexOf(']('))}</a>
	{:else}{token}{/if}
{/each}

<style>
	a {
		color: #8c2f2f;
		text-underline-offset: 3px;
		overflow-wrap: anywhere;
	}
	code {
		font: 0.8em var(--font-mono, monospace);
		overflow-wrap: anywhere;
	}
	a:focus-visible {
		outline: 2px solid #8c2f2f;
		outline-offset: 3px;
	}
</style>
