<!--
	Always-visible mode label: "AO VIVO" while audio passes through the chain, "DADOS" otherwise.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { MeterMode } from '#lib/audio/meters.ts';

	let { mode, class: className = '' }: { mode: MeterMode; class?: string } = $props();

	const text = $derived(mode === 'live' ? m.meter_mode_live() : m.meter_mode_data());
</script>

<!-- The text content is exactly the mode word; the "meter mode" context lives in the accessible
	name so it is not concatenated into the visible/announced label text. -->
<span
	class="oa-meter-mode {className}"
	data-mode={mode}
	role="status"
	aria-label="{m.meter_mode_label()}: {text}"
>
	{text}
</span>

<style>
	.oa-meter-mode {
		display: inline-block;
		padding: 0.125rem 0.375rem;
		border: 1px solid currentColor;
		border-radius: 0.25rem;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.08em;
		line-height: 1.2;
		color: var(--oa-meter-data, #6b7280);
	}
	.oa-meter-mode[data-mode='live'] {
		color: var(--oa-meter-live, #b91c1c);
	}
</style>
