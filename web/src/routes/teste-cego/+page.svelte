<script lang="ts">
	import { getAppContext } from '#lib/app/index.ts';
	import { PUBLIC_TURNSTILE_SITE_KEY } from '#lib/config/public.ts';
	import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
	import type { Candidate } from '#lib/components/pages/teste-cego/experiment.ts';
	import { createSocialApi } from '#lib/social/index.ts';
	import { Tour } from '#lib/components/comprehension/index.ts';

	const context = getAppContext();
	const app = $derived(context.client);
	// T4.16: public reads (Comunidade candidates) and the anonymous S6 batch. No request is made
	// until the user asks for a list, sends a batch or deletes one.
	const api = createSocialApi();

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
	{api}
	siteKey={PUBLIC_TURNSTILE_SITE_KEY}
/>
<!-- Steps: cego-prepare (tablist), cego-listen (console), cego-result (stage). The trigger lives
     in the stage header (ListeningRoom); the page-level tour renders the steps. -->
<Tour page="teste-cego" />
