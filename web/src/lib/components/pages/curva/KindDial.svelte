<!--
	Kind switch of a filter-bank module: a click-stepped rotary (PK, LS, OFF, HS, LP, HP; locked
	kinds are skipped) with a legend on hover or focus:
	- the current kind: its acronym, large, then its name and what it does, in one line;
	- the six kinds in two columns, each with a small drawing of its response (aria-hidden); locked
	  kinds are dimmed and marked "só em Engenharia", available experimental ones "EXPERIMENTAL";
	- one footer line: how to step and continue past a red, refused kind, or why the switch is locked.
	The legend behaves like the Tooltip primitive (400 ms hover, at once on keyboard focus, Escape,
	hoverable, top layer, above the switch) and is the switch's description: its text content is
	the accessible legend. It is drawn here because the primitive only carries plain text.
-->
<script module lang="ts">
	export interface KindCheck {
		ok: boolean;
		reason?: string;
	}
</script>

<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { isExperimentalKind } from 'open-auri/safety';
	import { m } from '#lib/paraglide/messages.js';
	import { isLockedKind, kindsForLayer, type Layer } from './layers.ts';
	import type { BandKind } from './model.ts';

	interface Props {
		kind: BandKind;
		layer: Layer;
		/** Unavailable controls stay focusable and explain why, as in Button. */
		disabledReason?: string | null;
		/** Real gate preflight, owned by the bank/page. Never changes the curve. */
		canApply: (kind: BandKind) => KindCheck | Promise<KindCheck>;
		/** Any external curve/profile change invalidates pending candidates and in-flight checks. */
		resetKey?: unknown;
		focusBoundary?: HTMLElement;
		onkind: (kind: BandKind) => void;
	}
	let {
		kind,
		layer,
		disabledReason = null,
		canApply,
		resetKey,
		focusBoundary,
		onkind
	}: Props = $props();

	// Keep the bank's engraved positions and their clockwise order, including the wrap at HP.
	const STOPS: readonly { kind: BandKind; angle: number }[] = [
		{ kind: 'PK', angle: -60 },
		{ kind: 'LS', angle: 0 },
		{ kind: 'OFF', angle: 60 },
		{ kind: 'HS', angle: 120 },
		{ kind: 'LP', angle: 180 },
		{ kind: 'HP', angle: -120 }
	];
	/** Legend order, two per row: bell and off, the two shelves, the two passes (low side first). */
	const LEGEND: readonly BandKind[] = ['PK', 'OFF', 'LS', 'HS', 'HP', 'LP'];
	/** Response drawings in a 24 × 12 box (illustrative shapes, not to scale). */
	const GLYPHS: Record<BandKind, string> = {
		PK: 'M1 9H7C9.5 9 10 2.5 12 2.5S14.5 9 17 9H23',
		LS: 'M1 3H7C10 3 11 9 14 9H23',
		HS: 'M1 9H10C13 9 14 3 17 3H23',
		LP: 'M1 4H11C15 4 17 6 20 11',
		HP: 'M4 11C7 6 9 4 13 4H23',
		OFF: 'M1 7H23'
	};
	const angleFor = (value: BandKind) => STOPS.find((stop) => stop.kind === value)?.angle ?? 60;
	const at = (angle: number) => {
		const radians = (angle * Math.PI) / 180;
		return { x: 25 * Math.sin(radians), y: -25 * Math.cos(radians) };
	};
	const enabled = $derived(
		STOPS.filter(
			(stop) =>
				(stop.kind === 'OFF' || kindsForLayer(layer).includes(stop.kind)) &&
				!isLockedKind(stop.kind, layer)
		)
	);
	const reason = $derived(
		disabledReason?.trim() || (layer === 'ouvir' ? m.curva_kinddial_readonly() : null)
	);
	// The language is fixed for the page's life (a switch reloads), so the copy is read once.
	const names: Record<BandKind, string> = {
		PK: m.curva_kinddial_pk_name(),
		LS: m.curva_kinddial_ls_name(),
		HS: m.curva_kinddial_hs_name(),
		LP: m.curva_kinddial_lp_name(),
		HP: m.curva_kinddial_hp_name(),
		OFF: m.curva_kinddial_off_name()
	};
	const plain: Record<BandKind, string> = {
		PK: m.curva_bn_kind_pk(),
		LS: m.curva_bn_kind_ls(),
		HS: m.curva_bn_kind_hs(),
		LP: m.curva_bn_kind_lp(),
		HP: m.curva_bn_kind_hp(),
		OFF: m.curva_bn_kind_off()
	};
	const short: Record<BandKind, string> = {
		PK: m.curva_bn_short_pk(),
		LS: m.curva_bn_short_ls(),
		HS: m.curva_bn_short_hs(),
		LP: m.curva_bn_short_lp(),
		HP: m.curva_bn_short_hp(),
		OFF: m.curva_bn_short_off()
	};
	const PENDING_MS = 5000;
	let pending = $state<{ kind: BandKind; reason: string } | null>(null);
	const shown = $derived(pending?.kind ?? kind);
	const pendingText = $derived(
		pending ? m.curva_kinddial_pending({ kind: pending.kind, reason: pending.reason }) : ''
	);
	const valueText = $derived(`${names[shown]} (${shown})`);
	let revertedText = $state('');
	let rotation = $state(untrack(() => angleFor(kind)));
	let previousKind = untrack(() => kind);
	let turnDirection: 1 | -1 | null = null;
	let requested: BandKind | null = null;
	let requestId = 0;
	let pendingTimer: ReturnType<typeof setTimeout> | undefined;
	let keyboardFocused = false;
	let hovered = false;
	let legendHovered = false;

	// Only the dial previews a refused kind. All other bank controls still use the applied prop.
	$effect(() => {
		const next = shown;
		untrack(() => {
			if (next === previousKind) return;
			const clockwise = (angleFor(next) - angleFor(previousKind) + 360) % 360;
			rotation +=
				turnDirection === -1
					? clockwise - 360
					: turnDirection === 1 || clockwise <= 180
						? clockwise
						: clockwise - 360;
			previousKind = next;
			turnDirection = null;
		});
	});

	function cancelPending(announce = false): void {
		const reverting = pending !== null;
		requestId++;
		clearTimeout(pendingTimer);
		pendingTimer = undefined;
		requested = null;
		pending = null;
		turnDirection = null;
		revertedText = announce && reverting ? m.curva_kinddial_reverted({ kind }) : '';
	}

	/** Five seconds after the last interaction, never while the operator is reading the dial. */
	function resumePendingTimer(): void {
		cancelPendingTimer();
		if (pending && !keyboardFocused && !hovered && !legendHovered) {
			pendingTimer = setTimeout(() => cancelPending(true), PENDING_MS);
		}
	}

	$effect(() => {
		// Also cancel if another band, undo, a preset, or the gate profile changed.
		void kind;
		void layer;
		void reason;
		void resetKey;
		untrack(() => {
			// A bank focus-exit reset must not erase the dial's just-announced revert.
			if (pending || requested !== null) {
				cancelPending(!!focusBoundary && !focusBoundary.contains(document.activeElement));
			}
		});
	});

	async function propose(next: BandKind, direction: 1 | -1 | null = null): Promise<void> {
		if (reason) {
			showTip();
			return;
		}
		if (!enabled.some((stop) => stop.kind === next)) return;
		cancelPendingTimer();
		revertedText = '';
		const id = ++requestId;
		const applied = kind;
		const context = resetKey;
		const currentLayer = layer;
		requested = next;
		if (next === applied) {
			cancelPending(true);
			return;
		}
		let check: KindCheck;
		try {
			check = await canApply(next);
		} catch {
			check = { ok: false, reason: m.curva_gate_error() };
		}
		// A newer click or external change wins, even if the old gate answers later.
		if (
			id !== requestId ||
			kind !== applied ||
			resetKey !== context ||
			layer !== currentLayer ||
			reason
		) {
			return;
		}
		requested = null;
		turnDirection = direction;
		if (check.ok) {
			pending = null;
			onkind(next);
		} else {
			pending = { kind: next, reason: check.reason || m.curva_reason_unknown() };
			resumePendingTimer();
		}
	}

	function cancelPendingTimer(): void {
		clearTimeout(pendingTimer);
		pendingTimer = undefined;
	}

	function step(direction: 1 | -1): void {
		const cursor = requested ?? shown;
		const index = STOPS.findIndex((stop) => stop.kind === cursor);
		for (let offset = 1; offset <= STOPS.length; offset++) {
			const next = STOPS[(index + direction * offset + STOPS.length) % STOPS.length];
			if (next && enabled.some((stop) => stop.kind === next.kind)) {
				void propose(next.kind, direction);
				return;
			}
		}
	}

	/** The keys the switch answers; a modifier alone (Shift before a Shift+click) is not one. */
	const STEP_KEYS: ReadonlySet<string> = new Set([
		'Enter',
		' ',
		'ArrowRight',
		'ArrowUp',
		'ArrowLeft',
		'ArrowDown',
		'Home'
	]);

	function handleKey(event: KeyboardEvent): void {
		if (event.altKey || event.ctrlKey || event.metaKey || !STEP_KEYS.has(event.key)) return;
		// Keyboard use can follow a pointer focus without another focusin.
		if (document.activeElement === trigger && !keyboardFocused) {
			keyboardFocused = true;
			cancelPendingTimer();
			showTip();
		}
		switch (event.key) {
			case 'Enter':
			case ' ':
				// Same as a click: Shift reverses the direction.
				event.preventDefault();
				event.stopPropagation();
				step(event.shiftKey ? -1 : 1);
				break;
			case 'ArrowRight':
			case 'ArrowUp':
				event.preventDefault();
				event.stopPropagation();
				step(1);
				break;
			case 'ArrowLeft':
			case 'ArrowDown':
				event.preventDefault();
				event.stopPropagation();
				step(-1);
				break;
			case 'Home':
				event.preventDefault();
				event.stopPropagation();
				void propose('OFF');
				break;
		}
	}

	// --- legend popover (same timing and placement as the Tooltip primitive, "top") -------------

	const HOVER_DELAY = 400;
	const CLOSE_GRACE = 120;
	const GAP = 8;
	const MARGIN = 8;
	const uid = $props.id();
	const tipId = `${uid}-legend`;
	let trigger: HTMLElement | undefined = $state();
	let tip: HTMLElement | undefined = $state();
	let tipOpen = $state(false);
	let tipPos = $state<{ top: number; left: number } | null>(null);
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	/** A press can focus after pointerup on touch: keep this flag until click or cancellation. */
	let pressed = false;

	function clearTimers(): void {
		clearTimeout(openTimer);
		clearTimeout(closeTimer);
		openTimer = undefined;
		closeTimer = undefined;
	}
	function showTip(): void {
		clearTimers();
		tipOpen = true;
	}
	function hideTip(): void {
		clearTimers();
		tipOpen = false;
	}
	function scheduleOpen(): void {
		clearTimeout(closeTimer);
		closeTimer = undefined;
		if (tipOpen || openTimer !== undefined) return;
		openTimer = setTimeout(() => {
			openTimer = undefined;
			// A dial that left the document meanwhile has nothing left to open.
			if (trigger?.isConnected) tipOpen = true;
		}, HOVER_DELAY);
	}
	function scheduleClose(): void {
		clearTimeout(openTimer);
		openTimer = undefined;
		clearTimeout(closeTimer);
		closeTimer = setTimeout(() => {
			closeTimer = undefined;
			tipOpen = false;
		}, CLOSE_GRACE);
	}
	/** Above the switch (below without room), so the legend never covers the dial's clicks. */
	function place(): void {
		if (!trigger?.isConnected || !tip?.isConnected) return;
		const rect = trigger.getBoundingClientRect();
		const box = tip.getBoundingClientRect();
		const above = rect.top - GAP - box.height;
		const top = above >= MARGIN ? above : rect.bottom + GAP;
		const centred = rect.left + rect.width / 2 - box.width / 2;
		const left = Math.max(MARGIN, Math.min(centred, window.innerWidth - box.width - MARGIN));
		tipPos = { top, left };
	}

	$effect(() => {
		// A legend element that changes or goes away takes its pending open and close with it.
		void tip;
		return clearTimers;
	});

	$effect(() => {
		const element = tip;
		// Refusals can make an already-open legend taller; keep it clear of the next click.
		void shown;
		void pendingText;
		if (!element) return;
		// Its subtree can leave the document before the dial is destroyed (a parent removed first,
		// as a test cleanup does), and a focus-exit reset still re-runs this effect then: a
		// detached popover can be neither shown nor hidden (InvalidStateError).
		if (!element.isConnected) {
			tipPos = null;
			return;
		}
		if (!tipOpen) {
			if (element.matches(':popover-open')) element.hidePopover();
			tipPos = null;
			return;
		}
		if (!element.matches(':popover-open')) element.showPopover();
		place();
		const reposition = () => {
			if (element.isConnected) place();
		};
		window.addEventListener('scroll', reposition, true);
		window.addEventListener('resize', reposition);
		return () => {
			window.removeEventListener('scroll', reposition, true);
			window.removeEventListener('resize', reposition);
		};
	});

	/** While a native modal is open, Escape is its close request (the page behind it is inert). */
	const MODAL = 'dialog:modal';
	/** Targets that answer Escape themselves: dialogs, menus, other popovers, text entry. */
	const ESCAPE_OWNERS = [
		'dialog[open]',
		'[aria-modal="true"]',
		'[role="dialog"]',
		'[role="alertdialog"]',
		'[role="menu"]',
		'[role="menubar"]',
		'[role="listbox"]',
		'[role="combobox"]',
		':popover-open',
		'textarea',
		'select',
		'[contenteditable]:not([contenteditable="false"])',
		'input:not([type="button"], [type="checkbox"], [type="color"], [type="file"], [type="image"], [type="radio"], [type="range"], [type="reset"], [type="submit"])'
	].join(', ');

	/**
	 * Escape closes this dial's legend and cancels its pending kind, in two places:
	 * - on the dial and its legend themselves (local, so the dial a key comes from answers it
	 *   before any other dial's document listener);
	 * - elsewhere in the document, bubble phase, only while this legend is open (hover or focus)
	 *   and only for an Escape no other component owns: not one already handled (prevented, or
	 *   stopped as the rename field does), not one from inside a dialog, menu, popover or text
	 *   field, and none while a modal dialog that does not hold this dial is open.
	 */
	function escapeKey(element: HTMLElement) {
		const dismiss = (event: KeyboardEvent): void => {
			if (!pending && requested === null && !tipOpen) return;
			event.preventDefault();
			event.stopPropagation();
			cancelPending(true);
			hideTip();
		};
		const isEscape = (event: KeyboardEvent) =>
			event.key === 'Escape' && !event.defaultPrevented && !event.isComposing;
		const onLocal = (event: KeyboardEvent) => {
			if (isEscape(event)) dismiss(event);
		};
		const onDocument = (event: KeyboardEvent) => {
			if (!isEscape(event) || !tipOpen) return;
			const target = event.target instanceof Node ? event.target : null;
			// Answered, or declined with nothing to close, by the local listener.
			if (target && element.contains(target)) return;
			const from = target instanceof Element ? target : (target?.parentElement ?? null);
			if (from?.closest(ESCAPE_OWNERS)) return;
			const modal = document.querySelector(MODAL);
			if (modal && !modal.contains(element)) return;
			dismiss(event);
		};
		element.addEventListener('keydown', onLocal);
		document.addEventListener('keydown', onDocument);
		return () => {
			element.removeEventListener('keydown', onLocal);
			document.removeEventListener('keydown', onDocument);
		};
	}

	onDestroy(() => {
		clearTimers();
		cancelPending();
	});
