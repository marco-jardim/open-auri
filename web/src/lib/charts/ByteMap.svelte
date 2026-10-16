<script lang="ts">
	import ChartFrame from './ChartFrame.svelte';
	import { hexBytes, payloadRegions, WORD_LABELS } from './protocol.ts';
	import type { Curve } from './response.ts';

	interface Props {
		curve: Curve;
		label: string;
		description: string;
		selectedSection?: number;
	}
	let { curve, label, description, selectedSection = 0 }: Props = $props();
	const regions = $derived(payloadRegions(curve));
	const selected = $derived(regions.find((region) => region.section === selectedSection));
	const x = (offset: number) => 24 + (offset * 772) / 220;
</script>

<ChartFrame {label} {description} width={820} height={245} theme="paper">
	<text x="24" y="26">0</text>
	<text x="796" y="26" text-anchor="end">220 B</text>
	{#each regions as region (region.offset)}
		<rect
			x={x(region.offset)}
			y="42"
			width={(region.length * 772) / 220}
			height="44"
			fill={region.kind === 'section' ? 'none' : 'var(--chart-accent)'}
			fill-opacity={region.kind === 'section' ? 1 : 0.2}
			stroke="var(--chart-ink)"
		>
			<title>
				{region.kind} [{region.offset}…{region.offset + region.length - 1}]:
				{hexBytes(region.bytes)}
			</title>
		</rect>
		{#if region.kind === 'section'}
			<text class="chart-alt" x={x(region.offset + 10)} y="69" text-anchor="middle">
				{(region.section ?? 0) + 1}
			</text>
		{/if}
	{/each}
	<text x="24" y="111">HEAD 14 B · Q23 4 B</text>
	<text x="796" y="111" text-anchor="end">10 × 20 B · CRC 2 B</text>
	{#if selected}
		<text x="24" y="144">Q27 / {selectedSection + 1}</text>
		{#each WORD_LABELS as word, i (word)}
			<rect
				x={24 + i * 154.4}
				y="156"
				width="154.4"
				height="40"
				fill="none"
				stroke="var(--chart-ink)"
			/>
			<text x={101.2 + i * 154.4} y="182" text-anchor="middle">{word}</text>
			<text class="chart-alt" x={101.2 + i * 154.4} y="220" text-anchor="middle">
				{hexBytes(selected.bytes.slice(i * 4, i * 4 + 4))}
			</text>
		{/each}
	{/if}
</ChartFrame>
