<script lang="ts">
	import {
		CorrelationMeter,
		LedLadder,
		LoudnessReadout,
		MeterModeLabel,
		PeakLamp,
		PpmBar,
		SpectrumOverlay,
		VuMeter
	} from '#lib/components/meters/index.ts';
</script>

<MeterModeLabel mode="data" />
<VuMeter mode="data" />
<VuMeter mode="data" data={-3} class="vu-with-data" />
<LedLadder mode="data" />
<LedLadder mode="data" data={-12} />
<PpmBar mode="data" />
<PpmBar mode="data" data={-20} />
<CorrelationMeter mode="data" />
<PeakLamp mode="data" />
<PeakLamp mode="data" data={-0.5} />
<LoudnessReadout mode="data" />
<LoudnessReadout mode="data" data={{ lufsM: -14, lufsS: -15 }} />
<SpectrumOverlay mode="data" />
