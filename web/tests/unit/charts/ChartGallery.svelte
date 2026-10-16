<script lang="ts">
	import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
	import ResponseChart from '../../../src/lib/charts/ResponseChart.svelte';
	import MiniCurve from '../../../src/lib/charts/MiniCurve.svelte';
	import PoleZeroPlot from '../../../src/lib/charts/PoleZeroPlot.svelte';
	import ByteMap from '../../../src/lib/charts/ByteMap.svelte';
	import ReportTimeline from '../../../src/lib/charts/ReportTimeline.svelte';
	import PolarDiagram from '../../../src/lib/charts/PolarDiagram.svelte';
	import ErrorHeatMap from '../../../src/lib/charts/ErrorHeatMap.svelte';
	import WiggleTrace from '../../../src/lib/charts/WiggleTrace.svelte';

	let { width = 820 }: { width?: number } = $props();
</script>

<div style={`width:${width}px;max-width:100%`}>
	<ResponseChart
		curve={PADRAO_AURI}
		label="Response"
		description="EQ sum and output including preamp, 20 Hz to 20 kHz."
	/>
	<MiniCurve curve={NEUTRO} label="Thumbnail" description="Neutral response." />
	<PoleZeroPlot
		bands={PADRAO_AURI.bands}
		label="Poles and zeros"
		description="Quantized Q27 roots and the unit circle."
	/>
	<ByteMap
		curve={PADRAO_AURI}
		label="Payload"
		description="14-byte header, 4-byte preamp, ten 20-byte sections and 2-byte CRC."
	/>
	<ReportTimeline
		curve={PADRAO_AURI}
		label="Reports"
		description="Nine reports, each followed by 16 ms, then 150 ms and commit."
	/>
	<PolarDiagram
		curve={PADRAO_AURI}
		label="Polar"
		description="Open-loop response, not the Nyquist stability criterion."
	/>
	<ErrorHeatMap
		rows={[[0, -2, 2]]}
		rowLabels={['A']}
		grid={[20, 1000, 20000]}
		label="Errors"
		description="Signed fit-minus-target error in dB."
	/>
	<WiggleTrace values={[-0.5, 0, 0.5]} label="Trace" description="Three supplied samples." />
</div>
