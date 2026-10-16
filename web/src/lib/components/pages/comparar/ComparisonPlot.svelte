<script lang="ts">
	import ChartFrame from '#lib/charts/ChartFrame.svelte';
	import { frequencyLabel, numberLabel } from '#lib/charts/scales.ts';
	import { plotPath, plotRange, plotX, type PlotLine } from './plot.ts';
	interface Props {
		label: string;
		description: string;
		lines: readonly PlotLine[];
		regions?: readonly { fromHz: number; toHz: number }[];
		locale: 'pt-BR' | 'en-US';
	}
	let { label, description, lines, regions = [], locale }: Props = $props();
	const range = $derived(plotRange(lines));
</script>

<div class="visor">
	<ChartFrame {label} {description} width={1000} height={290}>
		{#each [-1, -0.5, 0, 0.5, 1] as fraction (fraction)}
			<line
				x1="58"
				x2="958"
				y1={135 - fraction * 115}
				y2={135 - fraction * 115}
				stroke="#73664c"
				stroke-opacity=".4"
			/>
			<text x="48" y={139 - fraction * 115} text-anchor="end"
				>{numberLabel(fraction * range, locale)} dB</text
			>
		{/each}
		{#each [20, 100, 1000, 10000, 20000] as hz (hz)}
			<line x1={plotX(hz)} x2={plotX(hz)} y1="20" y2="250" stroke="#73664c" stroke-opacity=".3" />
			<text x={plotX(hz)} y="276" text-anchor="middle">{frequencyLabel(hz, locale)}</text>
		{/each}
		{#each regions as region (region.fromHz)}
			<rect
				x={plotX(region.fromHz)}
				y="20"
				width={Math.max(2, plotX(region.toHz) - plotX(region.fromHz))}
				height="230"
				fill="#f2b33d"
				opacity=".12"
			/>
		{/each}
		{#each lines as line (line.name)}
			<path
				d={plotPath(line.values, range)}
				fill="none"
				stroke={line.color}
				stroke-width="2"
				stroke-dasharray={line.dashed ? '6 5' : undefined}><title>{line.name}</title></path
			>
		{/each}
	</ChartFrame>
	<div class="legend">
		{#each lines as line (line.name)}<span><i style:background={line.color}></i>{line.name}</span
			>{/each}
	</div>
</div>

<style>
	.visor {
		min-width: 0;
		padding: 8px;
		border: 1px solid #080706;
		border-radius: 8px;
		background: #100f0e;
		box-shadow: inset 0 2px 12px #000b;
	}
	.visor :global(.chart) {
		--chart-surface: #100f0e;
		--chart-ink: #e9dfca;
		--chart-grid: #37332b;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 5px 16px;
		padding: 8px 3px 2px;
		color: #ddd4c2;
		font-size: 12px;
	}
	.legend span {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	i {
		display: inline-block;
		width: 18px;
		height: 3px;
	}
</style>
