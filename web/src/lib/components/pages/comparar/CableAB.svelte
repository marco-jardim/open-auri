<!--
	"Comparar no cabo" (issue #73, X2 on the cable): the page's A and B lanes as a pre-approved,
	level-matched comparison set on the live (no-flash) cable preview.
	- Shown while the transport is live-capable and a cable is connected (or a comparison session
	  is still known). Locked, with the reason, mid-write, without a target cable, without two
	  different lanes, or while another live session runs (the Curva page's preview).
	- "Comparar no cabo" opens a compact checklist (inline, not modal): the set's verdict (the pure
	  `planComparison`, the same plan `startComparison` makes; a refusal names the side), the
	  volume lever and, mirroring `startComparison`, the experimental lever whenever any candidate
	  needs it. "Começar" mints the gesture in its click and calls `startComparison` with
	  [A, B] and `match` = the page's level-match toggle.
	- The lever "No cabo: A | B" is a radiogroup (arrow keys move and switch); A and B on the
	  keyboard choose, Space toggles (only outside form fields, buttons and other controls; the
	  page has no other A/B/Space keys). Each switch awaits `switchComparison`; the lamp shows
	  applying → live, and the last switch's latency is shown.
	- "Salvar esta" makes the session's cable the write target and opens the normal write
	  checklist on the ORIGINAL curve of the side that plays (`comparisonOriginal`), named after
	  its lane. "Encerrar" reverts (gesture; a held revert offers the volume confirmation, then
	  ends there); "Encerrar sem voltar" ends with the cable keeping the curve.
	- A change of A or B (curve, lane or the match toggle) ends the comparison: a stale set is
	  never switched. Leaving the page ends it without reverting.
	Read-only use of the service otherwise; the comparison semantics live in the service.
-->
<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { snapshotBands } from 'open-auri/dsp';
	import { THRESHOLDS } from 'open-auri/safety';
	import { m } from '#lib/paraglide/messages.js';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import { planComparison } from '#lib/cable/compare.ts';
	import { hasExperimentalKinds, hasUltrasonicBands, reasonView } from '#lib/cable/checklist.ts';
	import type {
		Band,
		ChecklistItemId,
		ChecklistResult,
		ComparisonCurve,
		ComparisonItem,
		ComparisonOutcome,
		ComparisonRefusal,
		ComparisonSwitchStatus
	} from '#lib/cable/types.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import Lamp, { type LampTone } from '#lib/components/primitives/Lamp.svelte';
	import ConfirmLever from '#lib/components/cable/ConfirmLever.svelte';
	import { describeReason, formatNumber } from '#lib/components/cable/i18n.ts';
	import {
		liveActive,
		liveHoldText,
		liveOutcomeText,
		liveRefusalText
	} from '#lib/components/cable/live.ts';
	import type { Track } from './comparison.ts';

	interface Props {
		app: ClientApp;
		/** The page's A lane (undefined without armed lanes). */
		a: Track | undefined;
		/** The page's B lane. */
		b: Track | undefined;
		/** The page's level-match toggle: the comparison's `match`. */
		matched: boolean;
	}

	let { app, a, b, matched }: Props = $props();

	type Side = 'A' | 'B';
	const SIDES: readonly Side[] = ['A', 'B'];
	const id = $props.id();

	const cable = $derived(app.cableState);
	const live = $derived(cable.live);
	const comparison = $derived(live?.comparison ?? null);
	/** This page's (non-blind) comparison runs. */
	const running = $derived(comparison !== null && comparison.active && !comparison.blind);
	/** Another live session (the Curva preview, a blind test) runs. */
	const otherLive = $derived(liveActive(live) && !running);
	const connected = $derived(cable.connection === 'connected');
	const shown = $derived(cable.liveCapable && (connected || comparison !== null));

	function experimentalOf(bands: readonly Band[]): boolean {
		try {
			return hasExperimentalKinds(bands) || hasUltrasonicBands(bands);
		} catch {
			// Unreadable bands: the gate refuses them anyway.
			return true;
		}
	}

	const pair = $derived<readonly [Track, Track] | null>(
		a !== undefined && b !== undefined && a.id !== b.id ? [a, b] : null
	);
	const curves = $derived<ComparisonCurve[] | null>(
		pair === null
			? null
			: pair.map((track) => ({
					bands: track.curve.bands,
					preampDb: track.curve.preampDb,
					experimental: experimentalOf(track.curve.bands)
				}))
	);
	/** What the set was made of: lanes, curves and the match toggle. */
	const signature = $derived(
		pair === null
			? null
			: JSON.stringify([
					matched,
					pair.map((track) => [track.id, track.curve.preampDb, track.curve.bands])
				])
	);

	function sideOf(index: number | null | undefined): Side {
		return index === 1 ? 'B' : 'A';
	}

	function refusalText(refusal: ComparisonRefusal): string {
		const side = sideOf(refusal.index);
		const reason = refusal.reason;
		switch (reason) {
			case 'too-few':
				return m.cable_x2_reason_pair();
			case 'gate':
				return refusal.matched === true
					? m.cable_x2_refused_gate_matched({ side })
					: m.cable_x2_refused_gate({ side });
			case 'level-unknown':
				return m.cable_x2_refused_level_unknown({ side });
			case 'level-range':
				return m.cable_x2_refused_level_range({
					side,
					floor: formatNumber(THRESHOLDS.preampMinDb, 1),
					preamp: formatNumber(refusal.preampDb ?? THRESHOLDS.preampMinDb, 1)
				});
			case 'yolo-unsupported':
				return refusal.index === undefined
					? m.cable_x2_refused_yolo_set()
					: m.cable_x2_refused_yolo({ side });
			default:
				// `bad-index`, an unreadable set: nothing the user can fix here.
				return m.cable_live_refused_error();
		}
	}

	function switchText(status: Exclude<ComparisonSwitchStatus, 'applied'>): string {
		switch (status) {
			case 'busy':
				return m.cable_x2_switch_busy();
			case 'unknown':
				return m.cable_x2_switch_unknown();
			case 'held':
				return m.cable_x2_switch_held();
			case 'ended':
				return m.cable_live_refused_no_session();
			case 'error':
				return m.cable_x2_switch_error();
			default:
				return status satisfies never;
		}
	}

	// --- start: the compact checklist ------------------------------------------------------------
	const UNCONFIRMED = { volumeLowered: false, experimental: false, androidUntested: false };
	let asking = $state(false);
	let starting = $state(false);
	let confirmations = $state({ ...UNCONFIRMED });
	/** The last start's refusal (the plan's own shows without it). */
	let refusal = $state.raw<ComparisonRefusal | null>(null);
	let message = $state<string | null>(null);
	let startButton = $state<HTMLButtonElement | undefined>();
	let checkGroup = $state<HTMLDivElement | undefined>();

	// A change of the set clears a refusal about the previous one.
	$effect(() => {
		void signature;
		untrack(() => {
			refusal = null;
		});
	});

	/** The plan `startComparison` will make (pure, no I/O): its refusal shows before starting. */
	const plan = $derived(
		asking && curves !== null ? planComparison(curves, { match: matched }) : null
	);
	/** The loudest played candidate: `startComparison` runs the live checklist on it. */
	const loudest = $derived(
		plan?.items.reduce<ComparisonItem | undefined>(
			(best, item) => (best === undefined || item.levelDb > best.levelDb ? item : best),
			undefined
		)
	);
	const checklist = $derived.by<ChecklistResult | null>(() => {
		// Re-evaluated on every cable state change (target, flash, live level).
		void cable;
		if (plan === null || plan.refusal !== undefined || loudest === undefined) return null;
		return app.cable.liveChecklist(
			{
				bands: loudest.bands,
				preampDb: loudest.preampDb,
				experimental: plan.experimental,
				confirmations: { ...confirmations, keepConnected: false }
			},
			loudest.verdict
		);
	});
	/** Mirrors `startComparison`: required when any candidate needs it, not only the loudest. */
	const experimentalRequired = $derived(
		(checklist?.experimentalRequired ?? false) || (plan?.experimentalRequired ?? false)
	);
	const required = (item: ChecklistItemId) =>
		checklist?.items.some((entry) => entry.id === item && entry.required) ?? false;
	const shownRefusal = $derived(refusal ?? plan?.refusal ?? null);
	const refusalReasons = $derived(
		(shownRefusal?.gateReasons ?? []).map((reason) => describeReason(reasonView(reason)))
	);

	/** Why "Comparar no cabo" is locked, or null. */
	const startReason = $derived.by<string | null>(() => {
		if (cable.writing) return m.cable_live_reason_writing();
		if (otherLive) return m.cable_x2_reason_live();
		if (cable.device === null) return m.cable_live_reason_target();
		if (pair === null) return m.cable_x2_reason_pair();
		return null;
	});

	/** Why "Começar" is locked (first unmet item), or null. */
	const goReason = $derived.by<string | null>(() => {
		if (startReason !== null) return startReason;
		if (shownRefusal !== null) return refusalText(shownRefusal);
		if (checklist === null) return m.cable_fux_lock_other();
		const unmet = (item: ChecklistItemId) =>
			checklist.items.some((entry) => entry.id === item && entry.required && !entry.satisfied);
		if (unmet('gate')) return m.cable_fux_lock_gate();
		if (unmet('volume')) return m.cable_live_lock_volume();
		if (experimentalRequired && !confirmations.experimental) {
			return m.cable_fux_lock_experimental();
		}
		if (unmet('android-untested')) return m.cable_lock_android_untested();
		const other = checklist.items.some(
			(entry) => entry.id !== 'experimental' && entry.required && !entry.satisfied
		);
		return other ? m.cable_fux_lock_other() : null;
	});

	async function openAsk() {
		if (startReason !== null) return;
		confirmations = { ...UNCONFIRMED };
		refusal = null;
		message = null;
		asking = true;
		await tick();
		checkGroup?.querySelector<HTMLInputElement>('input:not([disabled])')?.focus();
	}

	async function cancelAsk() {
		if (starting) return;
		asking = false;
		await tick();
		startButton?.focus();
	}

	function onCheckKey(event: KeyboardEvent) {
		if (event.key !== 'Escape' || starting) return;
		event.preventDefault();
		event.stopPropagation();
		void cancelAsk();
	}

	// --- the running comparison ------------------------------------------------------------------
	/** The lanes the running set was started with (names, "Salvar esta"). */
	let startedTracks = $state.raw<readonly [Track, Track] | null>(null);
	let startedMatch = $state(true);
	/** Signature of the running set (plain: compared, never rendered). */
	let startedSignature: string | null = null;
	/** A switch in flight: its target index. */
	let switching = $state<number | null>(null);
	let latency = $state<number | null>(null);
	let busy = $state(false);
	/** Why this page ended the comparison (lanes changed, a confirmed revert), else null. */
	let endNote = $state<string | null>(null);
	const radios: (HTMLButtonElement | undefined)[] = $state([]);

	const items = $derived(running ? (comparison?.items ?? []) : []);
	const playingIndex = $derived(running ? (comparison?.index ?? null) : null);
	const selectedIndex = $derived(switching ?? playingIndex);
	const applying = $derived(switching !== null || comparison?.status === 'applying');
	const hold = $derived(running ? (live?.hold ?? null) : null);
	const lamp = $derived.by<{ on: boolean; tone: LampTone }>(() => {
		if (!running) return { on: false, tone: 'ok' };
		if (applying) return { on: true, tone: 'warn' };
		if (comparison?.status === 'failed') return { on: true, tone: 'danger' };
		return { on: true, tone: 'ok' };
	});
	const statusText = $derived.by(() => {
		if (!running) return '';
		if (applying) return m.cable_x2_applying();
		if (comparison?.status === 'failed' || playingIndex === null) return m.cable_x2_failed();
		return m.cable_x2_now({ side: sideOf(playingIndex) });
	});

	const fmt = (value: number, digits = 1, signed = false) => formatNumber(value, digits, signed);
	const levelsText = $derived.by(() => {
		const [first, second] = items;
		if (first === undefined || second === undefined) return null;
		const values = { a: fmt(first.levelDb), b: fmt(second.levelDb) };
		return startedMatch ? m.cable_x2_levels(values) : m.cable_x2_levels_raw(values);
	});
	const preampsText = $derived.by(() => {
		const [first, second] = items;
		if (first === undefined || second === undefined) return null;
		return m.cable_x2_preamps({ a: fmt(first.preampDb), b: fmt(second.preampDb) });
	});
	const residualText = $derived.by(() => {
		const [first, second] = items;
		if (!startedMatch || first === undefined || second === undefined) return null;
		return m.cable_x2_residual({
			a: fmt(first.residualDb, 2, true),
			b: fmt(second.residualDb, 2, true)
		});
	});

	const saveReason = $derived.by<string | null>(() => {
		if (cable.writing) return m.cable_live_reason_writing();
		if (applying || playingIndex === null) return m.cable_live_save_wait();
		if (hold !== null) return m.cable_live_save_held();
		return null;
	});

	async function focusLever() {
		await tick();
		radios[selectedIndex ?? 0]?.focus();
	}

	async function focusStart() {
		await tick();
		startButton?.focus();
	}

	// The gesture token is minted synchronously, inside this click.
	async function onGo(event: MouseEvent) {
		if (starting || goReason !== null || curves === null || pair === null) return;
		const gesture = app.cable.createGesture(event);
		const sent = curves;
		const tracks = pair;
		const match = matched;
		const signatureNow = signature;
		starting = true;
		message = null;
		refusal = null;
		let outcome: ComparisonOutcome;
		try {
			outcome = await app.cable.startComparison({
				curves: sent,
				match,
				blind: false,
				confirmations: { ...confirmations },
				gesture
			});
		} finally {
			starting = false;
		}
		if (outcome.status === 'accepted') {
			startedTracks = tracks;
			startedMatch = match;
			startedSignature = signatureNow;
			latency = null;
			endNote = null;
			asking = false;
			// The lanes changed while starting: never keep a stale set.
			if (signature !== signatureNow) {
				await endStale();
				return;
			}
			await focusLever();
			return;
		}
		if (outcome.reason === 'comparison') {
			refusal = outcome.refusal;
			message = refusalText(outcome.refusal);
			return;
		}
		message = liveRefusalText[outcome.reason]();
	}

	/** Switches the cable to candidate `index` (A: 0, B: 1) and waits for it. */
	async function choose(index: number) {
		if (!running || switching !== null || busy) return;
		if (startedSignature === null || signature !== startedSignature) {
			await endStale();
			return;
		}
		if (index === playingIndex && comparison?.status === 'ready') return;
		switching = index;
		message = null;
		const begin = performance.now();
		let status: ComparisonSwitchStatus;
		try {
			({ status } = await app.cable.switchComparison(index));
		} finally {
			switching = null;
		}
		if (status === 'applied') latency = Math.max(0, Math.round(performance.now() - begin));
		else message = switchText(status);
	}

	function onRadioKey(event: KeyboardEvent, index: number) {
		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
		event.preventDefault();
		const next = index === 0 ? 1 : 0;
		radios[next]?.focus();
		void choose(next);
	}

	/** A and B choose, Space toggles: never inside form fields, other controls or dialogs. */
	function onKeydown(event: KeyboardEvent) {
		if (
			!running ||
			event.defaultPrevented ||
			event.repeat ||
			event.isComposing ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey
		) {
			return;
		}
		const key = event.key;
		const lower = key.toLowerCase();
		if (lower !== 'a' && lower !== 'b' && key !== ' ') return;
		const target = event.target;
		if (
			target instanceof Element &&
			target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
		) {
			return;
		}
		// Space activates a focused control (a radio of the lever included): leave it to it.
		if (
			key === ' ' &&
			target instanceof Element &&
			target.closest(
				'button, a[href], summary, [role="button"], [role="radio"], [role="switch"], [role="checkbox"], [role="slider"], [role="tab"], [role="menuitem"], [role="option"]'
			)
		) {
			return;
		}
		if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
		event.preventDefault();
		const index = key === ' ' ? (selectedIndex === 0 ? 1 : 0) : lower === 'a' ? 0 : 1;
		void choose(index);
	}

	/** "Salvar esta": the normal write checklist on the original curve of the side that plays. */
	function onSave() {
		const index = playingIndex;
		const tracks = startedTracks;
		if (!running || index === null || tracks === null || saveReason !== null) return;
		const track = tracks[index];
		const original = app.cable.comparisonOriginal(index);
		if (track === undefined || original === null) return;
		// The save goes to the cable that plays it (the target may have moved).
		if (!app.cable.selectLiveCable()) return;
		app.requestWrite({
			schema: 1,
			updatedAt: Date.now(),
			name: track.curve.name,
			source: track.curve.source,
			labels: track.curve.labels ?? null,
			bands: snapshotBands(original.bands),
			preampDb: original.preampDb
		});
	}

	async function ended() {
		startedSignature = null;
		await focusStart();
	}

	async function onEnd(event: MouseEvent) {
		if (busy || switching !== null) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		message = null;
		try {
			const outcome = await app.cable.endComparison({ revert: true, gesture });
			if (outcome.status === 'accepted') {
				endNote = null;
				await ended();
				return;
			}
			// A held revert shows its banner (the volume confirmation); the session goes on.
			message = liveOutcomeText(outcome);
		} finally {
			busy = false;
		}
	}

	async function onEndKeep() {
		if (busy || switching !== null) return;
		busy = true;
		message = null;
		try {
			const outcome = await app.cable.endComparison({ revert: false });
			if (outcome.status === 'accepted') {
				endNote = null;
				await ended();
				return;
			}
			message = liveOutcomeText(outcome);
		} finally {
			busy = false;
		}
	}

	/**
	 * The held revert ("Abaixei o volume, aplicar"): this click confirms the saved curve's level;
	 * once the cable plays it, the comparison ends there.
	 */
	async function onConfirmRevert(event: MouseEvent) {
		if (busy) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		message = null;
		try {
			const outcome = await app.cable.confirmLive({ gesture });
			if (outcome.status !== 'accepted') {
				message = liveOutcomeText(outcome);
				return;
			}
			const now = app.cable.getState().live;
			const savedCrc = now?.savedCrc;
			if (
				now === null ||
				now.hold !== null ||
				now.applied === null ||
				(typeof savedCrc === 'number' && now.applied.crc !== savedCrc)
			) {
				message = m.cable_live_refused_revert_failed();
				return;
			}
			const end = await app.cable.endComparison({ revert: false });
			if (end.status === 'accepted') {
				endNote = m.cable_live_ended_reverted();
				await ended();
				return;
			}
			message = liveOutcomeText(end);
		} finally {
			busy = false;
		}
	}

	/** The lanes (or the match toggle) changed: end without reverting, say why. */
	async function endStale() {
		startedSignature = null;
		const state = app.cable.getState().live;
		if (state?.comparison?.active !== true || state.comparison.blind) return;
		const outcome = await app.cable.endComparison({ revert: false });
		endNote = m.cable_x2_lanes_changed();
		message = outcome.status === 'accepted' ? null : liveOutcomeText(outcome);
	}

	$effect(() => {
		const now = signature;
		if (!running) return;
		untrack(() => {
			if (startedSignature !== null && now !== startedSignature) void endStale();
		});
	});

	// Leaving the page: the comparison ends, the cable keeps its curve until unplugged.
	onDestroy(() => {
		const state = app.cable.getState().live;
		if (state?.comparison?.active === true && !state.comparison.blind) {
			void app.cable.endComparison({ revert: false });
		}
	});

	const endedText = $derived.by<string | null>(() => {
		if (running || comparison === null || comparison.blind || live === null) return null;
		if (live.status !== 'ended') return null;
		if (endNote !== null) return endNote;
		switch (live.endedReason) {
			case 'reverted':
				return m.cable_live_ended_reverted();
			case 'stopped':
				return m.cable_x2_ended_stopped();
			case 'disconnected':
				return m.cable_live_ended_disconnected();
			case 'forgotten':
				return m.cable_live_ended_forgotten();
			default:
				return null;
		}
	});

	// --- announcements (a persistent polite region, updated by text) ----------------------------
	let announcement = $state('');
	let announcedKey: string | null = null;
	$effect(() => {
		const ready = running && comparison?.status === 'ready' && playingIndex !== null;
		const key = ready ? `side:${playingIndex}` : endedText !== null ? `ended:${endedText}` : null;
		const text = ready ? m.cable_x2_now({ side: sideOf(playingIndex) }) : endedText;
		untrack(() => {
			if (key === null || key === announcedKey) return;
			announcedKey = key;
			announcement = text ?? '';
		});
	});
</script>

<svelte:window onkeydown={onKeydown} />

{#if shown}
	<section class="cable-ab" aria-labelledby={`${id}-title`} data-cable-ab>
		<h3 id={`${id}-title`} class="title">{m.cable_x2_title()}</h3>
		{#if running}
			<div class="lever-row">
				<Lamp on={lamp.on} tone={lamp.tone} data-cable-ab-lamp={lamp.tone} />
				<div
					class="lever"
					role="radiogroup"
					aria-label={m.cable_x2_lever()}
					aria-describedby={`${id}-keys`}
					data-cable-ab-lever
				>
					{#each SIDES as side, index (side)}
						<button
							type="button"
							role="radio"
							class="side"
							aria-checked={selectedIndex === index}
							tabindex={(selectedIndex ?? 0) === index ? 0 : -1}
							bind:this={radios[index]}
							onclick={() => void choose(index)}
							onkeydown={(event) => onRadioKey(event, index)}
							data-side={side}
							>{m.cable_x2_side({ side, name: startedTracks?.[index]?.curve.name ?? side })}</button
						>
					{/each}
				</div>
				<span class="status" data-cable-ab-status>{statusText}</span>
			</div>
			<ul class="readout">
				{#if levelsText !== null}<li data-cable-ab-levels>{levelsText}</li>{/if}
				{#if preampsText !== null}<li data-cable-ab-preamps>{preampsText}</li>{/if}
				{#if residualText !== null}<li data-cable-ab-residual>{residualText}</li>{/if}
				{#if latency !== null}
					<li data-cable-ab-latency>{m.cable_x2_latency({ ms: String(latency) })}</li>
				{/if}
			</ul>
			<p id={`${id}-keys`} class="hint">{m.cable_x2_keys()}</p>

			{#if hold !== null}
				<div class="hold" data-cable-ab-hold={hold.reason}>
					<p>{liveHoldText(hold, hold.curve === 'saved' ? 'saved' : 'editor')}</p>
					{#if hold.reason === 'loudness' && hold.curve === 'saved'}
						<Button variant="primary" size="sm" loading={busy} onclick={onConfirmRevert}
							>{m.cable_live_hold_loudness_confirm()}</Button
						>
					{/if}
				</div>
			{/if}

			<div class="actions">
				<Button size="sm" disabledReason={saveReason} onclick={onSave} data-cable-ab-save
					>{m.cable_x2_save()}</Button
				>
				<Button variant="primary" size="sm" loading={busy} onclick={onEnd} data-cable-ab-end
					>{m.cable_x2_end()}</Button
				>
				<Button variant="ghost" size="sm" loading={busy} onclick={onEndKeep} data-cable-ab-keep
					>{m.cable_x2_end_keep()}</Button
				>
			</div>
			<ul class="notes">
				<li>{m.cable_x2_end_hint()}</li>
				<li>{m.cable_x2_browser_flat()}</li>
				<li>{m.cable_live_stuck_note()}</li>
			</ul>
		{:else}
			<div class="start-row">
				<Button
					variant="plate"
					size="sm"
					bind:element={startButton}
					aria-expanded={asking}
					aria-controls={`${id}-check`}
					disabledReason={startReason}
					onclick={() => void openAsk()}
					data-cable-ab-start>{m.cable_x2_start()}</Button
				>
				<small class="hint">{m.cable_x2_intro()}</small>
			</div>
			{#if asking}
				<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
				<div
					id={`${id}-check`}
					class="check"
					role="group"
					aria-labelledby={`${id}-check-title`}
					bind:this={checkGroup}
					onkeydown={onCheckKey}
					data-cable-ab-checklist
				>
					<h4 id={`${id}-check-title`} class="check-title">{m.cable_x2_checklist_title()}</h4>
					<p>{matched ? m.cable_x2_match_on() : m.cable_x2_match_off()}</p>
					{#if shownRefusal !== null}
						<div class="refusal" data-cable-ab-refusal={shownRefusal.reason}>
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
						<p class="gate-line" data-cable-ab-gate={checklist.gateOk}>
							<Lamp on={true} tone={checklist.gateOk ? 'ok' : 'danger'} />
							<span>{checklist.gateOk ? m.cable_x2_gate_ok() : m.cable_live_gate_fail()}</span>
						</p>
						{#if !checklist.gateOk && checklist.reasons.length > 0}
							<ul class="reasons">
								{#each checklist.reasons as reason, index (index)}
									<li>{describeReason(reason)}</li>
								{/each}
							</ul>
						{/if}
					{/if}
					{#if experimentalRequired}
						<p class="experimental">{m.cable_experimental_text()}</p>
					{/if}
					<fieldset class="levers" disabled={starting}>
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
						{#if required('android-untested')}
							<ConfirmLever
								bind:checked={confirmations.androidUntested}
								label={m.cable_confirm_android_untested()}
								confirmation="android-untested"
							/>
						{/if}
					</fieldset>
					<div class="actions">
						<Button variant="plate" size="sm" loading={starting} onclick={() => void cancelAsk()}
							>{m.cable_live_cancel()}</Button
						>
						<Button
							variant="primary"
							size="sm"
							disabledReason={goReason}
							loading={starting}
							onclick={onGo}
							data-cable-ab-go>{m.cable_live_start()}</Button
						>
					</div>
				</div>
			{/if}
		{/if}

		{#if endedText !== null}
			<p class="ended" data-cable-ab-ended={live?.endedReason}>{endedText}</p>
		{/if}
		<p class="sr-only" role="status" data-cable-ab-announce>{announcement}</p>
		<p class="message" role="status" data-cable-ab-message>{message ?? ''}</p>
	</section>
{/if}

<style>
	.cable-ab {
		display: grid;
		gap: var(--space-2, 8px);
		margin-top: var(--space-3, 12px);
		padding: var(--space-3, 12px) var(--space-4, 16px);
		border: 1px solid var(--rule, #333);
		border-radius: var(--rad-lg, 8px);
		background: color-mix(in srgb, var(--text, #eee) 4%, transparent);
		font-size: var(--fs-small, 13px);
	}
	.title,
	.check-title {
		margin: 0;
		font: 600 var(--fs-ui, 14px) / 1.2 var(--face-body, sans-serif);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.lever-row,
	.start-row,
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 8px) var(--space-3, 12px);
	}
	.lever {
		display: inline-flex;
		border: 1px solid var(--rule, #333);
		border-radius: var(--rad-pill, 999px);
		overflow: hidden;
	}
	.side {
		min-height: 32px;
		padding: 4px 14px;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.side[aria-checked='true'] {
		background: var(--accent, #1b7f76);
		color: #fff;
	}
	.side:focus-visible {
		outline: 2px solid var(--focus, #f2b33d);
		outline-offset: -2px;
	}
	.hint,
	.notes {
		color: var(--text-2, #bbb);
	}
	.readout,
	.notes,
	.reasons {
		margin: 0;
		padding-left: 1.2em;
	}
	.readout {
		font-family: var(--face-data, monospace);
		font-variant-numeric: tabular-nums;
	}
	.hint,
	.check p,
	.hold p,
	.ended,
	.message {
		margin: 0;
	}
	.check,
	.hold,
	.refusal {
		display: grid;
		gap: var(--space-2, 8px);
		padding: var(--space-2, 8px) var(--space-3, 12px);
		border-radius: var(--rad-sm, 4px);
		background: color-mix(in srgb, var(--text, #eee) 6%, transparent);
	}
	.hold,
	.refusal {
		border-left: 3px solid var(--warn, #e0a030);
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
	.message:empty {
		display: none;
	}
</style>
