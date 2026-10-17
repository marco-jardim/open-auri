<script lang="ts">
	import ChartFrame from '#lib/charts/ChartFrame.svelte';
	import { frequencyLabel, numberLabel } from '#lib/charts/scales.ts';
	import {
		PLOT_FREQUENCIES,
		plotPath,
		plotPeak,
		plotRange,
		plotTicks,
		plotX,
		plotY,
		type PlotLine
	} from './plot.ts';
	interface Props {
		label: string;
		description: string;
		lines: readonly PlotLine[];
		regions?: readonly { fromHz: number; toHz: number }[];
		locale: 'pt-BR' | 'en-US';
		/** Fixed symmetric scale in dB; lines beyond it are clipped at the frame. */
		fixedRange?: number;
		/** Horizontal reference line (the output ceiling) with its visible label. */
		limit?: { db: number; label: string } | null;
		/** Marks the highest point over all lines, prefixed by this label. */
		peakLabel?: string | null;
	}
	let {
		label,
		description,
		lines,
		regions = [],
		locale,
		fixedRange,
		limit = null,
		peakLabel = null
	}: Props = $props();
	const uid = $props.id();
	const range = $derived(fixedRange ?? plotRange(lines));
	const ticks = $derived(plotTicks(range));
	const peak = $derived(peakLabel ? plotPeak(lines) : null);
	const signed = (value: number, digits = 0) =>
		`${value > 0 ? '+' : ''}${numberLabel(value, locale, digits)}`;
	const clampY = (value: number) => Math.min(250, Math.max(20, plotY(value, range)));
</script>

<div class="visor">
	<ChartFrame {label} {description} width={1000} height={290}>
		<defs>
			<clipPath id="{uid}-clip"><rect x="58" y="20" width="900" height="230" /></clipPath>
		</defs>
		<rect x="58" y="20" width="900" height="230" fill="#0b0a09" stroke="#4a4234" />
		{#each ticks as tick (tick)}
			<line
				x1="58"
				x2="958"
				y1={plotY(tick, range)}
				y2={plotY(tick, range)}
				stroke={tick === 0 ? '#bfae8a' : '#73664c'}
				stroke-opacity={tick === 0 ? 0.75 : 0.42}
				stroke-dasharray={tick === 0 ? undefined : '2 4'}
			/>
			<text x="48" y={plotY(tick, range) + 4} text-anchor="end">{signed(tick)}</text>
		{/each}
		{#each PLOT_FREQUENCIES as hz (hz)}
			<line
				x1={plotX(hz)}
				x2={plotX(hz)}
				y1="20"
				y2="250"
				stroke="#73664c"
				stroke-opacity={hz === 1000 || hz === 100 || hz === 10000 ? 0.5 : 0.28}
			/>
			<text x={plotX(hz)} y="270" text-anchor="middle">{frequencyLabel(hz, locale)}</text>
		{/each}
		<text x="958" y="286" text-anchor="end" class="unit">Hz · dB</text>
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
		{#if limit && limit.db >= -range && limit.db <= range}
			<g class="limit">
				<line
					x1="58"
					x2="958"
					y1={plotY(limit.db, range)}
					y2={plotY(limit.db, range)}
					stroke="#e5484d"
					stroke-width="1.5"
					stroke-dasharray="7 4"
				/>
				<text x="952" y={plotY(limit.db, range) - 6} text-anchor="end" fill="#ff9b9e"
					>{limit.label}</text
				>
			</g>
		{/if}
		<g clip-path="url(#{uid}-clip)">
			{#each lines as line (line.name)}
				<path
					d={plotPath(line.values, range)}
					fill="none"
					stroke={line.color}
					stroke-width="2"
					stroke-dasharray={line.dashed ? '6 5' : undefined}><title>{line.name}</title></path
				>
			{/each}
		</g>
		{#if peak}
			<g class="peak" transform="translate({plotX(peak.hz)} {clampY(peak.db)})">
				<path d="M-6 -14 H6 L0 -5 Z" fill="#f2b33d" stroke="#1a1408" />
				<circle r="3.5" fill="none" stroke="#f2b33d" stroke-width="1.5" />
				<text
					y="-19"
					text-anchor={plotX(peak.hz) > 820 ? 'end' : plotX(peak.hz) < 180 ? 'start' : 'middle'}
					fill="#ffe0a0"
					>{peakLabel} {signed(peak.db, 1)} dB · {frequencyLabel(peak.hz, locale)} Hz</text
				>
			</g>
		{/if}
	</ChartFrame>
	<div class="legend">
		{#each lines as line (line.name)}<span><i style:background={line.color}></i>{line.name}</span
			>{/each}
		{#if limit}<span class="limit-key"><i></i>{limit.label}</span>{/if}
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
	.visor :global(text) {
		font-family: var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 5px 16px;
		padding: 8px 3px 2px;
		color: #ddd4c2;
		font-size: var(--fs-caption, 12px);
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
	.limit-key i {
		height: 0;
		border-top: 2px dashed #e5484d;
	}
</style>
