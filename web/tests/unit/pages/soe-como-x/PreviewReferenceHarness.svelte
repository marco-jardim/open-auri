<script lang="ts">
	import Preview from '#lib/components/pages/soe-como-x/Preview.svelte';
	import type { AudioEngine } from '#lib/audio/engine.ts';
	import type { VuReference } from '#lib/audio/meters.ts';
	import type { CurveData } from '#lib/state/model.ts';

	let {
		audio,
		current,
		candidate
	}: {
		audio: AudioEngine;
		current: CurveData;
		candidate: CurveData;
	} = $props();
	let reference = $state<VuReference>(-18);
</script>

<button type="button" onclick={() => (reference = -14)}>Set VU reference to −14</button>
<Preview {audio} {current} {candidate} {reference} />
