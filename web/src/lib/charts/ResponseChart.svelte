<script lang="ts">
	import ChartFrame from './ChartFrame.svelte';
	import { responseGeometry, type Curve } from './response.ts';
	import { dbTicks, FREQUENCY_TICKS, frequencyLabel, numberLabel, RESPONSE_BOX } from './scales.ts';

	interface Props {
		curve: Curve;
		label: string;
		description: string;
		minDb?: number;
		maxDb?: number;
		tickStepDb?: number;
		locale?: string;
		eqLabel?: string;
		outputLabel?: string;
		theme?: 'scope' | 'paper' | 'cable';
	}
	let {
		curve,
		label,
		description,
		minDb = -24,
		maxDb = 12,
		tickStepDb = 6,
		locale = 'en-US',
		eqLabel = 'EQ',
		outputLabel = 'OUT',
		theme = 'scope'
	}: Props = $props();
	const geometry = $derived(responseGeometry(curve, RESPONSE_BOX, minDb, maxDb));
	const ticks = $derived(dbTicks(minDb, maxDb, tickStepDb));
</script>

<ChartFrame {label} {description} {theme}>
	{#each FREQUENCY_TICKS as frequency (frequency)}
		<line
			x1={geometry.x(frequency)}
			x2={geometry.x(frequency)}
			y1="20"
			y2="330"
			stroke="var(--chart-grid)"
		/>
		<text
			class:chart-alt={[50, 200, 2000, 5000, 10000].includes(frequency)}
			x={geometry.x(frequency)}
			y="353"
			text-anchor={frequency === 20 ? 'start' : frequency === 20000 ? 'end' : 'middle'}
			>{frequencyLabel(frequency, locale)}</text
		>
	{/each}
	{#each ticks as db (db)}
		<line
			x1="66"
			x2="788"
			y1={geometry.y(db)}
			y2={geometry.y(db)}
			stroke="var(--chart-grid)"
			stroke-dasharray={db === 0 ? undefined : '2 4'}
		/>
		<text x="58" y={geometry.y(db) + 4} text-anchor="end">{numberLabel(db, locale)}</text>
	{/each}
	<path
		d={geometry.eqPath}
		fill="none"
		stroke="var(--chart-secondary)"
		stroke-width="1.5"
		stroke-dasharray="5 3"
	/>
	<path d={geometry.outputPath} fill="none" stroke="var(--chart-accent)" stroke-width="2" />
	<text x="650" y="371" text-anchor="end">dB</text>
	<text x="788" y="371" text-anchor="end">Hz</text>
	<line x1="70" x2="95" y1="367" y2="367" stroke="var(--chart-secondary)" stroke-dasharray="5 3" />
	<text x="104" y="371">{eqLabel}</text>
	<line x1="250" x2="275" y1="367" y2="367" stroke="var(--chart-accent)" />
	<text x="284" y="371">{outputLabel}</text>
</ChartFrame>
