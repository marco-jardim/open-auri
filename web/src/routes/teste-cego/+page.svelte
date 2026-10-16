<script lang="ts">
	import { getAppContext } from '#lib/app/index.ts';
	import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
	import type { Candidate } from '#lib/components/pages/teste-cego/experiment.ts';

	const context = getAppContext();
	const app = $derived(context.client);

	function openCurve(value: Candidate) {
		return (
			app?.state.curve.set({
				name: value.name,
				source: 'custom',
				bands: value.bands,
				preampDb: value.preampDb
			}) ?? false
		);
	}
</script>

<BlindTest
	audio={app?.audio ?? null}
	current={app?.state.curve.current ?? null}
	onopen={openCurve}
/>
