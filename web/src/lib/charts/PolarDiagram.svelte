<script lang="ts">
	import ChartFrame from './ChartFrame.svelte';
	import { polarGeometry, polarResponse } from './plane.ts';
	import type { Curve } from './response.ts';

	interface Props {
		curve: Curve;
		label: string;
		/** Include the open-loop / not-a-Nyquist-stability-test caveat here. */
		description: string;
	}
	let { curve, label, description }: Props = $props();
	const samples = $derived(polarResponse(curve));
	const geometry = $derived(polarGeometry(samples));
</script>

<ChartFrame {label} {description} width={480} height={320} theme="paper">
	{#each [0.25, 0.5, 1] as radius (radius)}
		<circle
			cx="240"
			cy="160"
			r={radius * geometry.scale}
			fill="none"
			stroke="var(--chart-grid)"
			stroke-dasharray="2 4"
		/>
	{/each}
	<line x1="25" x2="455" y1="160" y2="160" stroke="var(--chart-grid)" />
	<line x1="240" x2="240" y1="30" y2="290" stroke="var(--chart-grid)" />
	<text x="447" y="151">Re</text>
	<text x="250" y="35">Im</text>
	<circle cx={240 - geometry.scale} cy="160" r="3" fill="var(--chart-accent)" />
	<text x={240 - geometry.scale} y="180" text-anchor="middle">(−1, 0)</text>
	<path
		d={geometry.negative}
		stroke="var(--chart-secondary)"
		stroke-width="1.5"
		stroke-dasharray="3 4"
		fill="none"
	/>
	<path d={geometry.positive} stroke="var(--chart-accent)" stroke-width="1.8" fill="none" />
	<text x="24" y="22">H(eʲω) · Q27 / Q23</text>
	<text x="456" y="310" text-anchor="end">0…48 kHz</text>
</ChartFrame>
