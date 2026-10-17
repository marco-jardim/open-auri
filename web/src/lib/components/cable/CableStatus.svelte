<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { CableService } from '#lib/cable/service.ts';
	import type { CableState } from '#lib/cable/types.ts';
	import Button from '#lib/components/primitives/Button.svelte';

	interface Props {
		service: CableService;
	}

	let { service }: Props = $props();
	const uid = $props.id();

	let cable = $state.raw<CableState>(untrack(() => service.getState()));
	$effect(() => service.subscribe((next) => (cable = next)));

	const simulated = $derived(cable.mode === 'simulated');
	const statusText = $derived(
		cable.writing
			? m.cable_status_writing()
			: cable.connection === 'connecting'
				? m.cable_status_connecting()
				: cable.connection === 'connected' && cable.deviceLabel !== null
					? m.cable_status_connected({ device: cable.deviceLabel })
					: cable.connection === 'connected' && cable.devices.length > 0
						? m.cable_status_no_target()
						: m.cable_status_disconnected()
	);
	const errorText = $derived(
		cable.error === 'request-failed'
			? m.cable_error_request()
			: cable.error === 'restore-failed'
				? m.cable_error_restore()
				: cable.error === 'journal-failed'
					? m.cable_error_journal()
					: null
	);

	// Unavailable always says why (T8). Each control stays focusable (aria-disabled) and its
	// handler checks the same state again, so a click, Enter or a late change never acts.
	const busyReason = $derived(cable.writing ? m.cabo_fux_busy_writing() : null);
	const connectReason = $derived(
		busyReason ?? (cable.connection === 'connecting' ? m.cabo_fux_connecting() : null)
	);

	// Called directly from the click handler: the browser requires a user gesture for the picker.
	function onConnect() {
		if (connectReason !== null) return;
		void service.connect();
	}

	function onDisconnect() {
		if (busyReason !== null) return;
		void service.disconnect();
	}

	/** Index of the write target, or '' when none is chosen (e.g. several restored cables). */
	const targetIndex = $derived.by(() => {
		const index = cable.device === null ? -1 : cable.devices.indexOf(cable.device);
		return index < 0 ? '' : String(index);
	});
	// Always offer the choice when there is no explicit target, even for a single cable.
	const showSelect = $derived(
		cable.devices.length > 1 || (cable.devices.length > 0 && cable.device === null)
	);

	function onSelect(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		// The target never changes mid-write: refuse, and show the real target again.
		if (busyReason !== null) {
			select.value = targetIndex;
			return;
		}
		const value = select.value;
		if (value === '') return;
		const device = cable.devices[Number(value)];
		if (device !== undefined) service.selectDevice(device);
	}
</script>

<section class="flex flex-col gap-2" aria-label={m.cable_status_label()}>
	<p class="flex flex-wrap items-center gap-2">
		<span
			class="rounded border border-current px-1.5 py-0.5 font-mono text-xs uppercase"
			data-mode={cable.mode}
		>
			{simulated ? m.cable_simulated_badge() : m.cable_mode_real()}
		</span>
		<span role="status" aria-live="polite">{statusText}</span>
	</p>

	{#if simulated}
		<p class="text-sm opacity-80">{m.cable_simulated_hint()}</p>
	{/if}

	{#if showSelect}
		<label class="flex flex-col gap-1 text-sm">
			<span>{m.cable_select_device()}</span>
			<select
				class="rounded border border-current bg-transparent px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2"
				aria-disabled={busyReason ? 'true' : undefined}
				aria-describedby={busyReason ? `${uid}-target-why` : undefined}
				value={targetIndex}
				onmousedown={(event) => {
					if (busyReason) event.preventDefault();
				}}
				onkeydown={(event) => {
					if (busyReason && event.key !== 'Tab') event.preventDefault();
				}}
				onchange={onSelect}
			>
				{#if targetIndex === ''}
					<option value="" disabled>{m.cable_target_choose()}</option>
				{/if}
				{#each cable.deviceLabels as label, index (index)}
					<option value={String(index)}>{label}</option>
				{/each}
			</select>
		</label>
		{#if busyReason}
			<p class="text-sm" id="{uid}-target-why">{busyReason}</p>
		{/if}
	{/if}

	<div class="flex flex-wrap gap-2">
		<Button disabledReason={connectReason} onclick={onConnect}>
			{cable.connection === 'connected' ? m.cable_add() : m.cable_connect()}
		</Button>
		{#if cable.connection === 'connected'}
			<Button disabledReason={busyReason} onclick={onDisconnect}>
				{m.cable_disconnect()}
			</Button>
		{/if}
	</div>

	{#if errorText !== null}
		<p role="alert" class="text-sm">{errorText}</p>
	{/if}
</section>
