<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { Trace } from './model.ts';
	let { trace }: { trace: Trace | null } = $props();
</script>

{#if trace?.kind === 'autoeq'}
	<p class="attribution" data-testid="autoeq-attribution">
		<strong>{trace.credit?.source}</strong> · {m.soe_data_credit()}
		{#if trace.credit?.link?.startsWith('https://')}
			<a href={trace.credit.link} target="_blank" rel="noreferrer">{m.soe_source_link()}</a>
		{/if}
	</p>
{/if}

<style>
	.attribution {
		margin: 8px 0;
		font-size: 11px;
		color: #e3e9d8;
		overflow-wrap: anywhere;
	}
	strong {
		font-weight: 550;
	}
	a {
		display: block;
		color: #ffb2d2;
		text-underline-offset: 3px;
	}
	a:focus-visible {
		outline: 2px solid #ff99c4;
		outline-offset: 3px;
	}
</style>
