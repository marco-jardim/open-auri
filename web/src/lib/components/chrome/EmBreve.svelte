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
	/*
	 * Blank panel: dashed control rule, unlit badge (spec §2.2, §2.6). The panel paints its own
	 * dark face, so its text colours carry fallbacks: pages embed it on any material (the Cabo
	 * rack sets a dark engraving colour that would otherwise be inherited).
	 */
	.soon {
		max-width: 620px;
		padding: var(--space-3, 12px) var(--space-4, 16px);
		border: 1px dashed var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-sm, 3px);
		background: #121211;
		color: var(--state-text, #b5afa4);
		font: 400 var(--fs-small, 13px) / var(--lh-small, 1.4)
			var(--face-body, 'Geist', system-ui, sans-serif);
	}

	.heading {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}

	/* Mono label at 500 and the 11 px minimum (was a synthesised 600 at 9 px, T4/T5) */
	.soon-badge {
		display: inline-block;
		padding: 2px 6px;
		border: 1px solid currentColor;
		border-radius: var(--rad-xs, 2px);
		background: var(--lamp-off, rgba(236, 231, 221, 0.1));
		font: 500 var(--label-min, 11px) / var(--lh-caps, 1.35)
			var(--face-data, 'JetBrains Mono', ui-monospace, monospace);
		letter-spacing: var(--tracking-caps, 0.14em);
	}

	strong {
		color: var(--text, #ece7dd);
		font-weight: 600;
	}

	p {
		margin: 8px 0 0;
	}
</style>
