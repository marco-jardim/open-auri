<!--
	The live preview checklist ("Ouvir no cabo", issue #69). Opened by the Curva page's switch;
	its "Começar" button is the only control that calls `service.startLive()`, with a gesture
	minted in that very click. Items: the gate, "Abaixei o volume", and, as
	`evaluateLiveChecklist` requires them, the experimental, Modo YOLO and Android confirmations.
	No spacing and no "keep connected": nothing is written to flash, and an unplug only sends the
	cable back to its saved curve. Same levers (ConfirmLever) as the write checklist.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { gateForWrite } from 'open-auri/safety';
	import { m } from '#lib/paraglide/messages.js';
	import type { CableService } from '#lib/cable/service.ts';
	import type {
		Band,
		CableState,
		ChecklistItemId,
		ChecklistResult,
		Confirmations,
		GateResult,
		LiveOutcome,
		WriteProfile
	} from '#lib/cable/types.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import { modalDialog } from '#lib/components/chrome/modal.ts';
	import ConfirmLever from './ConfirmLever.svelte';
	import { describeReason, waivedCriteriaText } from './i18n.ts';
	import { liveRefusalText } from './live.ts';

	interface Props {
		service: CableService;
		/** Controlled by the parent; the dialog opens modally while true. */
		open: boolean;
		bands: readonly Band[];
		preampDb: number;
		/** Lets the gate accept HS/LP/HP for the whole session (confirmation then required). */
		experimental?: boolean;
		/** `'yolo'`: the session's gate profile is Modo YOLO (its two items are required). */
		profile?: WriteProfile;
		onclose: () => void;
		/** Runs in the click, right before `startLive` (the page notes what it sends first). */
		onbeforestart?: () => void;
		onresult?: (outcome: LiveOutcome) => void;
	}

	let {
		service,
		open,
		bands,
		preampDb,
		experimental = false,
		profile = 'standard',
		onclose,
		onbeforestart,
		onresult
	}: Props = $props();

	type LeverConfirmations = Omit<Confirmations, 'keepConnected'> & { yoloWrite: boolean };
	const UNCONFIRMED: LeverConfirmations = {
		volumeLowered: false,
		experimental: false,
		yoloWrite: false
	};
	const yolo = $derived(profile === 'yolo');
	const id = $props.id();

	let cable = $state.raw<CableState>(untrack(() => service.getState()));
	let confirmations = $state<LeverConfirmations>({ ...UNCONFIRMED });
	/** The target the confirmations were given for (plain: compared, never rendered). */
	let confirmedTarget = untrack(() => cable.device);
	$effect(() =>
		service.subscribe((next) => {
			// Confirmations belong to one target cable: a change asks again.
			if (next.device !== confirmedTarget) {
				confirmedTarget = next.device;
				confirmations = { ...UNCONFIRMED };
			}
			cable = next;
		})
	);
	$effect(() => {
		if (!open) return;
		untrack(() => {
			confirmations = { ...UNCONFIRMED };
			message = null;
		});
	});

	let starting = $state(false);
	let message = $state<string | null>(null);

	const gate = $derived<GateResult | null>(
		open
			? gateForWrite(bands, preampDb, yolo ? { experimental, profile: 'yolo' } : { experimental })
			: null
	);
	const checklist = $derived.by<ChecklistResult | null>(() => {
		void cable;
		if (gate === null) return null;
		return service.liveChecklist(
			{
				bands,
				preampDb,
				experimental,
				confirmations: { ...confirmations, keepConnected: false },
				...(yolo ? { profile: 'yolo' as const } : {})
			},
			gate
		);
	});
	const required = (item: ChecklistItemId) =>
		checklist?.items.some((entry) => entry.id === item && entry.required) ?? false;
	const yoloText = $derived(
		checklist === null ? '' : m.yolo_confirm_write({ criteria: waivedCriteriaText(checklist.waived) })
	);

	/** Why "Começar" is locked, or null when it may act (first unmet item only). */
	const startReason = $derived.by<string | null>(() => {
		if (checklist === null) return m.cable_fux_lock_other();
		const unmet = (item: ChecklistItemId) =>
			checklist.items.some((entry) => entry.id === item && entry.required && !entry.satisfied);
		if (cable.writing) return m.cable_fux_lock_writing();
		if (cable.device === null) {
			return cable.devices.length === 0 ? m.cable_fux_lock_no_cable() : m.cable_fux_lock_target();
		}
		if (unmet('gate')) return m.cable_fux_lock_gate();
		if (unmet('volume')) return m.cable_live_lock_volume();
		if (unmet('experimental')) return m.cable_fux_lock_experimental();
		if (unmet('yolo-session')) return m.yolo_lock_session();
		if (unmet('yolo-write')) return m.yolo_lock_write();
		if (unmet('android-untested')) return m.cable_lock_android_untested();
		if (!checklist.canWrite) return m.cable_fux_lock_other();
		return null;
	});

	// The gesture token is minted synchronously, inside this click/keypress handler.
	async function onStart(event: MouseEvent) {
		if (starting) return;
		const gesture = service.createGesture(event);
		starting = true;
		message = null;
		onbeforestart?.();
		let outcome: LiveOutcome;
		try {
			outcome = await service.startLive({
				curve: {
					bands,
					preampDb,
					experimental,
					...(yolo ? { profile: 'yolo' as const } : {})
				},
				confirmations: { ...confirmations },
				gesture
			});
		} finally {
			starting = false;
		}
		onresult?.(outcome);
		if (outcome.status === 'accepted') {
			onclose();
			return;
		}
		message = liveRefusalText[outcome.reason]();
	}
</script>

<dialog
	aria-labelledby={`${id}-title`}
	aria-describedby={`${id}-intro`}
	closedby="closerequest"
	class="live-checklist"
	data-live-checklist
	use:modalDialog={{ open, onDismiss: onclose, canDismiss: () => !starting }}
>
	{#if checklist !== null}
		<div class="body">
			<h2 id={`${id}-title`} class="title">{m.cable_live_checklist_title()}</h2>
			<p id={`${id}-intro`} class="intro">{m.cable_live_checklist_intro()}</p>
			{#if yolo}
				<p class="yolo" role="note">
					<strong>{m.yolo_tape()}</strong>
					<span>{m.yolo_checklist_banner()}</span>
				</p>
			{/if}

			<section class="gate" aria-labelledby={`${id}-gate`} data-gate={checklist.gateOk}>
				<h3 id={`${id}-gate`} class="engrave">{m.cable_checklist_gate_heading()}</h3>
				<p class="gate-line">
					<Lamp on={true} tone={checklist.gateOk ? 'ok' : 'danger'} />
					<span>{checklist.gateOk ? m.cable_live_gate_ok() : m.cable_live_gate_fail()}</span>
				</p>
				{#if !checklist.gateOk && checklist.reasons.length > 0}
					<ul class="reasons">
						{#each checklist.reasons as reason, index (index)}
							<li>{describeReason(reason)}</li>
						{/each}
					</ul>
				{/if}
			</section>

			{#if checklist.experimentalRequired}
				<p class="experimental">{m.cable_experimental_text()}</p>
			{/if}

			<fieldset class="levers" disabled={starting}>
				<legend class="engrave">{m.cable_confirmations_heading()}</legend>
				<ConfirmLever
					bind:checked={confirmations.volumeLowered}
					label={m.cable_confirm_volume()}
					confirmation="volume"
				/>
				{#if checklist.experimentalRequired}
					<ConfirmLever
						bind:checked={confirmations.experimental}
						label={m.cable_confirm_experimental()}
						confirmation="experimental"
					/>
				{/if}
				{#if yolo}
					<ConfirmLever bind:checked={confirmations.yoloWrite} label={yoloText} confirmation="yolo" />
				{/if}
				{#if required('android-untested')}
					<ConfirmLever
						bind:checked={
							() => confirmations.androidUntested === true,
							(checked) => (confirmations.androidUntested = checked)
						}
						label={m.cable_confirm_android_untested()}
						confirmation="android-untested"
					/>
				{/if}
			</fieldset>

			{#if message !== null}
				<p class="message" role="status">{message}</p>
			{/if}

			<footer class="foot">
				<!-- While "Começar" runs, the outcome must reach the page: no closing meanwhile. -->
				<Button variant="plate" loading={starting} onclick={() => onclose()}
					>{m.cable_live_cancel()}</Button
				>
				<Button
					variant="primary"
					disabledReason={startReason}
					loading={starting}
					onclick={onStart}
					data-live-start
				>
					{m.cable_live_start()}
				</Button>
			</footer>
		</div>
	{/if}
</dialog>

<style>
	.live-checklist {
		margin: auto;
		width: min(560px, calc(100vw - 24px));
		max-height: 92vh;
		overflow-y: auto;
		padding: 0;
		border: 1px solid var(--rule, #333);
		border-radius: var(--rad-lg, 8px);
		background: var(--ink-2, #161616);
		color: var(--text, #eee);
		font: 400 var(--fs-ui, 14px) / 1.5 var(--face-body, sans-serif);
	}
	.live-checklist::backdrop {
		background: #000000b0;
	}
	.body {
		display: grid;
		gap: var(--space-3, 12px);
		padding: var(--space-4, 16px) var(--space-5, 24px);
	}
	.title {
		margin: 0;
		font: 600 var(--fs-lede, 17px) / 1.2 var(--face-body, sans-serif);
	}
	.intro,
	.experimental,
	.message,
	.gate-line,
	.yolo {
		margin: 0;
	}
	.yolo {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		padding: 6px 10px;
		border-radius: 3px;
		background: #a3262c;
		color: #fff;
	}
	.engrave {
		margin: 0 0 4px;
		font: 600 var(--fs-small, 13px) / 1.2 var(--face-body, sans-serif);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-2, #bbb);
	}
	.gate-line {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.reasons {
		margin: 4px 0 0;
		padding-left: 1.2em;
		font-size: var(--fs-small, 13px);
	}
	.levers {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		margin: 0;
		padding: 12px;
		border: 0;
		border-radius: 6px;
		background: linear-gradient(180deg, #ced1cd, #a6a9a5);
		color: #24282a;
	}
	.levers legend {
		float: left;
		width: 100%;
		color: #24282a;
	}
	.levers :global(.lever-cell) {
		flex: 1 1 140px;
	}
	.message {
		padding: 8px 10px;
		border-radius: 3px;
		background: #0b1312;
		color: #a6f6ed;
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}
</style>
