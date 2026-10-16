<script lang="ts">
	import ChartFrame from './ChartFrame.svelte';
	import { hexBytes, reportTimeline } from './protocol.ts';
	import type { Curve } from './response.ts';

	interface Props {
		curve: Curve;
		label: string;
		description: string;
		commitLabel?: string;
	}
	let { curve, label, description, commitLabel = 'COMMIT' }: Props = $props();
	const timeline = $derived(reportTimeline(curve));
	const x = (ms: number) => 24 + (ms / timeline.totalMs) * 680;
</script>

<ChartFrame {label} {description} width={820} height={240} theme="cable">
	{#each timeline.reports as report (report.index)}
		<g>
			<title>{report.index}: {hexBytes(report.bytes)}</title>
			<rect
				x={24 + report.index * 85.7}
				y="24"
				width="76"
				height="48"
				fill="none"
				stroke="var(--chart-muted)"
			/>
			<rect
				x={24 + report.index * 85.7}
				y="24"
				width={(76 * report.dataBytes) / 30}
				height="48"
				fill="var(--chart-accent)"
				fill-opacity="0.25"
			/>
			<text x={62 + report.index * 85.7} y="54" text-anchor="middle">{report.index}</text>
			<text class="chart-alt" x={62 + report.index * 85.7} y="94" text-anchor="middle">
				{report.dataBytes} B
			</text>
			<line
				x1={x(report.atMs)}
				x2={x(report.atMs)}
				y1="137"
				y2="153"
				stroke="var(--chart-accent)"
			/>
		</g>
	{/each}
	<line
		x1="24"
		x2={x(timeline.reportsEndMs)}
		y1="145"
		y2="145"
		stroke="var(--chart-accent)"
		stroke-width="3"
	/>
	<line
		x1={x(timeline.reportsEndMs)}
		x2={x(timeline.commitAtMs)}
		y1="145"
		y2="145"
		stroke="var(--chart-accent)"
		stroke-dasharray="3 4"
	/>
	<circle cx={x(timeline.commitAtMs)} cy="145" r="4" fill="var(--chart-accent)" />
	<text x="24" y="177">0 ms</text>
	<text x={x(timeline.reportsEndMs)} y="177" text-anchor="middle">144 ms</text>
	<text x={x(timeline.commitAtMs)} y="177" text-anchor="middle">294 ms</text>
	<text x="24" y="126">9 × 16 ms</text>
	<text x={x(219)} y="126" text-anchor="middle">150 ms</text>
	<text x="796" y="216" text-anchor="end">{commitLabel}</text>
	<text class="chart-alt" x="24" y="216">{hexBytes(timeline.commitBytes)}</text>
</ChartFrame>
