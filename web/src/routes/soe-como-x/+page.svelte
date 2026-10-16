<script lang="ts">
	import { getAppContext } from '#lib/app/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import Workstation from '#lib/components/pages/soe-como-x/Workstation.svelte';
	import type { CurveData } from '#lib/state/model.ts';
	const context = getAppContext();
	const app = $derived(context.client);
	function useCurve(curve: CurveData) {
		const loaded = app?.state.curve.set(curve) ?? false;
		if (loaded) app?.toasts.push(m.soe_used());
		return loaded;
	}
</script>

<svelte:head>
	<title>{m.soe_title()} X · open-auri</title>
	<meta name="description" content={m.soe_lede()} />
</svelte:head>

<Workstation
	current={app?.state.curve.current ?? null}
	audio={app?.audio ?? null}
	reference={app?.state.meterRef.value ?? -18}
	onuse={useCurve}
/>
