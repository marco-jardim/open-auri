<script lang="ts">
	import { getAppContext, type ClientApp } from '#lib/app/index.ts';
	import { CableBar } from '#lib/components/chrome/index.ts';
	import { PreWriteChecklist } from '#lib/components/cable/index.ts';
	let { onclient }: { onclient: (app: ClientApp) => void } = $props();
	const context = getAppContext();
	const app = $derived(context.client);
	const pending = $derived(app?.pendingWrite);
	$effect(() => {
		if (app) onclient(app);
	});
</script>

<CableBar
	onNeutro={app ? () => app?.loadNeutral() : undefined}
	onPadraoAuri={app ? () => app?.loadAuriDefault() : undefined}
	onWrite={app ? () => app?.requestWrite() : undefined}
/>
{#if app && pending}
	<PreWriteChecklist
		service={app.cable}
		open={true}
		bands={pending.bands}
		preampDb={pending.preampDb}
		name={pending.name}
		experimental={app.experimentalWrite}
		onclose={() => app?.closeChecklist()}
		onresult={(outcome) => app?.onWriteResult(outcome)}
	/>
{/if}
