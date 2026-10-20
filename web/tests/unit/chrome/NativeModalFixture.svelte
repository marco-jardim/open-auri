<script lang="ts">
	import type { CableService } from '#lib/cable/service.ts';
	import { NEUTRO } from 'open-auri/catalog';
	import CableBar from '#lib/components/chrome/CableBar.svelte';
	import ConfirmDialog from '#lib/components/chrome/ConfirmDialog.svelte';
	import PreWriteChecklist from '#lib/components/cable/PreWriteChecklist.svelte';

	let { service, onclose }: { service: CableService; onclose: () => void } = $props();
	let checklistOpen = $state(false);
	let confirmationOpen = $state(false);
</script>

<CableBar onWrite={() => (checklistOpen = true)} onHelp={() => (confirmationOpen = true)} />
<PreWriteChecklist
	{service}
	open={checklistOpen}
	{...NEUTRO}
	onclose={() => {
		checklistOpen = false;
		onclose();
	}}
/>
<ConfirmDialog
	bind:open={confirmationOpen}
	title="Help confirmation"
	description="An overlay opened from the menu."
/>
