<!--
	"Ouvir no cabo" (issue #69): the live (no-flash) preview of the editor curve on the cable.
	- The switch shows only when the transport is live-capable and a cable is connected (or a
	  session still runs); other blocks (loading, a write, no target, the free preview) say why.
	  On: the live checklist (LiveChecklist; its "Começar" mints the gesture and calls
	  `startLive`; another tab's session is refused there with `live-elsewhere`). Off: a group
	  (Escape cancels; focus goes back to the switch) with "Voltar à curva salva" (default;
	  gesture, `stopLive({ revert: true })`) or "Manter até desconectar" (`stopLive({ revert:
	  false })`). A failed revert keeps the group open and says why.
	- Edits and the A/B lever reach the cable through the page (`queueLive`), not here.
	- The amber chip "No cabo: prévia não salva" shows while the cable plays something other than
	  the saved curve: "Salvar no cabo" opens the normal write checklist on the applied curve (its
	  label says which curve; another curve than the editor's is saved under a neutral name),
	  locked while the cable is still changing or a hold waits, and during and after a blind
	  comparison (the playing curve is hidden; it says why); "Voltar à curva salva" calls
	  `revertLive` (gesture; refused while a comparison runs: it ends from the comparison).
	- Holds (loudness, gate, unknown state, experimental) show a banner; a hold's appearance is
	  announced once through a persistent alert region, and live / ended transitions once through a
	  persistent polite region ("applying" is visual only).
	- A blind test on the cable (issue #74): one constant line, "Teste cego em andamento", replaces
	  the status, holds, errors and the chip; the switch is locked (the test ends on its own page).
	- An orphan preview (another tab, or this one before a reload) says to unplug and replug;
	  "Já desconectei" clears it (`dismissLiveOrphan`). A replug clears it on its own.
	- "Salvar no cabo" shows only while a session runs (it makes the session's cable the target,
	  `selectLiveCable`), or for a kept curve whose cable is still connected and is the write
	  target (`liveSavable`).
	Every service call that needs a gesture mints it synchronously in its click handler.
-->
<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { ClientApp } from '#lib/app/index.ts';
	import type { CableState, LiveOutcome } from '#lib/cable/types.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import LiveChecklist from '#lib/components/cable/LiveChecklist.svelte';
	import {
		liveActive,
		liveHoldAction,
		liveHoldText,
		liveOutcomeText,
		livePlaying,
		liveSavable,
		liveSaveLabel,
		liveBlind,
		liveUnsaved,
		type LiveHeldCurve
	} from '#lib/components/cable/live.ts';
	import type { Curve } from './model.ts';
	import { firstReasonText } from './reasons.ts';

	interface Props {
		app: ClientApp | null;
		/** The editor curve: what a session starts with. */
		curve: Curve;
		/** The editor curve has HS/LP/HP (the session's gate accepts them; confirmation required). */
		experimental: boolean;
		/** Gate profile of the session (Modo YOLO while it is on). */
		profile: 'standard' | 'yolo';
		/** The last saved (written) curve, or null when this browser never wrote one. */
		saved: Curve | null;
		/** CRC-16 an accepted revert left on the cable (the saved curve), or null. */
		savedCrc?: number | null;
		/** Whose curve the page last sent to the cable (a hold describes it). */
		heldCurve?: LiveHeldCurve;
		/** The free preview is on: edits do not reach the cable until it is off. */
		followPaused?: boolean;
		/** Why the page itself blocks starting (loading, the free preview), or null. */
		blockedReason: string | null;
		locale: string;
		/** Called in the "Começar" click, right before `startLive`, with the curve it sends. */
		onbeforestart?: (curve: Curve) => void;
		/** A revert ended (accepted, or `revert-failed`): what the cable should play now is A. */
		onrevert?: (outcome: LiveOutcome) => void;
	}

	let {
		app,
		curve,
		experimental,
		profile,
		saved,
		savedCrc = null,
		heldCurve = 'editor',
		followPaused = false,
		blockedReason,
		locale,
		onbeforestart,
		onrevert
	}: Props = $props();

	const id = $props.id();
	const cable = $derived<CableState | null>(app?.cableState ?? null);
	const live = $derived(cable?.live ?? null);
	const active = $derived(liveActive(live));
	/**
	 * A blind test runs on the cable (issue #74): one constant line replaces the status, holds,
	 * errors and the unsaved chip, so nothing here changes with the playing candidate.
	 */
	const blind = $derived(liveBlind(live));
	const connected = $derived(cable?.connection === 'connected');
	const orphan = $derived(cable?.liveOrphan ?? null);
	const unsaved = $derived(!blind && liveUnsaved(live, saved, savedCrc));
	const hold = $derived(active && !blind ? (live?.hold ?? null) : null);
	const capable = $derived(cable !== null && cable.liveCapable && (connected || live !== null));
	const shown = $derived(capable || orphan !== null);
	/** Which curve the cable plays: the saved one (A), the editor's (B) or another one. */
	const playing = $derived(
		livePlaying(live, saved, curve, {
			savedCrc,
			prefer: heldCurve === 'saved' ? 'saved' : 'editor'
		})
	);

	let checklistOpen = $state(false);
	let offAsk = $state(false);
	let busy = $state(false);
	let message = $state<string | null>(null);
	let dismissed = $state(false);
	let offFirst = $state<HTMLButtonElement | undefined>();
	let switchElement = $state<HTMLButtonElement | undefined>();

	// A new session: the previous end message and refusals no longer apply.
	let wasActive = false;
	$effect(() => {
		const now = active;
		if (now && !wasActive) {
			dismissed = false;
			message = null;
		}
		if (!now) offAsk = false;
		wasActive = now;
	});

	const switchReason = $derived.by<string | null>(() => {
		// The blind test owns the session: it ends there (Encerrar), never from here.
		if (blind) return m.cable_blind_panel_reason();
		if (active) return null;
		if (blockedReason !== null) return blockedReason;
		if (cable === null) return m.curva_v2_loading_reason();
		if (cable.writing) return m.cable_live_reason_writing();
		if (cable.device === null) return m.cable_live_reason_target();
		return null;
	});

	const statusText = $derived.by(() => {
		if (!active || live === null) return '';
		if (blind) return m.cable_blind_chrome();
		switch (live.status) {
			case 'starting':
				return m.cable_live_status_starting();
			case 'applying':
				return m.cable_live_status_applying();
			case 'held':
				return m.cable_live_status_held();
			case 'unknown':
				return m.cable_live_status_unknown();
			default:
				return playing === 'saved'
					? m.cable_live_status_saved({ device: live.deviceLabel })
					: m.cable_live_status_live({ device: live.deviceLabel });
		}
	});

	const endedMessage = $derived.by(() => {
		if (live === null || live.status !== 'ended') return null;
		switch (live.endedReason) {
			case 'disconnected':
				return m.cable_live_ended_disconnected();
			case 'reverted':
				return m.cable_live_ended_reverted();
			case 'stopped':
				return m.cable_live_ended_stopped();
			case 'forgotten':
				return m.cable_live_ended_forgotten();
			default:
				return null;
		}
	});
	const endedText = $derived(dismissed ? null : endedMessage);

	/** Whose curve the hold stopped: the service flags a held revert; otherwise the page's side. */
	const heldNow = $derived<LiveHeldCurve>(hold?.curve === 'saved' ? 'saved' : heldCurve);
	const holdText = $derived(hold === null ? '' : liveHoldText(hold, heldNow));
	const holdAction = $derived(hold === null ? null : liveHoldAction(hold));
	const holdReason = $derived(
		hold?.reason === 'gate' && hold.gateReasons !== undefined && hold.gateReasons.length > 0
			? m.cable_live_hold_gate_reason({
					reason: firstReasonText(hold.gateReasons, {
						bands: heldNow === 'saved' && saved !== null ? saved.bands : curve.bands,
						locale
					})
				})
			: null
	);

	// --- announcements (persistent regions, updated by text) ------------------------------------
	/** Polite: the session plays (the saved curve or a preview), its state is unknown, it ended. */
	let announcement = $state('');
	let announcedKey: string | null = null;
	$effect(() => {
		const session = live;
		const status = session?.status ?? null;
		const savedNow = playing === 'saved';
		const text = statusText;
		const ended = endedMessage;
		const blindNow = blind;
		untrack(() => {
			if (session === null) {
				announcedKey = null;
				return;
			}
			// A blind test: one constant announcement for the whole run, whatever the status.
			if (blindNow) {
				if (announcedKey !== 'blind') {
					announcedKey = 'blind';
					announcement = text;
				}
				return;
			}
			// Starting and applying are visual only; a hold has its own (alert) announcement.
			if (status === 'starting' || status === 'applying' || status === 'held') return;
			const key =
				status === 'ended'
					? `ended:${session.endedReason ?? ''}`
					: status === 'unknown'
						? 'unknown'
						: `live:${savedNow ? 'saved' : 'preview'}`;
			if (key === announcedKey) return;
			announcedKey = key;
			announcement = status === 'ended' ? (ended ?? '') : text;
		});
	});

	/** Assertive: a hold appeared (once per reason until the cable plays cleanly again). */
	let holdAlert = $state('');
	let alertedReason: string | null = null;
	$effect(() => {
		const current = hold;
		const status = live?.status ?? null;
		const pending = live?.pending ?? false;
		const text = holdText;
		untrack(() => {
			if (current === null) {
				// Between edits (pending, applying) the same hold may come back: not announced again.
				if (status !== 'starting' && status !== 'applying' && !pending) {
					alertedReason = null;
					holdAlert = '';
				}
				return;
			}
			if (current.reason === alertedReason) return;
			alertedReason = current.reason;
			holdAlert = text;
		});
	});

	// --- "Salvar no cabo" -----------------------------------------------------------------------
	/** Why saving the applied curve is not possible right now, or null. */
	const saveReason = $derived.by<string | null>(() => {
		if (cable?.writing) return m.cable_live_reason_writing();
		// A blind comparison hides the playing curve (and refuses saves while it runs): the
		// candidate is saved from the comparison's result ("Salvar esta") once it ended.
		if (live?.comparison?.blind === true) {
			return active ? m.cable_live_save_blind() : m.cable_live_save_blind_ended();
		}
		if (live === null || live.applied === null) return m.cable_live_save_wait();
		if (active && (live.pending || live.status === 'starting' || live.status === 'applying')) {
			return m.cable_live_save_wait();
		}
		if (hold !== null) return m.cable_live_save_held();
		return null;
	});
	const saveLabel = $derived(liveSaveLabel(playing));
	/**
	 * Saving what the cable plays applies to a running session, or to a kept one whose cable is
	 * still connected and is the write target (a save always goes to the target).
	 */
	const savable = $derived(liveSavable(cable));

	/** "Já desconectei": the orphan's cable was unplugged while no tab watched. */
	function onOrphanDismiss() {
		app?.cable.dismissLiveOrphan();
	}

	function report(outcome: LiveOutcome): boolean {
		message = liveOutcomeText(outcome);
		return outcome.status === 'accepted';
	}

	/** A revert result for the page (accepted or failed: the page's target is A now). */
	function reverted(outcome: LiveOutcome) {
		if (outcome.status === 'accepted' || outcome.reason === 'revert-failed') onrevert?.(outcome);
	}

	/** The saved curve the revert applies (else the service's own: this page's last save, the journal). */
	function savedCurve() {
		return saved === null ? {} : { saved: { bands: saved.bands, preampDb: saved.preampDb } };
	}

	async function focusSwitch() {
		await tick();
		switchElement?.focus();
	}

	async function onSwitch() {
		if (!app || blind) return;
		if (active) {
			if (offAsk) {
				cancelOff();
				return;
			}
			offAsk = true;
			await tick();
			offFirst?.focus();
			return;
		}
		if (switchReason !== null) return;
		message = null;
		checklistOpen = true;
	}

	function cancelOff() {
		offAsk = false;
		void focusSwitch();
	}

	function onOffKey(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		event.stopPropagation();
		cancelOff();
	}

	async function onOffRevert(event: MouseEvent) {
		if (!app || busy) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		try {
			const outcome = await app.cable.stopLive({ revert: true, gesture, ...savedCurve() });
			reverted(outcome);
			// A failed revert keeps the choice open (the session goes on).
			if (report(outcome)) {
				offAsk = false;
				void focusSwitch();
			}
		} finally {
			busy = false;
		}
	}

	async function onOffKeep() {
		if (!app || busy) return;
		busy = true;
		try {
			if (report(await app.cable.stopLive({ revert: false }))) {
				offAsk = false;
				void focusSwitch();
			}
		} finally {
			busy = false;
		}
	}

	async function onRevert(event: MouseEvent) {
		if (!app || busy) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		try {
			const outcome = await app.cable.revertLive({ gesture, ...savedCurve() });
			reverted(outcome);
			report(outcome);
		} finally {
			busy = false;
		}
	}

	async function onConfirm(event: MouseEvent) {
		if (!app || busy) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		try {
			report(await app.cable.confirmLive({ gesture }));
		} finally {
			busy = false;
		}
	}

	/** The experimental hold: this click is the experimental confirmation for the session. */
	async function onConfirmExperimental(event: MouseEvent) {
		if (!app || busy) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		try {
			report(await app.cable.confirmLive({ gesture, confirmations: { experimental: true } }));
		} finally {
			busy = false;
		}
	}

	/**
	 * "Salvar no cabo": the normal write checklist, on the curve the cable plays now. The editor's
	 * name and filter labels go with it only when it is the editor's curve.
	 */
	function onSave() {
		const applied = live?.applied;
		if (!app || !applied || !savable || saveReason !== null) return;
		// A running session: the save goes to the cable that plays it (the target may have moved).
		if (active && !app.cable.selectLiveCable()) return;
		const current = app.state.curve.current;
		const base =
			playing === 'editor'
				? current
				: {
						schema: current.schema,
						updatedAt: current.updatedAt,
						name: m.cable_live_save_name(),
						source: 'custom' as const,
						labels: null
					};
		app.requestWrite(
			{ ...base, bands: applied.bands, preampDb: applied.preampDb },
			applied.profile === 'yolo' ? { profile: 'yolo' } : {}
		);
	}
</script>

{#if shown}
	<section class="live" aria-label={m.cable_live_switch()} data-live-panel>
		{#if capable && (connected || active)}
			<div class="switch-row">
				<Button
					variant="plate"
					size="sm"
					role="switch"
					aria-checked={active}
					aria-expanded={active ? offAsk : undefined}
					aria-controls={active ? `${id}-off-group` : undefined}
					aria-describedby={`${id}-hint`}
					class="live-switch"
					bind:element={switchElement}
					disabledReason={switchReason}
					onclick={onSwitch}
				>
					<span class="track" data-on={active} aria-hidden="true"><span class="knob"></span></span>
					<span>{m.cable_live_switch()}</span>
				</Button>
				<small id={`${id}-hint`} class="hint">{m.cable_live_switch_hint()}</small>
			</div>
		{/if}

		<!-- Visual status; screen readers get the transitions once, from the regions below. -->
		<p class="status" data-live-status>{statusText}</p>
		<p class="sr-only" role="status" data-live-announce>{announcement}</p>
		<div class="sr-only" role="alert" data-live-alert>{holdAlert}</div>

		{#if orphan !== null}
			<div class="orphan" data-live-orphan>
				<p>{m.cable_live_orphan()}</p>
				<Button variant="ghost" size="sm" onclick={onOrphanDismiss} data-live-orphan-dismiss
					>{m.cable_live_orphan_dismiss()}</Button
				>
			</div>
		{/if}

		{#if offAsk && active && !blind}
			<div
				id={`${id}-off-group`}
				class="off-ask"
				role="group"
				aria-labelledby={`${id}-off`}
				data-live-off
			>
				<p id={`${id}-off`}>{m.cable_live_off_question()}</p>
				<div class="actions">
					<Button
						variant="primary"
						size="sm"
						bind:element={offFirst}
						loading={busy}
						onkeydown={onOffKey}
						onclick={onOffRevert}>{m.cable_live_revert()}</Button
					>
					<Button size="sm" loading={busy} onkeydown={onOffKey} onclick={onOffKeep}
						>{m.cable_live_off_keep()}</Button
					>
					<Button variant="ghost" size="sm" onkeydown={onOffKey} onclick={cancelOff}
						>{m.cable_live_cancel()}</Button
					>
				</div>
			</div>
		{/if}

		{#if hold !== null}
			<div class="hold" data-hold={hold.reason} data-held={heldNow}>
				<p>{holdText}</p>
				{#if holdReason !== null}<p class="hold-why">{holdReason}</p>{/if}
				{#if holdAction === 'loudness'}
					<Button variant="primary" size="sm" loading={busy} onclick={onConfirm}
						>{m.cable_live_hold_loudness_confirm()}</Button
					>
				{:else if holdAction === 'reapply'}
					<Button variant="primary" size="sm" loading={busy} onclick={onConfirm}
						>{m.cable_live_reapply()}</Button
					>
				{:else if holdAction === 'experimental'}
					<Button variant="primary" size="sm" loading={busy} onclick={onConfirmExperimental}
						>{m.cable_live_hold_experimental_confirm()}</Button
					>
				{/if}
			</div>
		{/if}

		{#if unsaved}
			<div class="chip" data-live-chip>
				<span class="chip-text"
					><span class="dot" aria-hidden="true"></span>{m.cable_live_chip()}</span
				>
				<span class="actions">
					{#if savable}
						<Button size="sm" disabledReason={saveReason} onclick={onSave} data-live-save
							>{saveLabel}</Button
						>
					{/if}
					{#if active}
						<Button size="sm" loading={busy} onclick={onRevert}>{m.cable_live_revert()}</Button>
					{:else}
						<small>{m.cable_live_refused_no_saved_curve()}</small>
					{/if}
				</span>
			</div>
		{/if}

		{#if blind}
			<p class="notes" data-live-blind>{m.cable_blind_panel_reason()}</p>
		{:else if active}
			<ul class="notes">
				<li>{m.cable_live_ab_note()}</li>
				<li>{m.cable_live_browser_flat()}</li>
				<li>{m.cable_live_stuck_note()}</li>
				{#if followPaused}
					<li class="warn" data-live-paused>{m.cable_live_follow_paused()}</li>
				{/if}
				{#if live?.lastError !== null && live?.lastError !== undefined}
					<li class="warn">{m.cable_live_error()}</li>
				{/if}
			</ul>
		{/if}

		{#if endedText !== null}
			<div class="ended" data-live-ended={live?.endedReason}>
				<p>{endedText}</p>
				<Button variant="ghost" size="sm" onclick={() => (dismissed = true)}
					>{m.cable_live_dismiss()}</Button
				>
			</div>
		{/if}

		<p class="message" role="status" data-live-message>{message ?? ''}</p>
	</section>
{/if}

{#if app && checklistOpen}
	<LiveChecklist
		service={app.cable}
		open={true}
		bands={curve.bands}
		preampDb={curve.preampDb}
		{experimental}
		{profile}
		onbeforestart={() => onbeforestart?.(curve)}
		onclose={() => (checklistOpen = false)}
	/>
{/if}

<style>
	.live {
		display: grid;
		gap: var(--space-2, 8px);
		padding: var(--space-3, 12px) var(--space-4, 16px);
		border: 1px solid var(--rule, #333);
		border-radius: var(--rad-lg, 8px);
		background: var(--curva-satin, #222);
		color: var(--text);
		font-size: var(--fs-small, 13px);
	}
	.switch-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 8px) var(--space-3, 12px);
	}
	.hint,
	.notes {
		color: var(--text-2);
	}
	.track {
		position: relative;
		display: inline-block;
		width: 28px;
		height: 16px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--text) 25%, transparent);
	}
	.track[data-on='true'] {
		background: var(--accent, #1b7f76);
	}
	.knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--text, #eee);
		transition: transform var(--dur-fast, 0.15s);
	}
	.track[data-on='true'] .knob {
		transform: translateX(12px);
	}
	.status:empty,
	.message:empty {
		display: none;
	}
	.status,
	.off-ask p,
	.hold p,
	.ended p,
	.orphan p,
	.message {
		margin: 0;
	}
	.off-ask,
	.hold,
	.ended,
	.orphan {
		display: grid;
		gap: var(--space-2, 8px);
		padding: var(--space-2, 8px) var(--space-3, 12px);
		border-radius: var(--rad-sm, 4px);
		background: color-mix(in srgb, var(--text) 6%, transparent);
	}
	.hold,
	.orphan {
		border-left: 3px solid var(--warn, #e0a030);
	}
	.hold[data-hold='gate'] {
		border-left-color: var(--danger, #d04040);
	}
	.hold :global(.btn),
	.ended :global(.btn),
	.orphan :global(.btn) {
		justify-self: start;
	}
	.actions {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 8px);
	}
	.chip {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 8px) var(--space-3, 12px);
		padding: 6px 10px;
		border: 1px solid #e0a030;
		border-radius: var(--rad-pill, 999px);
		background: color-mix(in srgb, #e0a030 16%, transparent);
	}
	.chip-text {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: #f3c56a;
		font-weight: 600;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #e0a030;
	}
	.notes {
		margin: 0;
		padding-left: 1.2em;
	}
	.warn {
		color: var(--warn-text, #f3c56a);
	}
	@media (prefers-reduced-motion: reduce) {
		.knob {
			transition: none;
		}
	}
</style>
