<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';

	interface Props {
		title?: string;
	}

	let { title }: Props = $props();
</script>

<aside class="soon">
	<div class="heading">
		<span class="soon-badge">{m.chrome_soon_badge()}</span>
		{#if title}
			<strong>{title}</strong>
		{/if}
	</div>
	<p>{m.chrome_soon_notice()}</p>
</aside>

<style>
	.soon {
		max-width: 620px;
		padding: 12px 14px;
		border: 1px dashed #57554e;
		border-radius: 3px;
		background: #121211;
		color: #b5afa4;
		font: 11px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
	}

	.heading {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}

	.soon-badge {
		display: inline-block;
		padding: 2px 5px;
		border: 1px solid currentColor;
		font: 600 9px/1.3 var(--mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
	}

	strong {
		color: #ece7dd;
	}

	p {
		margin: 8px 0 0;
	}
</style>