</script>

<div class="kind-dial" {@attach escapeKey}>
	<div
		bind:this={trigger}
		class="switch"
		role="spinbutton"
		tabindex="0"
		aria-label={m.curva_kind()}
		aria-valuemin={0}
		aria-valuemax={STOPS.length - 1}
		aria-valuenow={STOPS.findIndex((stop) => stop.kind === shown)}
		aria-valuetext={valueText}
		aria-invalid={pending ? 'true' : undefined}
		aria-disabled={reason ? 'true' : undefined}
		aria-describedby={tipId}
		onclick={(event) => {
			pressed = false;
			step(event.shiftKey ? -1 : 1);
		}}
		onkeydown={handleKey}
		onpointerenter={(event) => {
			if (event.pointerType === 'mouse') {
				hovered = true;
				cancelPendingTimer();
				scheduleOpen();
			}
		}}
		onpointerleave={(event) => {
			if (event.pointerType === 'mouse') {
				hovered = false;
				resumePendingTimer();
				scheduleClose();
			}
		}}
		onpointerdown={() => {
			pressed = true;
			keyboardFocused = false;
			resumePendingTimer();
		}}
		onpointercancel={() => (pressed = false)}
		onfocusin={() => {
			keyboardFocused = !pressed;
			if (keyboardFocused) {
				cancelPendingTimer();
				showTip();
			} else {
				resumePendingTimer();
			}
		}}
		onfocusout={(event) => {
			keyboardFocused = false;
			pressed = false;
			if (
				focusBoundary &&
				(!(event.relatedTarget instanceof Node) || !focusBoundary.contains(event.relatedTarget))
			) {
				cancelPending(true);
			} else {
				resumePendingTimer();
			}
			// Deferred: a focused switch removed during an update fires focusout mid-flush.
			queueMicrotask(() => {
				if (!legendHovered) hideTip();
			});
		}}
	>
		<svg viewBox="-46 -34 92 68" aria-hidden="true">
			{#each STOPS as stop (stop.kind)}
				{@const point = at(stop.angle)}
				<text
					class="mark"
					class:on={shown === stop.kind}
					class:invalid={pending?.kind === stop.kind}
					class:dim={isLockedKind(stop.kind, layer)}
					x={point.x}
					y={point.y + 3}>{stop.kind}</text
				>
			{/each}
			<circle r="12" class="skirt" />
			<g class="cap" style:--turn={`${rotation}deg`}>
				<line x1="0" y1="-11" x2="0" y2="-3" class="index" />
			</g>
			<text class="value" class:invalid={pending !== null} x="0" y="19"
				>{shown}{pending ? ' ✕' : ''}</text
			>
		</svg>
	</div>
	<p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
		{pendingText || revertedText}
	</p>
	<div
		id={tipId}
		bind:this={tip}
		class="tooltip kd-tip"
		role="tooltip"
		popover="manual"
		style:top={tipPos ? `${tipPos.top}px` : null}
		style:left={tipPos ? `${tipPos.left}px` : null}
		style:visibility={tipPos ? null : 'hidden'}
		onpointerenter={(event) => {
			if (event.pointerType !== 'mouse') return;
			legendHovered = true;
			cancelPendingTimer();
			clearTimeout(closeTimer);
			closeTimer = undefined;
		}}
		onpointerleave={(event) => {
			if (event.pointerType !== 'mouse') return;
			legendHovered = false;
			resumePendingTimer();
			scheduleClose();
		}}
	>
		<p class="kd-now">
			<b class="kd-acr" class:invalid={pending !== null}>{shown}{pending ? ' ✕' : ''}</b>
			<span class="kd-text"><b>{names[shown]}</b>: {plain[shown]}</span>
		</p>
		{#if pending}<p class="kd-refusal">{pendingText}</p>{/if}
		<ul class="kd-legend">
			{#each LEGEND as entry (entry)}
				{@const locked = isLockedKind(entry, layer)}
				<li class:on={entry === shown} class:dim={locked}>
					<svg class="kd-glyph" viewBox="0 0 24 12" aria-hidden="true"
						><path class:flat={entry === 'OFF'} d={GLYPHS[entry]} /></svg
					>
					<b class="kd-k">{entry}</b>
					<span class="kd-short">{short[entry]}</span>
					{#if locked}
						<small class="kd-mark">{m.curva_bn_locked()}</small>
					{:else if isExperimentalKind(entry)}
						<small class="kd-mark">{m.curva_exp_badge()}</small>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="kd-foot">{reason ?? m.curva_bn_kind_foot()}</p>
	</div>
</div>

<style>
	.kind-dial,
	.switch,
	.switch svg {
		display: block;
		width: 92px;
		height: 68px;
	}
	.switch {
		border-radius: var(--rad-md);
		cursor: pointer;
		user-select: none;
	}
	.switch[aria-disabled='true'] {
		cursor: not-allowed;
	}
	.switch:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: 1px;
	}
	.mark {
		fill: var(--text-2);
		font: 600 10px var(--face-engrave);
		letter-spacing: 0.06em;
		text-anchor: middle;
	}
	.mark.dim {
		fill-opacity: 0.45;
	}
	.mark.on {
		fill: var(--accent);
		fill-opacity: 1;
	}
	.skirt {
		fill: #0d0d0d;
		stroke: #000;
	}
	.cap {
		transform: rotate(var(--turn));
		transition: transform var(--dur-base) var(--ease-mech);
	}
	.index {
		stroke: var(--text);
		stroke-width: 2.6;
		stroke-linecap: round;
	}
	.value {
		fill: var(--accent);
		font: 600 9px var(--face-data);
		text-anchor: middle;
	}
	.mark.invalid,
	.value.invalid {
		fill: var(--danger);
	}
	.kd-acr.invalid,
	.kd-refusal {
		color: var(--danger);
	}
	.kd-refusal {
		margin: 0 0 8px;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	/* The legend: the global .tooltip look, a little wider for its two columns. */
	.kd-tip {
		width: min(340px, calc(100vw - 16px));
		max-width: none;
		padding: 10px 12px;
	}
	.kd-now {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0 10px;
		align-items: center;
		margin: 0 0 8px;
	}
	.kd-acr {
		color: var(--accent-text);
		font: 600 22px / 1 var(--face-data);
		letter-spacing: 0.04em;
	}
	.kd-text b {
		font-weight: 600;
	}
	.kd-legend {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 5px 14px;
		margin: 0;
		padding: 8px 0;
		border-block: 1px solid var(--pop-rule);
		list-style: none;
	}
	.kd-legend li {
		display: grid;
		grid-template-columns: 24px auto minmax(0, 1fr);
		column-gap: 6px;
		align-items: center;
	}
	.kd-glyph {
		display: block;
		width: 24px;
		height: 12px;
		overflow: visible;
		color: var(--text-2);
	}
	.kd-glyph path {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.kd-glyph path.flat {
		stroke-dasharray: 2 2.5;
	}
	.kd-k {
		font: 600 var(--fs-caption) / 1.2 var(--face-data);
		letter-spacing: 0.04em;
	}
	.kd-short {
		min-width: 0;
	}
	.kd-mark {
		grid-column: 2 / -1;
		color: var(--text-2);
		font: 500 var(--label-min) / 1.2 var(--face-body);
	}
	.kd-legend li.on .kd-k,
	.kd-legend li.on .kd-glyph {
		color: var(--accent-text);
	}
	/* Locked kinds: dimmed drawing and text, the mark itself stays readable. */
	.kd-legend li.dim .kd-glyph {
		opacity: 0.45;
	}
	.kd-legend li.dim .kd-k,
	.kd-legend li.dim .kd-short {
		color: var(--text-2);
	}
	.kd-foot {
		margin: 8px 0 0;
		color: var(--text-2);
	}
	@media (prefers-reduced-motion: reduce) {
		.cap {
			transition: none;
		}
	}
</style>
