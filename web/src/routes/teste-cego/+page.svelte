<script lang="ts">
	import { onMount } from 'svelte';
	import { getAppContext } from '#lib/app/index.ts';
	import { PUBLIC_TURNSTILE_SITE_KEY } from '#lib/config/public.ts';
	import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
	import type { Candidate } from '#lib/components/pages/teste-cego/experiment.ts';
	import type { SocialApi } from '#lib/social/index.ts';
	import { loadSocialRuntime } from '#lib/social/runtime.ts';
	import { Tour } from '#lib/components/comprehension/index.ts';

	const context = getAppContext();
	const app = $derived(context.client);
	// T4.16: public reads (Comunidade candidates) and the anonymous S6 batch. No request is made
	// until the user asks for a list, sends a batch or deletes one. FUX.B: the client comes from
	// the social runtime chunk the layout already loads on instrument routes (only the social tabs,
	// not the first one, use it); until then, and offline, BlindTest shows no social controls.
	let api = $state.raw<SocialApi | null>(null);
	onMount(() => {
		let live = true;
		loadSocialRuntime().then(
			(social) => {
				if (live) api = social.createSocialApi();
			},
			(error: unknown) => console.warn('The social client could not load', error)
		);
		return () => {
			live = false;
		};
	});

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
