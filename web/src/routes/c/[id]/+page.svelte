<script lang="ts">
	import { getAppContext } from '#lib/app/index.ts';
	import SharedCurve from '#lib/components/pages/shared-curve/SharedCurve.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const context = getAppContext();
	const app = $derived(context.client);
</script>

<SharedCurve curve={data.curve} meta={data.meta} signedIn={data.signedIn} {app} />
