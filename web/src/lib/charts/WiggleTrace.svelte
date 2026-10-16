<script lang="ts">
	import ChartFrame from './ChartFrame.svelte';
	import { wiggleGeometry } from './diagnostics.ts';

	interface Props {
		values: readonly number[];
		label: string;
		description: string;
		range?: number;
	}
	let { values, label, description, range = 1 }: Props = $props();
	const geometry = $derived(wiggleGeometry(values, 720, 100, range));
</script>

<ChartFrame {label} {description} width={720} height={100} theme="cable">
	<line x1="0" x2="720" y1={geometry.baseline} y2={geometry.baseline} stroke="var(--chart-grid)" />
	<path d={geometry.path} fill="none" stroke="var(--chart-accent)" stroke-width="1.5" />
</ChartFrame>
