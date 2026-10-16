<script lang="ts">
	import ChartFrame from './ChartFrame.svelte';
	import { poleZeroGeometry } from './plane.ts';
	import type { Curve } from './response.ts';
	import { numberLabel } from './scales.ts';

	interface Props {
		bands: Curve['bands'];
		label: string;
		description: string;
		locale?: string;
	}
	let { bands, label, description, locale = 'en-US' }: Props = $props();
	const sections = $derived(poleZeroGeometry(bands));
	const extent = $derived(
		Math.max(
			1.15,
			...sections.flatMap((s) => [...s.poles, ...s.zeros]).map((p) => Math.hypot(p.x, p.y) * 1.1)
		)
	);
	const scale = $derived(100 / extent);
</script>

<ChartFrame {label} {description} width={300} height={300}>
	<line x1="25" x2="275" y1="145" y2="145" stroke="var(--chart-grid)" />
	<line x1="150" x2="150" y1="20" y2="270" stroke="var(--chart-grid)" />
	<circle
		cx="150"
		cy="145"
		r={scale}
		fill="none"
		stroke="var(--chart-muted)"
		stroke-dasharray="3 4"
	/>
	<text x="266" y="139">Re</text>
	<text x="158" y="25">Im</text>
	<text x={150 + scale} y="161" text-anchor="middle">1</text>
	{#each sections as section (section.index)}
		<g>
			<title>{section.index + 1}: r = {numberLabel(section.radius, locale, 9)}</title>
			{#each section.zeros as zero (zero)}
				<circle
					cx={150 + zero.x * scale}
					cy={145 - zero.y * scale}
					r="4"
					fill="none"
					stroke="var(--chart-secondary)"
					stroke-width="1.5"
				/>
			{/each}
			{#each section.poles as pole (pole)}
				<path
					d={`M${146 + pole.x * scale},${141 - pole.y * scale}l8,8m-8,0l8,-8`}
					stroke="var(--chart-accent)"
					stroke-width="1.5"
				/>
			{/each}
		</g>
	{/each}
	<text x="25" y="288">× / ○</text>
	<text x="275" y="288" text-anchor="end">Q27 · |z| = 1</text>
</ChartFrame>
