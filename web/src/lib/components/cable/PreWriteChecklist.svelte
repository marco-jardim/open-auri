<!--
	The global pre-write checklist (plan §3.1 N2/N3, T2.7; materialised in FUX.P6 as the
	mock's calibration unit). Opened only by `app.requestWrite()`; its GRAVAR lever is the
	only control that calls `service.write()`, and only with a gesture minted in that click.

	Presentation changed in FUX.P6, logic did not: the gate verdict, the checklist result,
	the confirmations (one per lever), their reset rules, the 2 s spacing and the dialog's
	close guard are exactly as before. The props contract is unchanged.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { gateForWrite } from 'open-auri/safety';
	import { m } from '#lib/paraglide/messages.js';
	import { hasUltrasonicBands } from '#lib/cable/checklist.ts';
	import type { CableService } from '#lib/cable/service.ts';
	import type {
		Band,
		CableDevice,
		CableState,
		ChecklistItemId,
		ChecklistResult,
		Confirmations,
		GateResult,
		QueueOutcome,
		WriteOutcome,
		WriteProfile
	} from '#lib/cable/types.ts';
	import { Button, Lamp } from '#lib/components/primitives/index.ts';
	import Explainer from '#lib/components/comprehension/Explainer.svelte';
	import MultiCableQueue from './MultiCableQueue.svelte';
	import LevelGauge from './LevelGauge.svelte';
	import CriteriaList from './CriteriaList.svelte';
	import LoudnessPanel from './LoudnessPanel.svelte';
	import ConfirmLever from './ConfirmLever.svelte';
	import { criteriaValues } from './criteria.ts';
	import { describeOutcome, formatCrc, formatNumber, waivedCriteriaText } from './i18n.ts';

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
		/**
		 * `'yolo'`: Modo YOLO write. The gate uses the YOLO profile, waived criteria show amber,
		 * the per-write YOLO lever is required on every write and the X9 queue is not offered.
		 */
		profile?: WriteProfile;
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
		profile = 'standard',
		onclose,
		onresult
	}: Props = $props();

	// Every lever, the YOLO one included, is a plain boolean here (each binds a ConfirmLever).
	// The Android field starts absent, and is only added by its rendered lever. This keeps
	// desktop and simulated confirmation payloads unchanged.
	type LeverConfirmations = Confirmations & { yoloWrite: boolean };
	const UNCONFIRMED: LeverConfirmations = {
		volumeLowered: false,
		keepConnected: false,
		experimental: false,
		yoloWrite: false
	};
	const yolo = $derived(profile === 'yolo');

	let cable = $state.raw<CableState>(untrack(() => service.getState()));
	let confirmations = $state<LeverConfirmations>({ ...UNCONFIRMED });
	/** The write target the confirmations were given for (plain: compared, never rendered). */
	let confirmedTarget: CableDevice | null = untrack(() => cable.device);
	$effect(() =>
		service.subscribe((next) => {
			// Confirmations belong to one target: any change (unplugged, selected) asks again.
			if (next.device !== confirmedTarget) {
				confirmedTarget = next.device;
				confirmations = { ...UNCONFIRMED };
			}
			cable = next;
		})
	);

	const id = $props.id();
	let dialog = $state<HTMLDialogElement>();
	/** Re-evaluates the time-dependent items (2 s spacing countdown). */
	let tick = $state(0);
	let message = $state<string | null>(null);

	// The gate runs only while the dialog is open; write() always re-gates on its own.
	const gate = $derived<GateResult | null>(
		open
			? gateForWrite(bands, preampDb, yolo ? { experimental, profile: 'yolo' } : { experimental })
			: null
	);
	const checklist = $derived.by<ChecklistResult | null>(() => {
		void tick;
		void cable;
		if (gate === null) return null;
		return service.checklist(
			{
				bands,
				preampDb,
				experimental,
				confirmations: { ...confirmations },
				...(yolo ? { profile: 'yolo' as const } : {})
			},
			gate
		);
	});
	/** The curve the gate read has a section above 20 kHz: the experimental note says so. */
	const ultrasonic = $derived(checklist?.snapshot ? hasUltrasonicBands(checklist.snapshot) : false);
	/** The per-write YOLO text, naming the waived criteria of this very verdict. */
	const yoloText = $derived(
		checklist === null
			? ''
			: m.yolo_confirm_write({ criteria: waivedCriteriaText(checklist.waived) })
	);
	/** Display values of the criteria, from the same verdict (presentation only). */
	const values = $derived(criteriaValues(gate));

	// §0.12: the USB timing never shares the main thread with this countdown. A write records
	// its flash attempt before the first byte, and that (reactive) record restarts the 2 s
	// spacing at once; without this guard the countdown re-rendered the dialog every 200 ms
	// between reports, which delayed the 16 ms pauses and the 150 ms settle. While writing the
	// GRAVAR lever is locked for the write itself, so nothing here needs the countdown; it
	// starts again when the write ends (`cable.writing` turns false).
	$effect(() => {
		if (checklist === null || cable.writing) return;
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

	/**
	 * Why GRAVAR is locked, or null when it may act. Null exactly when the previous rule
	 * allowed the button (`checklist.canWrite && !cable.writing && cable.device !== null`):
	 * the specific reasons only name the first unmet item, and the last line is a catch-all.
	 */
	const writeReason = $derived.by<string | null>(() => {
		if (checklist === null) return m.cable_fux_lock_other();
		const unmet = (item: ChecklistItemId) =>
			checklist.items.some((entry) => entry.id === item && entry.required && !entry.satisfied);
		if (cable.writing) return m.cable_fux_lock_writing();
		if (cable.device === null) {
			return cable.devices.length === 0 ? m.cable_fux_lock_no_cable() : m.cable_fux_lock_target();
		}
		if (unmet('gate')) return m.cable_fux_lock_gate();
		if (unmet('volume') || unmet('connection')) return m.cable_fux_lock_levers();
		if (unmet('experimental')) return m.cable_fux_lock_experimental();
		if (unmet('yolo-session')) return m.yolo_lock_session();
		if (unmet('yolo-write')) return m.yolo_lock_write();
		if (unmet('android-untested')) return m.cable_lock_android_untested();
		if (unmet('spacing')) return m.cable_fux_lock_spacing();
		if (!checklist.canWrite) return m.cable_fux_lock_other();
		return null;
	});
	const armed = $derived(writeReason === null);

	/** Selecting a target never writes: the write button still needs its own click. */
	function onSelectTarget(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		if (value === '') return;
		const device = cable.devices[Number(value)];
		if (device !== undefined) service.selectDevice(device);
	}

	function onCancel(event: Event) {
		// Never close the dialog in the middle of a write.
		if (service.getState().writing) event.preventDefault();
	}

	/**
	 * `cancel` is not always cancelable (Chromium's close watcher: a second Esc or Android back
	 * without fresh user activation closes the modal anyway). Closed mid-write, the dialog is
	 * shown again at once: the page stays inert, the outcome is shown here, and the parent's
	 * checklist state is released only by a close after the write.
	 */
	function onDialogClose() {
		if (open && service.getState().writing) {
			queueMicrotask(() => {
				if (open && dialog !== undefined && dialog.isConnected && !dialog.open) {
					dialog.showModal();
				}
			});
			return;
		}
		onclose();
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
			name,
			...(yolo ? { profile: 'yolo' as const } : {})
		});
		finish(outcome);
	}
