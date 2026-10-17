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
	import Button from '#lib/components/primitives/Button.svelte';
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

	/**
	 * Why the queue cannot be reviewed or confirmed now (T8: unavailable always says why). The
	 * Button keeps it focusable and blocks click, Enter and Space; the handlers check it again.
	 */
	function queueReason(count: number): string | null {
		if (cable.writing) return m.cabo_fux_busy_writing();
		if (!canWrite) return m.cable_write_blocked();
		if (count < 2) return m.fuxq1_queue_select_two();
		return null;
	}
	const reviewReason = $derived(queueReason(selected.length));
	const confirmReason = $derived(reviewed === null ? null : queueReason(reviewed.length));

	function startReview() {
		if (reviewReason !== null) return;
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
		if (devices === null || confirmReason !== null) return;
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
	{#if cable.writing}
		<p id={`${headingId}-busy`} class="text-sm">{m.cabo_fux_busy_writing()}</p>
	{/if}

	{#if cable.devices.length < 2}
		<p class="text-sm">{m.cable_queue_need_two()}</p>
	{:else if reviewed === null}
		<fieldset
			class="flex flex-col gap-1"
			disabled={cable.writing}
			aria-describedby={cable.writing ? `${headingId}-busy` : undefined}
		>
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
		<Button class="self-start" disabledReason={reviewReason} onclick={startReview}>
			{m.cable_queue_review()}
		</Button>
	{:else}
		<h4 class="text-sm font-semibold">{m.cable_queue_confirm_heading()}</h4>
		<ol class="list-decimal pl-6">
			{#each reviewed as device (device)}
				<li>{labelOf(device)}</li>
			{/each}
		</ol>
		<div class="flex flex-wrap gap-2">
			<Button variant="primary" disabledReason={confirmReason} onclick={confirmQueue}>
				{m.cable_queue_confirm({ count: String(reviewed.length) })}
			</Button>
			<button
				type="button"
				class="rounded border border-current px-3 py-1 focus-visible:outline-2 focus-visible:outline-offset-2"
				disabled={cable.writing}
				aria-disabled={cable.writing ? 'true' : undefined}
				aria-describedby={cable.writing ? `${headingId}-busy` : undefined}
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
