<script lang="ts">
	import ChartFrame from '#lib/charts/ChartFrame.svelte';
	import { dbScale, logScale, linePath, frequencyLabel, numberLabel } from '#lib/charts/scales.ts';
	import { GRID } from 'open-auri/dsp';
	import { getLocale } from '#lib/paraglide/runtime.js';
	interface Series {
		values: readonly number[];
		label: string;
		color: string;
	}
	let {
		series,
		label,
		description,
		compact = false
	}: {
		series: Series[];
		label: string;
		description: string;
		compact?: boolean;
	} = $props();
	const x = logScale(20, 20000, 58, 784);
	const y = dbScale(-24, 24, 272, 28);
	const paths = $derived(
		series.map((item) => ({
			...item,
			path: linePath(
				item.values.map((value, i) => ({
					x: x(GRID[i]),
					y: y(Math.max(-24, Math.min(24, value)))
				}))
			)
		}))
	);
</script>

<div class:compact>
	<ChartFrame {label} {description} height={320}>
		{#each [20, 100, 1000, 10000, 20000] as hz (hz)}
			<line x1={x(hz)} x2={x(hz)} y1="28" y2="272" stroke="#405448" />
			<text x={x(hz)} y="306" text-anchor={hz === 20 ? 'start' : hz === 20000 ? 'end' : 'middle'}
				>{frequencyLabel(hz, getLocale())}</text
			>
		{/each}
		{#each [-18, 0, 18] as db (db)}
			<line
				x1="58"
				x2="784"
				y1={y(db)}
				y2={y(db)}
				stroke="#405448"
				stroke-dasharray={db ? '3 4' : undefined}
			/>
			<text x="48" y={y(db) + 4} text-anchor="end">{numberLabel(db, getLocale())}</text>
		{/each}
		{#each paths as item (item.label)}
			<path d={item.path} fill="none" stroke={item.color} stroke-width="2" />
		{/each}
	</ChartFrame>
</div>
{#if !compact}
	<div class="legend">
		{#each series as item (item.label)}
			<span><i style:background={item.color}></i>{item.label}</span>
		{/each}
		<span>Hz / dB</span>
	</div>
{/if}

<style>
	.legend {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
		padding: 10px 6px;
		font: 11px var(--font-mono, monospace);
		color: #d4dec8;
	}
	.legend span {
		display: flex;
		gap: 5px;
		align-items: center;
	}
	i {
		display: inline-block;
		width: 15px;
		height: 2px;
	}
	.compact {
		margin-top: 12px;
	}
</style>
