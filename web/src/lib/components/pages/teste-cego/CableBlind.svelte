<!--
	The blind test on the cable (issue #74): the cable controls of the Teste cego page. Every
	gesture is minted here, synchronously in its click; the timing, voids and checks live in
	`cable-round.ts`, the session and the position → candidate mapping in BlindTest (never here,
	never in the DOM).
	- `setup` (the "No cabo" tab): the set's verdict (the pure `planComparison` the service makes;
	  a refusal names the candidate, before the test starts), the volume lever (and the
	  experimental / Android levers when needed), "Começar no cabo".
	- `listen` (Escuta, while the test runs): the change check (Neutro / Telefone, "Ouvi mudar",
	  "Não mudou"), "O som parou de mudar", a pause with "Retomar" (fresh levers and gesture) and
	  "Encerrar" (back to the saved curve; a held revert asks for the volume confirmation; locked
	  with why while the cable's saved curve is not known) and "Encerrar sem voltar" (the cable
	  keeps its curve; the completed rounds are revealed).
	- `results` (Resultado): "Salvar a vencedora no cabo" (the winner's ORIGINAL curve, from the
	  page's own candidate, once the blind set ended), "Encerrar", "Encerrar sem voltar".
	While the cable may still play an old preview (`liveOrphan`), every start waits: unplug and
	replug, or "Já desconectei" (`dismissLiveOrphan`). A test that ended without this page says
	whether the cable went back to its saved curve (unplugged) or keeps the test's curve.
	Nothing rendered here varies with the playing candidate.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { snapshotBands } from 'open-auri/dsp';
	import { THRESHOLDS } from 'open-auri/safety';
	import { m } from '#lib/paraglide/messages.js';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import { planComparison } from '#lib/cable/compare.ts';
	import { reasonView } from '#lib/cable/checklist.ts';
	import type {
		ChecklistItemId,
		ChecklistResult,
		ComparisonCurve,
		ComparisonItem,
		ComparisonOutcome,
		ComparisonRefusal,
		LiveOutcome
	} from '#lib/cable/types.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import Lamp from '#lib/components/primitives/Lamp.svelte';
	import ConfirmLever from '#lib/components/cable/ConfirmLever.svelte';
	import { describeReason, formatNumber } from '#lib/components/cable/i18n.ts';
	import { liveActive, liveOutcomeText, liveRefusalText } from '#lib/components/cable/live.ts';
	import {
		cableOrphan,
		checkCurves,
		type CablePause,
		type CableRound,
		type CableRoundView
	} from './cable-round.ts';
	import type { Candidate } from './experiment.ts';

	interface Props {
		app: ClientApp | null;
		round: CableRound;
		view: CableRoundView;
		mode: 'setup' | 'listen' | 'results';
		/** `setup`: the chosen candidates; `results`: the session's, in plan order. */
		candidates: readonly Candidate[];
		/** `setup`: why the page blocks starting, or null. */
		blocked?: string | null;
		/** `results`: the winner's index in `candidates` (plan index), null when tied. */
		winner?: number | null;
		/**
		 * `setup`, in the "Começar" click: the page prepares the session and its flat output and
		 * returns the set (plan order), or null (the page says why).
		 */
		onbegin?: () => readonly Candidate[] | null;
		/** `setup`: the check started (true) or was refused (false: the page releases the session). */
		onbegun?: (accepted: boolean) => void;
		/** `listen`: the blind set started after the check: a fresh round. */
		onblind?: () => void;
		/** `listen`: "Encerrar" ended the test on the cable. */
		onended?: () => void;
	}

	let {
		app,
		round,
		view,
		mode,
		candidates,
		blocked = null,
		winner = null,
		onbegin,
		onbegun,
		onblind,
		onended
	}: Props = $props();

	const id = $props.id();
	const cable = $derived(app?.cableState ?? null);
	const phase = $derived(view.phase);

	function experimentalOf(candidate: Candidate): boolean {
		return candidate.experimental;
	}

	const curves = $derived<ComparisonCurve[]>(
		candidates.map((candidate) => ({
			bands: candidate.bands,
			preampDb: candidate.preampDb,
			experimental: experimentalOf(candidate)
		}))
	);
	const experimental = $derived(candidates.some(experimentalOf));

	// --- levers (the start and "Retomar") ------------------------------------------------------
	const UNCONFIRMED = { volumeLowered: false, experimental: false, androidUntested: false };
	let confirmations = $state({ ...UNCONFIRMED });
	let busy = $state(false);
	let message = $state<string | null>(null);
	let refusal = $state.raw<ComparisonRefusal | null>(null);

	/** A new pause asks for the levers again. */
	let leversFor: CablePause | null = null;
	$effect(() => {
		const pause = view.pause;
		if (pause === leversFor) return;
		leversFor = pause;
		confirmations = { ...UNCONFIRMED };
	});

	/** The plan `startComparison` will make for the blind set (pure, no I/O). */
	const plan = $derived(
		mode === 'setup' && candidates.length >= 2 && candidates.length <= 3
			? planComparison(curves, { match: true, experimental })
			: null
	);
	/** "Retomar" starts the change check: its own (labelled) plan. */
	const checkPlan = $derived(
		mode === 'listen' && phase === 'paused' ? planComparison(checkCurves(), { match: true }) : null
	);
	const checked = $derived(plan ?? checkPlan);
	const loudest = $derived(
		checked?.items.reduce<ComparisonItem | undefined>(
			(best, item) => (best === undefined || item.levelDb > best.levelDb ? item : best),
			undefined
		)
	);
	/** The live checklist the next start runs (on its loudest item), for display. */
	const checklist = $derived.by<ChecklistResult | null>(() => {
		void cable;
		const target = checked;
		if (app === null || target === null || target.refusal !== undefined || loudest === undefined) {
			return null;
		}
		return app.cable.liveChecklist(
			{
				bands: loudest.bands,
				preampDb: loudest.preampDb,
				experimental: target.experimental,
				confirmations: { ...confirmations, keepConnected: false }
			},
			loudest.verdict
		);
	});
	/** The blind set needs it (also on "Retomar": the set starts again after the check). */
	const experimentalRequired = $derived(
		experimental || (plan?.experimentalRequired ?? false) || round.experimental()
	);
	const androidRequired = $derived(
		checklist?.items.some((entry) => entry.id === 'android-untested' && entry.required) ?? false
	);
	const shownRefusal = $derived(refusal ?? plan?.refusal ?? null);
	const refusalReasons = $derived(
		(shownRefusal?.gateReasons ?? []).map((reason) => describeReason(reasonView(reason)))
	);

	function nameOf(index: number | undefined): string {
		return candidates[index ?? 0]?.name ?? '';
	}

	function refusalText(value: ComparisonRefusal): string {
		const name = nameOf(value.index);
		switch (value.reason) {
			case 'too-few':
				return m.cable_blind_reason_pick();
			case 'gate':
				return value.matched === true
					? m.cable_blind_refused_gate_matched({ name })
					: m.cable_blind_refused_gate({ name });
			case 'level-unknown':
				return m.cable_blind_refused_level_unknown({ name });
			case 'level-range':
				return m.cable_blind_refused_level_range({
					name,
					floor: formatNumber(THRESHOLDS.preampMinDb, 1),
					preamp: formatNumber(value.preampDb ?? THRESHOLDS.preampMinDb, 1)
				});
			case 'yolo-unsupported':
				return m.cable_blind_refused_yolo({ name });
			default:
				return m.cable_live_refused_error();
		}
	}

	function outcomeText(outcome: ComparisonOutcome | LiveOutcome): string | null {
		if (outcome.status === 'accepted') return null;
		// During the test a set refusal names no candidate (only the setup, before it, does).
		if (outcome.reason === 'comparison') {
			return mode === 'setup' ? refusalText(outcome.refusal) : m.cable_blind_refused_start();
		}
		return liveOutcomeText(outcome) ?? liveRefusalText.error();
	}

	/** The cable may still play an old preview: every start waits for a replug or "Já desconectei". */
	const orphan = $derived(cableOrphan(cable));

	/** Why the cable cannot run the test right now (before the checklist), or null. */
	const availability = $derived.by<string | null>(() => {
		if (app === null || cable === null || !cable.liveCapable) return m.cable_blind_unavailable();
		if (cable.connection !== 'connected' || cable.device === null) return m.cable_blind_connect();
		if (cable.writing) return m.cable_live_reason_writing();
		if (liveActive(cable.live) && !round.running()) return m.cable_blind_reason_live();
		if (orphan) return m.cable_blind_reason_orphan();
		return null;
	});

	/** "Já desconectei": clears the old preview's notice (only records; never touches the cable). */
	function onDismissOrphan() {
		app?.cable.dismissLiveOrphan();
	}

	/** Why "Começar no cabo" is locked (first unmet item), or null. */
	const goReason = $derived.by<string | null>(() => {
		if (availability !== null) return availability;
		if (blocked !== null) return blocked;
		if (candidates.length < 2 || candidates.length > 3) return m.cable_blind_reason_pick();
		if (shownRefusal !== null) return refusalText(shownRefusal);
		return leverReason(checklist);
	});

	/** The levers' first unmet item (the start's checklist, or Retomar's), or null. */
	function leverReason(result: ChecklistResult | null): string | null {
		if (!confirmations.volumeLowered) return m.cable_live_lock_volume();
		if (experimentalRequired && !confirmations.experimental) return m.cable_fux_lock_experimental();
		if (androidRequired && !confirmations.androidUntested) return m.cable_lock_android_untested();
		if (result === null) return null;
		const unmet = (item: ChecklistItemId) =>
			result.items.some((entry) => entry.id === item && entry.required && !entry.satisfied);
		if (unmet('gate')) return m.cable_fux_lock_gate();
		const other = result.items.some(
			(entry) =>
				entry.id !== 'experimental' &&
				entry.id !== 'android-untested' &&
				entry.required &&
				!entry.satisfied
		);
		return other ? m.cable_fux_lock_other() : null;
	}

	// --- actions (each gesture minted synchronously in its click) --------------------------------
	async function onGo(event: MouseEvent) {
		if (busy || goReason !== null || app === null) return;
		const gesture = app.cable.createGesture(event);
		const set = onbegin?.() ?? null;
		if (set === null) return;
		busy = true;
		message = null;
		refusal = null;
		let outcome: ComparisonOutcome;
		try {
			outcome = await round.begin({
				gesture,
				confirmations: { ...confirmations },
				curves: set.map((candidate) => ({
					bands: candidate.bands,
					preampDb: candidate.preampDb,
					experimental: candidate.experimental
				})),
				experimental: set.some(experimentalOf)
			});
		} finally {
			busy = false;
		}
		if (outcome.status === 'refused' && outcome.reason === 'comparison') {
			refusal = outcome.refusal;
		}
		message = outcomeText(outcome);
		onbegun?.(outcome.status === 'accepted');
	}

	async function onResume(event: MouseEvent) {
		if (busy || app === null || resumeReason !== null) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		message = null;
		try {
			message = outcomeText(await round.resume({ gesture, confirmations: { ...confirmations } }));
		} finally {
			busy = false;
		}
	}

	async function onCheck(index: 0 | 1) {
		if (busy) return;
		message = null;
		await round.playCheck(index);
	}

	async function onAnswer(event: MouseEvent, changed: boolean) {
		if (busy || app === null) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		message = null;
		try {
			const outcome = await round.answerCheck(changed, { gesture });
			if (outcome === null) return;
			message = outcomeText(outcome);
			if (outcome.status === 'accepted') onblind?.();
		} finally {
			busy = false;
		}
	}

	function onStuck() {
		void round.voidRound('stuck');
	}

	async function onEnd(event: MouseEvent) {
		if (busy || app === null || endReason !== null) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		message = null;
		try {
			const outcome = await round.end({ gesture });
			message = outcome === null ? null : outcomeText(outcome);
			if (round.view.phase === 'ended' && mode === 'listen') onended?.();
		} finally {
			busy = false;
		}
	}

	async function onEndKeep() {
		if (busy) return;
		busy = true;
		message = null;
		try {
			await round.endKeep();
			if (round.view.phase === 'ended' && mode === 'listen') onended?.();
		} finally {
			busy = false;
		}
	}

	async function onConfirmHeld(event: MouseEvent) {
		if (busy || app === null) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		message = null;
		try {
			message = outcomeText(await round.confirmHeld({ gesture }));
			if (round.view.phase === 'ended' && mode === 'listen') onended?.();
		} finally {
			busy = false;
		}
	}

	function onCancelHeld() {
		round.cancelHeld();
	}

	/**
	 * "Salvar a vencedora": the blind set ends first (saving is refused while it runs). The write
	 * is the winner's own original curve, from this page's candidate (never the last session's
	 * set: after an end during the change check, that is the check's Neutro / telefone).
	 */
	async function onSave() {
		const index = winner;
		if (busy || app === null || index === null || saveReason !== null) return;
		const candidate = candidates[index];
		if (candidate === undefined) return;
		const bands = snapshotBands(candidate.bands);
		const preampDb = candidate.preampDb;
		const name = candidate.name;
		busy = true;
		message = null;
		try {
			// The save goes to the cable that plays the test (the target may have moved).
			app.cable.selectLiveCable();
			await round.endKeep();
			app.requestWrite({
				schema: 1,
				updatedAt: Date.now(),
				name,
				source: 'custom',
				labels: null,
				bands,
				preampDb
			});
		} finally {
			busy = false;
		}
	}

	const saveReason = $derived.by<string | null>(() => {
		if (winner === null) return m.cable_blind_save_tied();
		if (cable?.writing) return m.cable_live_reason_writing();
		if (phase === 'end-held') return m.cable_live_save_held();
		if (phase === 'starting') return m.cable_live_save_wait();
		return null;
	});

	/**
	 * Why "Encerrar" (back to the saved curve) is locked, or null: while the comparison runs it
	 * needs the cable's saved curve (re-read on every state change); "Encerrar sem voltar" stays.
	 */
	const endReason = $derived.by<string | null>(() => {
		void cable;
		if (app === null || cable?.live?.comparison?.active !== true) return null;
		return untrack(() => app.cable.liveSavedCurve()) === null ? m.cable_x2_end_no_saved() : null;
	});

	const resumeReason = $derived.by<string | null>(() => {
		if (app === null || cable === null || !cable.liveCapable) return m.cable_blind_unavailable();
		if (cable.connection !== 'connected' || cable.device === null) return m.cable_blind_connect();
		if (orphan) return m.cable_blind_reason_orphan();
		return leverReason(checklist);
	});

	function pauseText(pause: CablePause): string {
		switch (pause) {
			case 'disconnected':
				return m.cable_blind_void_disconnected();
			case 'ended':
				return m.cable_blind_void_ended();
			case 'elsewhere':
				return m.cable_blind_void_elsewhere();
			case 'stuck':
				return m.cable_blind_void_stuck();
			case 'slow':
				return m.cable_blind_void_slow();
			case 'unknown':
			case 'held':
			case 'busy':
			case 'error':
				// One text for every switch failure: nothing about which candidate it was.
				return m.cable_blind_void_switch();
			case 'check-due':
				return m.cable_blind_check_due();
			case 'no-change':
				return m.cable_blind_no_change();
			case 'refused':
				return m.cable_blind_refused_start();
			case 'end-failed':
				return m.cable_blind_end_failed();
			case 'cancel-failed':
				return m.cable_blind_cancel_failed();
			default:
				return pause satisfies never;
		}
	}

	/**
	 * Why the test ended without this page (`gone`): the session's own end reason. Only an unplug
	 * puts the cable back on its saved curve; any other end leaves the test's curve on it.
	 */
	function goneText(): string {
		const live = cable?.live ?? null;
		if (live?.endedReason === 'disconnected' || cable?.connection !== 'connected') {
			return m.cable_live_ended_disconnected();
		}
		if (live?.endedReason === 'reverted') return m.cable_live_ended_reverted();
		return m.cable_blind_ended_gone();
	}

	const endedText = $derived.by<string | null>(() => {
		if (phase !== 'ended') return null;
		switch (view.endedReason) {
			case 'reverted':
				return m.cable_live_ended_reverted();
			case 'kept':
				return m.cable_blind_ended_kept();
			case 'gone':
				return goneText();
			default:
				return null;
		}
	});
</script>

{#snippet levers()}
	<fieldset class="levers" disabled={busy}>
		<legend class="engrave">{m.cable_confirmations_heading()}</legend>
		<ConfirmLever
			bind:checked={confirmations.volumeLowered}
			label={m.cable_confirm_volume()}
			confirmation="volume"
		/>
		{#if experimentalRequired}
			<ConfirmLever
				bind:checked={confirmations.experimental}
				label={m.cable_confirm_experimental()}
				confirmation="experimental"
			/>
		{/if}
		{#if androidRequired}
			<ConfirmLever
				bind:checked={confirmations.androidUntested}
				label={m.cable_confirm_android_untested()}
				confirmation="android-untested"
			/>
		{/if}
	</fieldset>
{/snippet}

{#snippet dismissOrphan()}
	<div class="actions">
		<Button size="sm" onclick={onDismissOrphan} data-cable-blind-orphan-dismiss
			>{m.cable_live_orphan_dismiss()}</Button
		>
	</div>
{/snippet}

{#snippet held()}
	<div class="hold" data-cable-blind-hold>
		<p>{m.cable_blind_hold_saved()}</p>
		<div class="actions">
			<Button variant="primary" size="sm" loading={busy} onclick={onConfirmHeld}
				>{m.cable_live_hold_loudness_confirm()}</Button
			>
			<Button size="sm" onclick={onCancelHeld}>{m.cable_live_cancel()}</Button>
		</div>
	</div>
{/snippet}

<section class="cable-blind" aria-labelledby={`${id}-title`} data-cable-blind={mode}>
	{#if mode === 'setup'}
		<h3 id={`${id}-title`}>{m.cable_blind_title()}</h3>
		<p class="note">{m.cable_blind_intro()}</p>
		{#if availability !== null}
			<p class="note" data-cable-blind-unavailable>{availability}</p>
			{#if orphan}{@render dismissOrphan()}{/if}
		{:else}
			<p>{m.cable_blind_match()}</p>
			{#if shownRefusal !== null}
				<div class="refusal" data-cable-blind-refusal={shownRefusal.reason}>
					<p class="gate-line">
						<Lamp on={true} tone="danger" /><span>{refusalText(shownRefusal)}</span>
					</p>
					{#if refusalReasons.length > 0}
						<ul class="reasons">
							{#each refusalReasons as reason, index (index)}<li>{reason}</li>{/each}
						</ul>
					{/if}
				</div>
			{:else if checklist !== null}
				<p class="gate-line" data-cable-blind-gate={checklist.gateOk}>
					<Lamp on={true} tone={checklist.gateOk ? 'ok' : 'danger'} />
					<span>{checklist.gateOk ? m.cable_blind_gate_ok() : m.cable_live_gate_fail()}</span>
				</p>
			{/if}
			{#if experimentalRequired}<p class="note">{m.cable_experimental_text()}</p>{/if}
			{@render levers()}
			<ul class="notes">
				<li>{m.cable_blind_window()}</li>
				<li>{m.cable_blind_telemetry()}</li>
			</ul>
		{/if}
		<div class="actions">
			<Button
				variant="primary"
				disabledReason={goReason}
				loading={busy}
				onclick={onGo}
				data-cable-blind-start>{m.cable_blind_start()}</Button
			>
		</div>
	{:else if mode === 'listen'}
		<h3 id={`${id}-title`}>{m.cable_blind_title()}</h3>
		{#if phase === 'starting'}
			<p class="note">{m.cable_blind_starting()}</p>
		{:else if phase === 'checking'}
			<div class="check" data-cable-blind-check>
				<h4>{m.cable_blind_check_title()}</h4>
				<p>{m.cable_blind_check_text()}</p>
				<div class="actions">
					<Button
						size="sm"
						aria-pressed={view.checkPlaying === 0}
						loading={view.switching}
						onclick={() => void onCheck(0)}>{m.cable_blind_check_neutral()}</Button
					>
					<Button
						size="sm"
						aria-pressed={view.checkPlaying === 1}
						loading={view.switching}
						onclick={() => void onCheck(1)}>{m.cable_blind_check_phone()}</Button
					>
				</div>
				<p class="status">
					{view.checkPlaying === 0
						? m.cable_blind_check_now_neutral()
						: view.checkPlaying === 1
							? m.cable_blind_check_now_phone()
							: ''}
				</p>
				<div class="actions">
					<Button
						variant="primary"
						size="sm"
						loading={busy}
						disabledReason={view.checkHeard[0] && view.checkHeard[1]
							? null
							: m.cable_blind_check_both()}
						onclick={(event: MouseEvent) => void onAnswer(event, true)}
						data-cable-blind-changed>{m.cable_blind_check_changed()}</Button
					>
					<Button
						size="sm"
						loading={busy}
						onclick={(event: MouseEvent) => void onAnswer(event, false)}
						data-cable-blind-unchanged>{m.cable_blind_check_unchanged()}</Button
					>
				</div>
			</div>
		{:else if phase === 'blind'}
			<ul class="notes">
				<li>{m.cable_blind_window()}</li>
				<li>{m.cable_blind_telemetry()}</li>
			</ul>
			<div class="actions">
				<Button size="sm" onclick={onStuck} data-cable-blind-stuck>{m.cable_blind_stuck()}</Button>
			</div>
		{:else if phase === 'paused' && view.pause !== null}
			<p class="pause" role="status" data-cable-blind-pause>
				{pauseText(view.pause)}
			</p>
			<p class="note">{m.cable_blind_resume_hint()}</p>
			{#if orphan}
				<p class="note" data-cable-blind-orphan>{m.cable_blind_reason_orphan()}</p>
				{@render dismissOrphan()}
			{/if}
			{@render levers()}
			<div class="actions">
				<Button
					variant="primary"
					size="sm"
					loading={busy}
					disabledReason={resumeReason}
					onclick={onResume}
					data-cable-blind-resume>{m.cable_blind_resume()}</Button
				>
			</div>
		{:else if phase === 'end-held'}
			{@render held()}
		{/if}
		{#if phase !== 'end-held' && phase !== 'ended'}
			<div class="actions">
				<Button
					variant="ghost"
					size="sm"
					loading={busy}
					disabledReason={endReason}
					onclick={onEnd}
					data-cable-blind-end>{m.cable_blind_end()}</Button
				>
				<Button
					variant="ghost"
					size="sm"
					loading={busy}
					onclick={() => void onEndKeep()}
					data-cable-blind-end-keep>{m.cable_blind_end_keep()}</Button
				>
			</div>
		{/if}
	{:else}
		<h3 id={`${id}-title`}>{m.cable_blind_title()}</h3>
		{#if phase === 'end-held'}{@render held()}{/if}
		{#if phase === 'paused' && view.pause !== null}
			<p class="pause" role="status" data-cable-blind-pause>
				{pauseText(view.pause)}
			</p>
		{/if}
		{#if endedText !== null}<p class="note" data-cable-blind-ended={view.endedReason}>
				{endedText}
			</p>{/if}
		<div class="actions">
			<Button
				variant="primary"
				size="sm"
				disabledReason={saveReason}
				loading={busy}
				onclick={() => void onSave()}
				data-cable-blind-save>{m.cable_blind_save_winner()}</Button
			>
			{#if phase !== 'ended' && phase !== 'end-held' && phase !== 'idle'}
				<Button
					size="sm"
					loading={busy}
					disabledReason={endReason}
					onclick={onEnd}
					data-cable-blind-end>{m.cable_blind_end()}</Button
				>
				<Button
					variant="ghost"
					size="sm"
					loading={busy}
					onclick={() => void onEndKeep()}
					data-cable-blind-end-keep>{m.cable_blind_end_keep()}</Button
				>
			{/if}
		</div>
		<p class="note">{m.cable_blind_save_hint()}</p>
	{/if}
	<p class="message" role="status" data-cable-blind-message>{message ?? ''}</p>
</section>

<style>
	.cable-blind {
		display: grid;
		gap: var(--space-2, 8px);
		margin: 0 0 14px;
		padding: 16px;
		border: 1px solid var(--rule);
		border-radius: var(--rad-2xl);
		background: #ffffff04;
		font-size: var(--fs-small);
	}
	h3,
	h4 {
		margin: 0;
		font-size: var(--fs-small);
		font-weight: 600;
	}
	p {
		margin: 0;
	}
	.note,
	.notes {
		color: var(--muted, #b5ad9f);
		font-size: var(--fs-caption);
	}
	.notes,
	.reasons {
		margin: 0;
		padding-left: 1.2em;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
	}
	.check,
	.hold,
	.refusal {
		display: grid;
		gap: var(--space-2, 8px);
		padding: var(--space-2, 8px) var(--space-3, 12px);
		border-radius: var(--rad-sm, 4px);
		background: color-mix(in srgb, #ece7dd 6%, transparent);
	}
	.hold,
	.refusal,
	.pause {
		border-left: 3px solid var(--warn, #e0a030);
	}
	.pause {
		padding-left: var(--space-2, 8px);
		color: #e8d3a6;
	}
	.refusal {
		border-left-color: var(--danger, #d04040);
	}
	.gate-line {
		display: flex;
		align-items: center;
		gap: 8px;
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
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.levers :global(.lever-cell) {
		flex: 1 1 140px;
	}
	.status:empty,
	.message:empty {
		display: none;
	}
</style>
