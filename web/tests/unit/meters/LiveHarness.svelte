<script lang="ts">
	import type { MeterSource } from '#lib/audio/meters.ts';
	import { LiveMeter, MeterModeLabel, VuMeter } from '#lib/components/meters/index.ts';

	let { source }: { source: MeterSource } = $props();

	const meter = new LiveMeter();
	$effect(() => {
		meter.connect(source);
		return () => meter.disconnect();
	});
</script>

<MeterModeLabel mode={meter.mode} />
<VuMeter mode={meter.mode} live={meter.frame?.vuL ?? null} reducedMotion={false} />
