<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { CableService } from '#lib/cable/service.ts';
	import type {
		Band,
		CableDevice,
		CableState,
		Confirmations,
		QueueOutcome
	} from '#lib/cable/types.ts';
	import { describeOutcome, queueStatus } from './i18n.ts';

	interface Props {
		service: CableService;
		bands: readonly Band[];
		preampDb: number;
		experimental: boolean;
		confirmations: Confirmations;
		/** From the checklist: the queue button stays disabled until every item passes. */
		canWrite: boolean;
		name?: string;
		onresult?: (outcome: QueueOutcome) => void;
	}

	let {
		service,
		bands,
		preampDb,
		experimental,
		confirmations,
		canWrite,
		name = '',
		onresult
	}: Props = $props();

	let cable = $state.raw<CableState>(untrack(() => service.getState()));
	/** The queue exactly as reviewed (what the confirmation sends); null outside review. */
	let reviewed = $state.raw<readonly CableDevice[] | null>(null);
	/** Connected cables when the review started (plain: compared, never rendered). */
	let reviewedFrom: readonly CableDevice[] | null = null;
	let message = $state<string | null>(null);

	function sameDevices(a: readonly CableDevice[], b: readonly CableDevice[]): boolean {
		return a.length === b.length && a.every((device, index) => device === b[index]);
	}

	$effect(() =>
		service.subscribe((next) => {
			// A cable plugged or unplugged during review never joins/leaves it silently.
			if (reviewedFrom !== null && !sameDevices(next.devices, reviewedFrom)) {
				endReview();
				message = m.cable_queue_changed();
			}
			cable = next;
		})
	);

	const headingId = $props.id();
	/** Devices left out of the queue (all connected cables are in it by default). */
	let excluded = $state.raw<CableDevice[]>([]);

	const selected = $derived(cable.devices.filter((device) => !excluded.includes(device)));
	const labelOf = (device: CableDevice) => cable.deviceLabels[cable.devices.indexOf(device)] ?? '';

	function startReview() {
		reviewedFrom = cable.devices.slice();
		reviewed = selected.slice();
		message = null;
	}

	function endReview() {
		reviewedFrom = null;
		reviewed = null;
	}

	function toggle(device: CableDevice, checked: boolean) {
		excluded = checked
			? excluded.filter((candidate) => candidate !== device)
			: [...excluded, device];
		endReview();
	}

	// One gesture (this click) authorizes the whole, explicitly reviewed queue: exactly that list.
	async function confirmQueue(event: MouseEvent) {
		const devices = reviewed;
		if (devices === null) return;
		const gesture = service.createGesture(event);
		endReview();
		const outcome = await service.writeQueue({
			devices: devices.slice(),
			bands,
			preampDb,
			experimental,
			confirmations: { ...confirmations },
			gesture,
			name
		});
		message = describeOutcome(outcome);
		onresult?.(outcome);
	}
</script>

<section aria-labelledby={headingId} class="flex flex-col gap-2">
	<h3 id={headingId} class="font-semibold">{m.cable_queue_title()}</h3>
	<p class="text-sm opacity-80">{m.cable_queue_hint()}</p>

	{#if cable.devices.length < 2}
		<p class="text-sm">{m.cable_queue_need_two()}</p>
	{:else if reviewed === null}
		<fieldset class="flex flex-col gap-1" disabled={cable.writing}>
			<legend class="text-sm">{m.cable_queue_select()}</legend>
			{#each cable.devices as device, index (device)}
				<label class="flex items-center gap-2">
					<input
						type="checkbox"
						class="focus-visible:outline-2 focus-visible:outline-offset-2"
						checked={!excluded.includes(device)}
						onchange={(event) => toggle(device, event.currentTarget.checked)}
					/>
					<span>{cable.deviceLabels[index]}</span>
				</label>
			{/each}
		</fieldset>
		<button
			type="button"
			class="self-start rounded border border-current px-3 py-1 focus-visible:outline-2 focus-visible:outline-offset-2"
			disabled={!canWrite || cable.writing || selected.length < 2}
			onclick={startReview}
		>
			{m.cable_queue_review()}
		</button>
	{:else}
		<h4 class="text-sm font-semibold">{m.cable_queue_confirm_heading()}</h4>
		<ol class="list-decimal pl-6">
			{#each reviewed as device (device)}
				<li>{labelOf(device)}</li>
			{/each}
		</ol>
		<div class="flex flex-wrap gap-2">
			<button
				type="button"
				class="rounded border-2 border-current px-3 py-1 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2"
				disabled={!canWrite || cable.writing || reviewed.length < 2}
				onclick={confirmQueue}
			>
				{m.cable_queue_confirm({ count: String(reviewed.length) })}
			</button>
			<button
				type="button"
				class="rounded border border-current px-3 py-1 focus-visible:outline-2 focus-visible:outline-offset-2"
				disabled={cable.writing}
				onclick={endReview}
			>
				{m.cable_queue_back()}
			</button>
		</div>
	{/if}

	{#if cable.queue !== null}
		<ol class="flex flex-col gap-1" aria-live="polite">
			{#each cable.queue.items as item, index (index)}
				<li class="flex justify-between gap-4" data-status={item.status}>
					<span>{item.deviceLabel}</span>
					<span class="font-mono text-sm">{queueStatus[item.status]()}</span>
				</li>
			{/each}
		</ol>
		{#if !cable.queue.running}
			<button
				type="button"
				class="self-start rounded border border-current px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
				onclick={() => service.clearQueue()}
			>
				{m.cable_queue_clear()}
			</button>
		{/if}
	{/if}

	{#if message !== null}
		<p role="status" class="text-sm">{message}</p>
	{/if}
</section>
