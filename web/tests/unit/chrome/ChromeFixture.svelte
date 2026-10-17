<script lang="ts">
	import {
		CableBar,
		ConfirmDialog,
		EmBreve,
		Footer,
		HelpOverlay,
		Toast,
		type ToastStore
	} from '#lib/components/chrome/index.ts';

	interface Props {
		store: ToastStore;
		onResult?: (confirmed: boolean) => void;
	}

	let { store, onResult }: Props = $props();
	let confirmOpen = $state(false);
</script>

<CableBar currentPath="/docs" unsaved={true} />
<main>
	<h1>open-auri</h1>
	<label>Curve name <input type="text" /></label>
	<EmBreve title="DSP" />
	<HelpOverlay shortcuts={[{ keys: 'k', description: 'Pause or resume the preview' }]} />
	<button type="button" onclick={() => (confirmOpen = true)}>Open confirmation</button>
	<ConfirmDialog
		bind:open={confirmOpen}
		title="Confirm action"
		description="Review this action before continuing."
		{onResult}
	/>
</main>
<Footer
	honoree={{
		name: 'Robert Moog',
		years: '1934–2005',
		curiosity: 'In 1966, Robert Moog applied for a transistor ladder filter patent.',
		sources: [{ label: 'US 3.475.623', href: 'https://patents.google.com/patent/US3475623A/en' }]
	}}
/>
<Toast {store} />
