<!--
	"Ouvir no cabo" (issue #69): the live (no-flash) preview of the editor curve on the cable.
	- The switch shows only when the transport is live-capable and a cable is connected (or a
	  session still runs); other blocks (loading, a write, no target, the free preview) say why.
	  On: the live checklist (LiveChecklist; its "Começar" mints the gesture and calls
	  `startLive`). Off: "Voltar à curva salva" (default; gesture, `stopLive({ revert: true })`)
	  or "Manter até desconectar" (`stopLive({ revert: false })`).
	- Edits and the A/B lever reach the cable through the page (`queueLive`), not here.
	- The amber chip "No cabo: prévia não salva" shows while the cable plays something other than
	  the saved curve: "Salvar no cabo" opens the normal write checklist on the applied curve,
	  "Voltar à curva salva" calls `revertLive` (gesture).
	- Holds (loudness, gate, unknown state) are announced as alerts; confirmable ones confirm with
	  a gesture (`confirmLive`). Status changes and the end of a session are announced politely.
	Every service call that needs a gesture mints it synchronously in its click handler.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { ClientApp } from '#lib/app/index.ts';
	import type { CableState, LiveOutcome } from '#lib/cable/types.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import LiveChecklist from '#lib/components/cable/LiveChecklist.svelte';
	import { formatNumber } from '#lib/components/cable/i18n.ts';
	import { liveActive, liveRefusalText, liveUnsaved } from '#lib/components/cable/live.ts';
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
		/** Why the page itself blocks starting (loading, the free preview), or null. */
		blockedReason: string | null;
		locale: string;
		/** Called in the "Começar" click, right before `startLive`, with the curve it sends. */
		onbeforestart?: (curve: Curve) => void;
	}

	let {
		app,
		curve,
		experimental,
		profile,
		saved,
		blockedReason,
		locale,
		onbeforestart
	}: Props = $props();

	const id = $props.id();
	const cable = $derived<CableState | null>(app?.cableState ?? null);
	const live = $derived(cable?.live ?? null);
	const active = $derived(liveActive(live));
	const connected = $derived(cable?.connection === 'connected');
	const unsaved = $derived(liveUnsaved(live, saved));
	const hold = $derived(active ? (live?.hold ?? null) : null);
	const shown = $derived(cable !== null && cable.liveCapable && (connected || live !== null));

	let checklistOpen = $state(false);
	let offAsk = $state(false);
	let busy = $state(false);
	let message = $state<string | null>(null);
	let dismissed = $state(false);
	let offFirst = $state<HTMLButtonElement | undefined>();

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
		if (active) return null;
		if (blockedReason !== null) return blockedReason;
		if (cable === null) return m.curva_v2_loading_reason();
		if (cable.writing) return m.cable_live_reason_writing();
		if (cable.device === null) return m.cable_live_reason_target();
		return null;
	});

	const statusText = $derived.by(() => {
		if (!active || live === null) return '';
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
				return m.cable_live_status_live({ device: live.deviceLabel });
		}
	});

	const endedText = $derived.by(() => {
		if (live === null || live.status !== 'ended' || dismissed) return null;
		switch (live.endedReason) {
			case 'disconnected':
				return m.cable_live_ended_disconnected();
			case 'reverted':
				return m.cable_live_ended_reverted();
			case 'stopped':
				return m.cable_live_ended_stopped();
			default:
				return null;
		}
	});

	const holdText = $derived.by(() => {
		if (hold === null) return '';
		if (hold.reason === 'loudness') {
			return m.cable_live_hold_loudness({ delta: formatNumber(hold.deltaDb ?? 0, 1) });
		}
		if (hold.reason === 'unknown-state') return m.cable_live_hold_unknown();
		return m.cable_live_hold_gate();
	});
	const holdReason = $derived(
		hold?.reason === 'gate' && hold.gateReasons !== undefined && hold.gateReasons.length > 0
			? m.cable_live_hold_gate_reason({
					reason: firstReasonText(hold.gateReasons, { bands: curve.bands, locale })
				})
			: null
	);

	function report(outcome: LiveOutcome): boolean {
		if (outcome.status === 'refused') {
			message = liveRefusalText[outcome.reason]();
			return false;
		}
		message = null;
		return true;
	}

	/** The saved curve the revert applies (else the service's own: this page's last save, the journal). */
	function savedCurve() {
		return saved === null ? {} : { saved: { bands: saved.bands, preampDb: saved.preampDb } };
	}

	async function onSwitch() {
		if (!app) return;
		if (active) {
			offAsk = true;
			await tick();
			offFirst?.focus();
			return;
		}
		if (switchReason !== null) return;
		message = null;
		checklistOpen = true;
	}

	async function onOffRevert(event: MouseEvent) {
		if (!app || busy) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		try {
			if (report(await app.cable.stopLive({ revert: true, gesture, ...savedCurve() }))) {
				offAsk = false;
			}
		} finally {
			busy = false;
		}
	}

	async function onOffKeep() {
		if (!app || busy) return;
		busy = true;
		try {
			if (report(await app.cable.stopLive({ revert: false }))) offAsk = false;
		} finally {
			busy = false;
		}
	}

	async function onRevert(event: MouseEvent) {
		if (!app || busy) return;
		const gesture = app.cable.createGesture(event);
		busy = true;
		try {
			report(await app.cable.revertLive({ gesture, ...savedCurve() }));
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

	/** "Salvar no cabo": the normal write checklist, on the curve the cable plays now. */
	function onSave() {
		const applied = live?.applied;
		if (!app || !applied) return;
		app.requestWrite(
			{ ...app.state.curve.current, bands: applied.bands, preampDb: applied.preampDb },
			applied.profile === 'yolo' ? { profile: 'yolo' } : {}
		);
	}
</script>

{#if shown}
	<section class="live" aria-label={m.cable_live_switch()} data-live-panel>
		{#if connected || active}
			<div class="switch-row">
				<Button
					variant="plate"
					size="sm"
					role="switch"
					aria-checked={active}
					aria-describedby={`${id}-hint`}
					class="live-switch"
					disabledReason={switchReason}
					onclick={onSwitch}
				>
					<span class="track" data-on={active} aria-hidden="true"><span class="knob"></span></span>
					<span>{m.cable_live_switch()}</span>
				</Button>
				<small id={`${id}-hint`} class="hint">{m.cable_live_switch_hint()}</small>
			</div>
		{/if}

		<p class="status" role="status">{statusText}</p>

		{#if offAsk && active}
			<div class="off-ask" role="group" aria-labelledby={`${id}-off`}>
				<p id={`${id}-off`}>{m.cable_live_off_question()}</p>
				<div class="actions">
					<Button
						variant="primary"
						size="sm"
						bind:element={offFirst}
						loading={busy}
						onclick={onOffRevert}>{m.cable_live_revert()}</Button
					>
					<Button size="sm" loading={busy} onclick={onOffKeep}>{m.cable_live_off_keep()}</Button>
					<Button variant="ghost" size="sm" onclick={() => (offAsk = false)}
						>{m.cable_live_cancel()}</Button
					>
				</div>
			</div>
		{/if}

		{#if hold !== null}
			<div class="hold" role="alert" data-hold={hold.reason}>
				<p>{holdText}</p>
				{#if holdReason !== null}<p class="hold-why">{holdReason}</p>{/if}
				{#if hold.reason === 'loudness'}
					<Button variant="primary" size="sm" loading={busy} onclick={onConfirm}
						>{m.cable_live_hold_loudness_confirm()}</Button
					>
				{:else if hold.reason === 'unknown-state'}
					<Button variant="primary" size="sm" loading={busy} onclick={onConfirm}
						>{m.cable_live_reapply()}</Button
					>
				{/if}
			</div>
		{/if}

		{#if unsaved}
			<div class="chip" data-live-chip>
				<span class="chip-text"><span class="dot" aria-hidden="true"></span>{m.cable_live_chip()}</span>
				<span class="actions">
					<Button
						size="sm"
						disabledReason={cable?.writing ? m.cable_live_reason_writing() : null}
						onclick={onSave}>{m.cable_live_save()}</Button
					>
					{#if active}
						<Button size="sm" loading={busy} onclick={onRevert}>{m.cable_live_revert()}</Button>
					{:else}
						<small>{m.cable_live_refused_no_saved_curve()}</small>
					{/if}
				</span>
			</div>
		{/if}

		{#if active}
			<ul class="notes">
				<li>{m.cable_live_ab_note()}</li>
				<li>{m.cable_live_browser_flat()}</li>
				<li>{m.cable_live_stuck_note()}</li>
				{#if live?.lastError !== null && live?.lastError !== undefined}
					<li class="warn">{m.cable_live_error()}</li>
				{/if}
			</ul>
		{/if}

		{#if endedText !== null}
			<div class="ended" role="status" data-live-ended={live?.endedReason}>
				<p>{endedText}</p>
				<Button variant="ghost" size="sm" onclick={() => (dismissed = true)}
					>{m.cable_live_dismiss()}</Button
				>
			</div>
		{/if}

		{#if message !== null}
			<p class="message" role="status">{message}</p>
		{/if}
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
	.status:empty {
		display: none;
	}
	.status,
	.off-ask p,
	.hold p,
	.ended p,
	.message {
		margin: 0;
	}
	.off-ask,
	.hold,
	.ended {
		display: grid;
		gap: var(--space-2, 8px);
		padding: var(--space-2, 8px) var(--space-3, 12px);
		border-radius: var(--rad-sm, 4px);
		background: color-mix(in srgb, var(--text) 6%, transparent);
	}
	.hold {
		border-left: 3px solid var(--warn, #e0a030);
	}
	.hold[data-hold='gate'] {
		border-left-color: var(--danger, #d04040);
	}
	.hold :global(.btn),
	.ended :global(.btn) {
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