</script>

<dialog
	bind:this={dialog}
	aria-labelledby={`${id}-title`}
	closedby={cable.writing ? 'none' : 'closerequest'}
	class="checklist"
	oncancel={onCancel}
	onclose={onDialogClose}
>
	{#if checklist !== null}
		<div class="unit">
			{#each ['tl', 'tr', 'bl', 'br'] as corner (corner)}
				<span class="screw {corner}" aria-hidden="true"></span>
			{/each}
			<header class="head">
				<div class="title-row">
					<h2 id={`${id}-title`} class="title">{m.cable_checklist_title()}</h2>
					<Explainer term="checklist" />
				</div>
				{#if yolo}
					<p class="yolo-banner" role="note" data-yolo-banner>
						<strong>{m.yolo_tape()}</strong>
						<span>{m.yolo_checklist_banner()}</span>
					</p>
				{/if}
				<div class="model">
					<span>{m.cable_fux_model()}</span>
					{#if cable.mode === 'simulated'}
						<span class="badge">{m.cable_simulated_badge()}</span>
					{/if}
				</div>
			</header>

			<div class="cal">
				<div class="col-vu">
					<LevelGauge levelDb={checklist.newLevelDb} compact />
					{#if checklist.crc !== null}
						<p class="crc">
							<span>{m.cable_crc({ crc: formatCrc(checklist.crc) })}</span>
							<Explainer term="crc" />
						</p>
					{/if}
				</div>

				<section class="col-gate" aria-labelledby={`${id}-gate`}>
					<div class="sub-head">
						<h3 id={`${id}-gate`} class="engrave">{m.cable_checklist_gate_heading()}</h3>
						<Explainer term="gate" />
					</div>
					<CriteriaList lamps={checklist.lamps} {values} label={m.cable_fux_criteria_label()} />
					<p class="gate-note">
						<span>{m.cable_fux_gate_note()}</span>
						<Explainer term="q27" />
						<Explainer term="q23" />
					</p>
				</section>

				<div class="col-act">
					<LoudnessPanel loudness={checklist.loudness} newLevelDb={checklist.newLevelDb} />

					{#if checklist.experimentalRequired}
						<section aria-labelledby={`${id}-experimental`} class="experimental">
							<h3 id={`${id}-experimental`} class="engrave">
								{m.cable_experimental_heading()}
							</h3>
							<p>{m.cable_experimental_text()}</p>
							{#if ultrasonic}
								<p data-testid="ultra-experimental">{m.cable_experimental_ultra()}</p>
							{/if}
						</section>
					{/if}

					<div class="guards">
						<fieldset
							class="levers"
							disabled={cable.writing}
							aria-describedby={cable.writing ? `${id}-levers-why` : undefined}
						>
							<legend class="engrave">{m.cable_confirmations_heading()}</legend>
							<ConfirmLever
								bind:checked={confirmations.volumeLowered}
								label={m.cable_confirm_volume()}
								confirmation="volume"
							/>
							<ConfirmLever
								bind:checked={confirmations.keepConnected}
								label={m.cable_confirm_connection()}
								confirmation="connection"
							/>
							{#if checklist.experimentalRequired}
								<ConfirmLever
									bind:checked={confirmations.experimental}
									label={m.cable_confirm_experimental()}
									confirmation="experimental"
								/>
							{/if}
							{#if yolo}
								<!-- Shown on every YOLO write; reset after each one like the other levers. -->
								<ConfirmLever
									bind:checked={confirmations.yoloWrite}
									label={yoloText}
									confirmation="yolo"
								/>
							{/if}
							{#if checklist.items.some((item) => item.id === 'android-untested' && item.required)}
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
						<div class="write-cell">
							<span class="engrave" aria-hidden="true">{m.cable_fux_write_legend()}</span>
							<Button
								variant="lever"
								size="lg"
								class="write-lever"
								data-armed={armed}
								disabledReason={writeReason}
								onclick={onWrite}
							>
								<span class="big-guard" aria-hidden="true"><span class="big-bat"></span></span>
								<span class="write-name"
									>{cable.mode === 'simulated' ? m.cable_write_simulated() : m.cable_write()}</span
								>
							</Button>
							<span class="arm">
								<Lamp on={armed} tone="ok" />
								<span>{m.cable_fux_armed()}</span>
							</span>
						</div>
					</div>
					<p id={`${id}-levers-why`} class="lever-hint">
						{cable.writing ? m.cable_fux_levers_locked() : m.cable_fux_lever_hint()}
					</p>
				</div>
			</div>

			<section aria-labelledby={`${id}-counters`} class="counters">
				<div class="sub-head">
					<h3 id={`${id}-counters`} class="engrave">{m.cable_counters_heading()}</h3>
					<Explainer term="flash" />
				</div>
				<dl class="drums">
					<div>
						<dt>{m.cable_counter_session()}</dt>
						<dd>{checklist.counters.session}</dd>
					</div>
					<div>
						<dt>{m.cable_counter_day()}</dt>
						<dd>{checklist.counters.day}</dd>
					</div>
					<div>
						<dt>{m.cable_counter_total()}</dt>
						<dd>{checklist.counters.total}</dd>
					</div>
				</dl>
				<p class="spacing" aria-live="polite">
					{checklist.spacing.ok
						? m.cable_spacing_ready()
						: m.cable_spacing_wait({ seconds: formatNumber(checklist.spacing.waitMs / 1000, 1) })}
				</p>
				{#if checklist.dailyNotice.show}
					<p class="notice" role="note">{m.cable_flash_notice()}</p>
				{/if}
			</section>

			<!-- No X9 multi-cable queue in Modo YOLO: one cable, one confirmation, one write. -->
			{#if cable.devices.length > 1 && !yolo}
				<div class="queue">
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
				</div>
			{/if}

			<section aria-labelledby={`${id}-target`} class="target">
				<h3 id={`${id}-target`} class="engrave">{m.cable_target_heading()}</h3>
				{#if cable.devices.length === 0}
					<p>{m.cable_refused_no_device()}</p>
				{:else}
					{#if targetLabel !== null}
						<p class="lcd" data-target-device>
							{m.cable_target_device({ device: targetLabel })}
						</p>
					{:else}
						<p role="note">{m.cable_target_required()}</p>
					{/if}
					{#if cable.devices.length > 1 || targetIndex === ''}
						<label class="select">
							<span>{m.cable_select_device()}</span>
							<select
								disabled={cable.writing}
								aria-disabled={cable.writing ? 'true' : undefined}
								aria-describedby={cable.writing ? `${id}-target-why` : undefined}
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
						{#if cable.writing}
							<p id={`${id}-target-why`}>{m.cabo_fux_busy_writing()}</p>
						{/if}
					{/if}
				{/if}
			</section>

			{#if !checklist.canWrite}
				<p class="blocked">{m.cable_write_blocked()}</p>
			{/if}
			{#if message !== null}
				<p role="status" class="message">{message}</p>
			{/if}

			<footer class="foot">
				<Button
					variant="plate"
					disabledReason={cable.writing ? m.cable_fux_close_locked() : null}
					onclick={() => onclose()}
				>
					{m.cable_close()}
				</Button>
			</footer>
		</div>
	{/if}
</dialog>

<style>
	.checklist {
		margin: auto;
		width: min(1120px, calc(100vw - 24px));
		max-height: 92vh;
		overflow-y: auto;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: #040505;
		color: #24282a;
		font: 400 var(--fs-ui, 14px) / 1.5 var(--face-body, 'Geist', sans-serif);
		box-shadow:
			0 0 0 1px #000,
			0 0 0 7px #161819,
			0 30px 80px #000d;
	}
	.checklist::backdrop {
		background: #000000c4;
	}
	.unit {
		position: relative;
		container-type: inline-size;
		padding: 22px clamp(18px, 5vw, 64px) 22px;
		background:
			linear-gradient(165deg, #ffffff5c, #ffffff00 38%, #00000014),
			repeating-linear-gradient(90deg, #ffffff0e 0 1px, #0000000a 1px 2px, #ffffff00 2px 5px),
			linear-gradient(180deg, #ced1cd, #b5b8b4 55%, #a6a9a5);
		box-shadow:
			inset 0 1px 0 #ffffffa8,
			inset 0 -2px 0 #0000004d;
	}
	/* The explainer trigger is drawn for dark surfaces: on brushed aluminium it needs dark ink. */
	.unit :global(.trigger) {
		color: #24282a;
	}
	.unit :global(.trigger > span) {
		border-color: rgba(0, 0, 0, 0.55);
	}
	.screw {
		position: absolute;
		width: 13px;
		height: 13px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #f4f5f3, #9da19d 45%, #4b4f4c);
		box-shadow:
			0 1px 2px #000a,
			inset 0 0 0 1px #00000040;
	}
	.screw::after {
		content: '';
		position: absolute;
		inset: 5.5px 2px;
		background: #3a3d3b;
		transform: rotate(30deg);
	}
	.tl {
		left: 12px;
		top: 11px;
	}
	.tr {
		right: 12px;
		top: 11px;
	}
	.bl {
		left: 12px;
		bottom: 11px;
	}
	.br {
		right: 12px;
		bottom: 11px;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: baseline;
		gap: 8px 16px;
		margin-bottom: 16px;
		padding-bottom: 9px;
		border-bottom: 1px solid #00000029;
	}
	.title-row,
	.sub-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.title {
		margin: 0;
		font: 600 var(--fs-lede, 17px) / 1.1 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: #24282a;
		text-shadow: 0 1px 0 #ffffff8c;
	}
	.model {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		font: 600 var(--fs-caption, 12px) var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}
	.badge {
		padding: 3px 6px;
		border: 1px solid currentColor;
		border-radius: 2px;
		color: #0f3d3a;
	}
	.engrave {
		margin: 0;
		font: 600 var(--fs-small, 13px) / 1.2 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: #24282a;
		text-shadow: 0 1px 0 #ffffff8c;
	}
	.cal {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 1fr);
		gap: 24px;
		align-items: start;
	}
	.col-vu,
	.col-gate,
	.col-act {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.crc,
	.gate-note {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 8px;
		margin: 0;
		font: 400 var(--fs-caption, 12px) / 1.45 var(--face-data, 'JetBrains Mono', monospace);
		color: #2f3335;
	}
	.gate-note {
		font-family: var(--face-body, 'Geist', sans-serif);
	}
	.yolo-banner {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		align-items: baseline;
		margin: 8px 0 0;
		padding: 6px 10px;
		border-radius: 3px;
		background: #a3262c;
		color: #fff;
		font: 600 var(--fs-small, 13px) / 1.35 var(--face-body, 'Geist', sans-serif);
	}
	.yolo-banner strong {
		letter-spacing: 0.12em;
	}
	.experimental {
		display: grid;
		gap: 6px;
		padding: 10px 12px;
		border-radius: 4px;
		background: #0000000d;
		box-shadow:
			inset 3px 0 0 #1b7f76,
			inset 0 1px 3px #0003,
			0 1px 0 #ffffff80;
	}
	.experimental p {
		margin: 0;
		font-weight: 600;
		color: #123b38;
	}
	.guards {
		display: grid;
		grid-template-columns: minmax(0, 2fr) minmax(0, 1.3fr);
		gap: 14px;
		align-items: start;
	}
	.levers {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 14px 10px;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	.levers legend {
		grid-column: 1 / -1;
		padding: 0;
		margin-bottom: 8px;
	}
	.write-cell {
		display: grid;
		justify-items: center;
		gap: 8px;
		text-align: center;
	}
	.write-cell :global(.write-lever) {
		height: auto;
		min-height: 132px;
		width: 100%;
		max-width: 132px;
		flex-direction: column;
		gap: 8px;
		padding: 10px 8px;
		white-space: normal;
		line-height: 1.2;
	}
	.write-cell :global(.write-lever[aria-disabled='true']) {
		--btn-bg: linear-gradient(180deg, #8c908c, #6f736f);
		--btn-fg: #1c1f20;
		--btn-border: #0000008c;
	}
	.big-guard {
		position: relative;
		display: block;
		width: 46px;
		height: 66px;
		border-radius: 8px;
		background: linear-gradient(180deg, #2a2d2f, #121314);
		box-shadow:
			inset 0 2px 5px #000,
			0 1px 0 #ffffffb0;
	}
	.big-bat {
		position: absolute;
		left: 19px;
		top: 16px;
		width: 9px;
		height: 32px;
		border-radius: 5px;
		background: linear-gradient(90deg, #7c807d, #f4f5f3 45%, #8b8f8c);
		box-shadow: 2px 2px 3px #0008;
		transform-origin: 4.5px 4px;
		transform: rotate(150deg);
		transition: transform var(--dur-slow, 0.36s) var(--ease-mech, cubic-bezier(0.3, 1.4, 0.5, 1));
	}
	.write-cell :global(.write-lever[data-armed='true'] .big-bat) {
		transform: rotate(0deg);
	}
	.write-name {
		font-size: var(--fs-small, 13px);
	}
	.arm {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font: 600 var(--fs-caption, 12px) var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	.lever-hint {
		margin: 0;
		font-size: var(--fs-caption, 12px);
		color: #2f3335;
	}
	.counters,
	.target,
	.queue {
		display: grid;
		gap: 8px;
		margin-top: 18px;
		padding-top: 14px;
		border-top: 1px solid #00000022;
	}
	.drums {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 10px;
		margin: 0;
		text-align: center;
	}
	.drums div {
		display: grid;
		gap: 4px;
	}
	.drums dt {
		font: 600 var(--fs-caption, 12px) var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.drums dd {
		justify-self: center;
		min-width: 4ch;
		margin: 0;
		padding: 4px 10px;
		border-radius: 3px;
		background: #0b0c0c;
		color: #f2f2ec;
		font: 500 var(--fs-readout, 14px) var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
		box-shadow:
			inset 0 2px 5px #000,
			0 1px 0 #ffffffaa;
	}
	.spacing,
	.notice,
	.blocked,
	.message,
	.target p {
		margin: 0;
		font-size: var(--fs-small, 13px);
	}
	.notice {
		padding: 8px 10px;
		border-radius: 3px;
		background: linear-gradient(180deg, #1f2122, #111213);
		color: #e8ece7;
	}
	.lcd {
		justify-self: start;
		padding: 4px 8px;
		border-radius: 2px;
		background: #0b1312;
		color: #8fe9df;
		font: 400 var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
	}
	.select {
		display: grid;
		gap: 4px;
		font-size: var(--fs-small, 13px);
	}
	.select select {
		max-width: 320px;
		min-height: 36px;
		padding: 6px 10px;
		border: 1px solid #000;
		border-radius: 3px;
		background: #0d0f0f;
		color: #e8ece8;
		font: inherit;
	}
	.blocked {
		margin-top: 14px;
		font-weight: 600;
	}
	.message {
		margin-top: 10px;
		padding: 8px 10px;
		border-radius: 3px;
		background: #0b1312;
		color: #a6f6ed;
		font-family: var(--face-data, 'JetBrains Mono', monospace);
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 16px;
	}
	@container (max-width: 940px) {
		.cal {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}
		.col-act {
			grid-column: 1 / -1;
		}
	}
	@container (max-width: 600px) {
		.cal,
		.guards {
			grid-template-columns: minmax(0, 1fr);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.big-bat {
			transition: none;
		}
	}
</style>
