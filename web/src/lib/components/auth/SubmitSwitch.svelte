<!--
	Submit of an auth form: the Button primitive (primary, lg, engraved caps) at the Saída stage
	of the channel strip. The Saída lamp lights when every stage on the strip validates (real
	state from AuthShell); the button never waits for it: the server is the judge. Unavailable
	says why (`disabledReason`, focusable, announced); busy blocks a second submission.
-->
<script lang="ts">
	import { Button, Lamp } from '#lib/components/primitives/index.ts';
	import { getChannel, stageLabel } from './AuthShell.svelte';

	interface Props {
		label: string;
		busyLabel?: string;
		busy?: boolean;
		/** Why the switch cannot be used right now; non-empty makes it unavailable. */
		disabledReason?: string | null;
		/** Name/value pair when a form has several submit buttons. */
		name?: string;
		value?: string;
		formaction?: string;
	}

	let {
		label,
		busyLabel,
		busy = false,
		disabledReason = null,
		name,
		value,
		formaction
	}: Props = $props();

	const channel = getChannel();
	const ready = $derived(channel?.ready ?? false);
</script>

<div class="submit stage-host">
	<span class="stage" data-stage="output" data-on={ready} aria-hidden="true">
		<svg class="stage__knob" viewBox="0 0 22 22" focusable="false">
			<rect
				x="3"
				y="3"
				width="16"
				height="16"
				rx="3"
				fill="#2a313b"
				stroke="currentColor"
				stroke-opacity="0.6"
			/>
			<rect x="7" y="7" width="8" height="8" rx="1.5" fill="#323a45" />
		</svg>
		<span class="stage__name">{stageLabel('output')}</span>
		<Lamp on={ready} tone="ok" />
	</span>
	<Button
		type="submit"
		variant="primary"
		size="lg"
		caps
		class="switch"
		{name}
		{value}
		{formaction}
		loading={busy}
		{disabledReason}
	>
		{busy && busyLabel ? busyLabel : label}
	</Button>
</div>

<style>
	.submit {
		margin-top: 18px;
	}

	.submit :global(.switch) {
		width: 100%;
		min-height: 46px;
	}
</style>
