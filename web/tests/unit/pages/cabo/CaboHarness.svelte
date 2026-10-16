<script lang="ts">
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import CaboPage from '#lib/components/pages/cabo/CaboPage.svelte';
	import { PreWriteChecklist } from '#lib/components/cable/index.ts';

	let { app }: { app: ClientApp } = $props();
	const selected = $derived(app.pendingWrite ?? app.state.curve.current);
</script>

<CaboPage {app} />
<PreWriteChecklist
	service={app.cable}
	open={app.pendingWrite !== null}
	bands={selected.bands}
	preampDb={selected.preampDb}
	name={selected.name}
	experimental={app.experimentalWrite}
	onclose={() => app.closeChecklist()}
	onresult={(outcome) => app.onWriteResult(outcome)}
/>
