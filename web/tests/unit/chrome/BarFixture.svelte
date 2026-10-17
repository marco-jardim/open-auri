<!--
	The FUX.NAV bar as the root layout wires it, without the runtime: a status trigger with a
	lamp and a short label, the anonymous account entry, the help trigger, and the callbacks.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { AccountEntry, CableBar } from '#lib/components/chrome/index.ts';
	import { IconButton, Lamp } from '#lib/components/primitives/index.ts';

	interface Props {
		currentPath?: string;
		onNeutro?: () => void;
		onPadraoAuri?: () => void;
		onWrite?: () => void;
		onAudio?: () => void;
		onHelp?: () => void;
	}

	let { currentPath = '/', onNeutro, onPadraoAuri, onWrite, onAudio, onHelp }: Props = $props();
</script>

<CableBar {currentPath} {onNeutro} {onPadraoAuri} {onWrite} {onAudio} {onHelp}>
	{#snippet status()}
		<button
			type="button"
			class="status-trigger btn btn--ghost btn--sm btn--bar"
			popovertarget="bar-fixture-status"
		>
			<Lamp on={false} tone="ok" />
			<span class="status-short" aria-hidden="true">{m.fuxnav_cable_off()}</span>
			<span class="sr-only">{m.cable_status_disconnected()}</span>
		</button>
	{/snippet}
	{#snippet account()}
		<AccountEntry user={null} {currentPath} />
	{/snippet}
	{#snippet help()}
		<span class="help-slot">
			<IconButton
				size="sm"
				variant="plate"
				class="help-btn btn--bar"
				label={m.chrome_help_open()}
				aria-haspopup="dialog"
				onclick={() => onHelp?.()}>?</IconButton
			>
		</span>
	{/snippet}
</CableBar>
<div id="bar-fixture-status" popover="auto">{m.cable_status_disconnected()}</div>

<style>
	.help-slot {
		display: contents;
	}
</style>
