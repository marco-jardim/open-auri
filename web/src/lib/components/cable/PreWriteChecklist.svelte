<script lang="ts">
	import { untrack } from 'svelte';
	import { gateForWrite } from 'open-auri/safety';
	import { m } from '#lib/paraglide/messages.js';
	import type { CableService } from '#lib/cable/service.ts';
	import type {
		Band,
		CableState,
		ChecklistResult,
		Confirmations,
		GateResult,
		QueueOutcome,
		WriteOutcome
	} from '#lib/cable/types.ts';
	import MultiCableQueue from './MultiCableQueue.svelte';
	import {
		describeOutcome,
		describeReason,
		formatCrc,
		formatNumber,
		lampLabel,
		lampState
	} from './i18n.ts';

	interface Props {
		service: CableService;
		/** Controlled by the parent; the dialog opens modally while true. */
		open: boolean;
		bands: readonly Band[];
		preampDb: number;
		/** Lets the gate accept HS/LP/HP; the experimental confirmation is then required. */
		experimental?: boolean;
		/** Curve name stored in the journal. */
		name?: string;
		onclose: () => void;
		onresult?: (outcome: WriteOutcome | QueueOutcome) => void;
	}

	let {
		service,
		open,
		bands,
		preampDb,
		experimental = false,
		name = '',
		onclose,
		onresult
	}: Props = $props();

	const UNCONFIRMED: Confirmations = {
		volumeLowered: false,
		keepConnected: false,
		experimental: false
	};

	let cable = $state.raw<CableState>(untrack(() => service.getState()));
	$effect(() => service.subscribe((next) => (cable = next)));

	const id = $props.id();
	let dialog = $state<HTMLDialogElement>();
	let confirmations = $state<Confirmations>({ ...UNCONFIRMED });
	/** Re-evaluates the time-dependent items (2 s spacing countdown). */
	let tick = $state(0);
	let message = $state<string | null>(null);

	// The gate runs only while the dialog is open; write() always re-gates on its own.
	const gate = $derived<GateResult | null>(
		open ? gateForWrite(bands, preampDb, { experimental }) : null
	);
	const checklist = $derived.by<ChecklistResult | null>(() => {
		void tick;
		void cable;
		if (gate === null) return null;
		return service.checklist(
			{ bands, preampDb, experimental, confirmations: { ...confirmations } },
			gate
		);
	});

	$effect(() => {
		if (checklist === null) return;
		const wait = checklist.spacing.waitMs;
		if (wait <= 0) return;
		const timer = setTimeout(() => (tick += 1), Math.min(wait, 200));
		return () => clearTimeout(timer);
	});

	$effect(() => {
		if (dialog === undefined) return;
		if (open && !dialog.open) {
			untrack(() => {
				confirmations = { ...UNCONFIRMED };
				message = null;
			});
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});

	/** Index of the write target in `devices`, or '' when none is chosen (explicit choice needed). */
	const targetIndex = $derived.by(() => {
		const index = cable.device === null ? -1 : cable.devices.indexOf(cable.device);
		return index < 0 ? '' : String(index);
	});
	/** Label of the cable `write()` will use, shown next to the write button. */
	const targetLabel = $derived(
		cable.device === null
			? null
			: (cable.deviceLabel ?? cable.deviceLabels[cable.devices.indexOf(cable.device)] ?? null)
	);

	/** Selecting a target never writes: the write button still needs its own click. */
	function onSelectTarget(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		if (value === '') return;
		const device = cable.devices[Number(value)];
		if (device !== undefined) service.selectDevice(device);
	}

	function onCancel(event: Event) {
		// Never close the dialog in the middle of a write.
		if (cable.writing) event.preventDefault();
	}

	function finish(outcome: WriteOutcome | QueueOutcome) {
		message = describeOutcome(outcome);
		// Every write needs fresh confirmations.
		if (outcome.status !== 'refused') confirmations = { ...UNCONFIRMED };
		onresult?.(outcome);
	}

	// The gesture token is minted synchronously, inside this click/keypress handler.
	async function onWrite(event: MouseEvent) {
		const gesture = service.createGesture(event);
		const outcome = await service.write({
			bands,
			preampDb,
			experimental,
			confirmations: { ...confirmations },
			gesture,
			name
		});
		finish(outcome);
	}

	const lampColor = (state: string) =>
		state === 'ok' ? 'bg-green-600' : state === 'fail' ? 'bg-red-600' : 'bg-gray-400';
</script>

<dialog
	bind:this={dialog}
	aria-labelledby={`${id}-title`}
	class="m-auto max-h-[90vh] w-full max-w-xl overflow-y-auto rounded border border-current bg-[Canvas] p-4 text-[CanvasText] backdrop:bg-black/60"
	oncancel={onCancel}
	onclose={() => onclose()}
>
	{#if checklist !== null}
		<div class="flex flex-col gap-4">
			<header class="flex items-baseline justify-between gap-4">
				<h2 id={`${id}-title`} class="text-lg font-semibold">{m.cable_checklist_title()}</h2>
				{#if cable.mode === 'simulated'}
					<span class="rounded border border-current px-1.5 font-mono text-xs uppercase">
						{m.cable_simulated_badge()}
					</span>
				{/if}
			</header>

			<section aria-labelledby={`${id}-gate`}>
				<h3 id={`${id}-gate`} class="font-semibold">{m.cable_checklist_gate_heading()}</h3>
				<ul class="mt-1 flex flex-col gap-1">
					{#each checklist.lamps as lamp (lamp.id)}
						<li class="flex flex-col" data-lamp={lamp.id} data-state={lamp.state}>
							<span class="flex items-center gap-2">
								<span
									class={`inline-block h-3 w-3 shrink-0 rounded-full ${lampColor(lamp.state)}`}
									aria-hidden="true"
								></span>
								<span>{lampLabel[lamp.labelKey]()}</span>
								<span class="ml-auto font-mono text-xs">{lampState[lamp.state]()}</span>
							</span>
							{#if lamp.reasons.length > 0}
								<ul class="ml-5 list-disc pl-4 text-sm">
									{#each lamp.reasons as reason, index (index)}
										<li>{describeReason(reason)}</li>
									{/each}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
				{#if checklist.crc !== null}
					<p class="mt-1 font-mono text-xs">{m.cable_crc({ crc: formatCrc(checklist.crc) })}</p>
				{/if}
			</section>

			{#if checklist.loudness.warn}
				<section aria-labelledby={`${id}-loudness`} class="rounded border-2 border-current p-2">
					<h3 id={`${id}-loudness`} class="font-semibold">{m.cable_loudness_heading()}</h3>
					<p>{m.cable_loudness_warning()}</p>
					{#if checklist.loudness.reasons.includes('jump') && checklist.loudness.deltaDb !== null}
						<p class="text-sm">
							{m.cable_loudness_jump({ delta: formatNumber(checklist.loudness.deltaDb, 1, true) })}
						</p>
					{/if}
					{#if checklist.loudness.reasons.includes('unknown-state')}
						<p class="text-sm">{m.cable_loudness_unknown()}</p>
					{/if}
				</section>
			{/if}

			{#if checklist.experimentalRequired}
				<section aria-labelledby={`${id}-experimental`} class="rounded border border-current p-2">
					<h3 id={`${id}-experimental`} class="font-semibold">
						{m.cable_experimental_heading()}
					</h3>
					<p>{m.cable_experimental_text()}</p>
				</section>
			{/if}

			<fieldset class="flex flex-col gap-1" disabled={cable.writing}>
				<legend class="font-semibold">{m.cable_confirmations_heading()}</legend>
				<label class="flex items-center gap-2">
					<input
						type="checkbox"
						class="focus-visible:outline-2 focus-visible:outline-offset-2"
						bind:checked={confirmations.volumeLowered}
					/>
					<span>{m.cable_confirm_volume()}</span>
				</label>
				<label class="flex items-center gap-2">
					<input
						type="checkbox"
						class="focus-visible:outline-2 focus-visible:outline-offset-2"
						bind:checked={confirmations.keepConnected}
					/>
					<span>{m.cable_confirm_connection()}</span>
				</label>
				{#if checklist.experimentalRequired}
					<label class="flex items-center gap-2">
						<input
							type="checkbox"
							class="focus-visible:outline-2 focus-visible:outline-offset-2"
							bind:checked={confirmations.experimental}
						/>
						<span>{m.cable_confirm_experimental()}</span>
					</label>
				{/if}
			</fieldset>

			<section aria-labelledby={`${id}-counters`} class="flex flex-col gap-1">
				<h3 id={`${id}-counters`} class="font-semibold">{m.cable_counters_heading()}</h3>
				<dl class="grid grid-cols-3 gap-2 text-center">
					<div>
						<dt class="text-xs">{m.cable_counter_session()}</dt>
						<dd class="font-mono">{checklist.counters.session}</dd>
					</div>
					<div>
						<dt class="text-xs">{m.cable_counter_day()}</dt>
						<dd class="font-mono">{checklist.counters.day}</dd>
					</div>
					<div>
						<dt class="text-xs">{m.cable_counter_total()}</dt>
						<dd class="font-mono">{checklist.counters.total}</dd>
					</div>
				</dl>
				<p class="text-sm" aria-live="polite">
					{checklist.spacing.ok
						? m.cable_spacing_ready()
						: m.cable_spacing_wait({ seconds: formatNumber(checklist.spacing.waitMs / 1000, 1) })}
				</p>
				{#if checklist.dailyNotice.show}
					<p class="text-sm" role="note">{m.cable_flash_notice()}</p>
				{/if}
			</section>

			{#if cable.devices.length > 1}
				<MultiCableQueue
					{service}
					{bands}
					{preampDb}
					{experimental}
					{name}
					confirmations={{ ...confirmations }}
					canWrite={checklist.canWrite}
					onresult={finish}
				/>
			{/if}

			<section aria-labelledby={`${id}-target`} class="flex flex-col gap-1">
				<h3 id={`${id}-target`} class="font-semibold">{m.cable_target_heading()}</h3>
				{#if cable.devices.length === 0}
					<p class="text-sm">{m.cable_refused_no_device()}</p>
				{:else}
					{#if targetLabel !== null}
						<p class="font-mono text-sm" data-target-device>
							{m.cable_target_device({ device: targetLabel })}
						</p>
					{:else}
						<p class="text-sm" role="note">{m.cable_target_required()}</p>
					{/if}
					{#if cable.devices.length > 1 || targetIndex === ''}
						<label class="flex flex-col gap-1 text-sm">
							<span>{m.cable_select_device()}</span>
							<select
								class="rounded border border-current bg-transparent px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2"
								disabled={cable.writing}
								value={targetIndex}
								onchange={onSelectTarget}
							>
								{#if targetIndex === ''}
									<option value="" disabled>{m.cable_target_choose()}</option>
								{/if}
								{#each cable.deviceLabels as label, index (index)}
									<option value={String(index)}>{label}</option>
								{/each}
							</select>
						</label>
					{/if}
				{/if}
			</section>

			{#if !checklist.canWrite}
				<p class="text-sm">{m.cable_write_blocked()}</p>
			{/if}
			{#if message !== null}
				<p role="status" class="text-sm">{message}</p>
			{/if}

			<footer class="flex flex-wrap justify-end gap-2">
				<button
					type="button"
					class="rounded border border-current px-3 py-1 focus-visible:outline-2 focus-visible:outline-offset-2"
					disabled={cable.writing}
					onclick={() => onclose()}
				>
					{m.cable_close()}
				</button>
				<button
					type="button"
					class="rounded border-2 border-current px-3 py-1 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
					disabled={!checklist.canWrite || cable.writing || cable.device === null}
					onclick={onWrite}
				>
					{cable.mode === 'simulated' ? m.cable_write_simulated() : m.cable_write()}
				</button>
			</footer>
		</div>
	{/if}
</dialog>
