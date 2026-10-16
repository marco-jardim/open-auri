<script lang="ts">
	import { GRID } from 'open-auri/dsp';
	import ChartFrame from './ChartFrame.svelte';
	import { errorHeatGeometry } from './diagnostics.ts';
	import { frequencyLabel, numberLabel } from './scales.ts';

	interface Props {
		rows: readonly (readonly number[])[];
		rowLabels: readonly string[];
		label: string;
		description: string;
		grid?: readonly number[];
		limitDb?: number;
		locale?: string;
	}
	let {
		rows,
		rowLabels,
		label,
		description,
		grid = GRID,
		limitDb = 6,
		locale = 'en-US'
	}: Props = $props();
	const cells = $derived(errorHeatGeometry(rows, grid, 620, 36, limitDb));
	const height = $derived(Math.max(100, rows.length * 36 + 64));
</script>

<ChartFrame {label} {description} width={820} {height}>
	{#each rowLabels as row, i (i)}
		<text x="12" y={42 + i * 36}>{row}</text>
	{/each}
	{#each cells as cell (`${cell.row}:${cell.freqHz}`)}
		<rect
			x={180 + cell.x}
			y={20 + cell.y}
			width={cell.width}
			height={cell.height - 2}
			fill={cell.errorDb < 0 ? 'var(--chart-secondary)' : 'var(--chart-accent)'}
			fill-opacity={0.12 + cell.intensity * 0.88}
		>
			<title>
				{rowLabels[cell.row] ?? cell.row + 1}: {frequencyLabel(cell.freqHz, locale)} Hz ·
				{numberLabel(cell.errorDb, locale, 2)} dB
			</title>
		</rect>
	{/each}
	<text x="180" y={height - 18}>20 Hz</text>
	<text x="800" y={height - 18} text-anchor="end">20 kHz</text>
	<text class="chart-alt" x="490" y={height - 18} text-anchor="middle">
		±{numberLabel(limitDb, locale)} dB
	</text>
</ChartFrame>
