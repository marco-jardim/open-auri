<!--
	Kind switch of a filter-bank module: a click-stepped rotary (PK, LS, OFF, HS, LP, HP; locked
	kinds are skipped) with a legend on hover or focus:
	- the current kind: its acronym, large, then its name and what it does, in one line;
	- the six kinds in two columns, each with a small drawing of its response (aria-hidden); locked
	  kinds are dimmed and marked "só em Engenharia", available experimental ones "EXPERIMENTAL";
	- one footer line: how to step, or why the switch is locked.
	The legend behaves like the Tooltip primitive (400 ms hover, at once on keyboard focus, Escape,
	hoverable, top layer, above the switch) and is the switch's description: its text content is
	the accessible legend. It is drawn here because the primitive only carries plain text.
-->
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
		onkind: (kind: BandKind) => void;
	}
	let { kind, layer, disabledReason = null, onkind }: Props = $props();

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
	const reason = $derived(disabledReason?.trim() || null);
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
	const valueText = $derived(
		`${names[kind]} (${kind})${isExperimentalKind(kind) ? ` · ${m.curva_exp_badge()}` : ''}`
	);
	let rotation = $state(untrack(() => angleFor(kind)));
	let previousKind = untrack(() => kind);
	let pending: { from: BandKind; to: BandKind; direction: 1 | -1 | null } | null = null;

	// Only a committed prop moves the pointer. Preserve the requested direction across wraps
	// and skipped stops, without displaying a kind that the existing gate refused.
	$effect(() => {
		const accepted = kind;
		untrack(() => {
			if (accepted === previousKind) return;
			const clockwise = (angleFor(accepted) - angleFor(previousKind) + 360) % 360;
			const direction =
				pending?.from === previousKind && pending.to === accepted ? pending.direction : null;
			rotation +=
				direction === -1
					? clockwise - 360
					: direction === 1 || clockwise <= 180
						? clockwise
						: clockwise - 360;
			previousKind = accepted;
			pending = null;
		});
	});

	function propose(next: BandKind, direction: 1 | -1 | null = null): void {
		if (reason) {
			showTip();
			return;
		}
		if (next === kind || !enabled.some((stop) => stop.kind === next)) return;
		pending = { from: kind, to: next, direction };
		onkind(next);
	}

	function step(direction: 1 | -1): void {
		const index = enabled.findIndex((stop) => stop.kind === kind);
		const next = enabled[(index + direction + enabled.length) % enabled.length];
		if (next) propose(next.kind, direction);
	}

	function handleKey(event: KeyboardEvent): void {
		if (event.altKey || event.ctrlKey || event.metaKey) return;
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
				propose('OFF');
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
	/** A focus that follows a press is a pointer focus: hover already handles it. */
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
			tipOpen = true;
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
		if (!trigger || !tip) return;
		const rect = trigger.getBoundingClientRect();
		const box = tip.getBoundingClientRect();
		const above = rect.top - GAP - box.height;
		const top = above >= MARGIN ? above : rect.bottom + GAP;
		const centred = rect.left + rect.width / 2 - box.width / 2;
		const left = Math.max(MARGIN, Math.min(centred, window.innerWidth - box.width - MARGIN));
		tipPos = { top, left };
	}

	$effect(() => {
		const element = tip;
		if (!element) return;
		if (!tipOpen) {
			if (element.matches(':popover-open')) element.hidePopover();
			tipPos = null;
			return;
		}
		if (!element.matches(':popover-open')) element.showPopover();
		place();
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			// Escape dismisses the legend first, without closing a surrounding dialog or menu.
			event.preventDefault();
			event.stopPropagation();
			hideTip();
		};
		const reposition = () => place();
		document.addEventListener('keydown', onKeydown, true);
		window.addEventListener('scroll', reposition, true);
		window.addEventListener('resize', reposition);
		return () => {
			document.removeEventListener('keydown', onKeydown, true);
			window.removeEventListener('scroll', reposition, true);
			window.removeEventListener('resize', reposition);
		};
	});

	onDestroy(clearTimers);
</script>

<div class="kind-dial">
	<div
		bind:this={trigger}
		class="switch"
		role="spinbutton"
		tabindex="0"
		aria-label={m.curva_kind()}
		aria-valuemin={0}
		aria-valuemax={STOPS.length - 1}
		aria-valuenow={STOPS.findIndex((stop) => stop.kind === kind)}
		aria-valuetext={valueText}
		aria-disabled={reason ? 'true' : undefined}
		aria-describedby={tipId}
		onclick={(event) => step(event.shiftKey ? -1 : 1)}
		onkeydown={handleKey}
		onpointerenter={(event) => {
			if (event.pointerType !== 'touch') scheduleOpen();
		}}
		onpointerleave={(event) => {
			if (event.pointerType !== 'touch') scheduleClose();
		}}
		onpointerdown={() => (pressed = true)}
		onpointerup={() => (pressed = false)}
		onpointercancel={() => (pressed = false)}
		onfocusin={() => {
			if (!pressed) showTip();
		}}
		onfocusout={() => {
			pressed = false;
			// Deferred: a focused switch removed during an update fires focusout mid-flush.
			queueMicrotask(hideTip);
		}}
	>
		<svg viewBox="-46 -34 92 68" aria-hidden="true">
			{#each STOPS as stop (stop.kind)}
				{@const point = at(stop.angle)}
				<text
					class="mark"
					class:on={kind === stop.kind}
					class:dim={isLockedKind(stop.kind, layer)}
					x={point.x}
					y={point.y + 3}>{stop.kind}</text
				>
			{/each}
			<circle r="12" class="skirt" />
			<g class="cap" style:--turn={`${rotation}deg`}>
				<line x1="0" y1="-11" x2="0" y2="-3" class="index" />
			</g>
			<text class="value" x="0" y="19">{kind}</text>
		</svg>
	</div>
	<div
		id={tipId}
		bind:this={tip}
		class="tooltip kd-tip"
		role="tooltip"
		popover="manual"
		style:top={tipPos ? `${tipPos.top}px` : null}
		style:left={tipPos ? `${tipPos.left}px` : null}
		style:visibility={tipPos ? null : 'hidden'}
		onpointerenter={() => {
			clearTimeout(closeTimer);
			closeTimer = undefined;
		}}
		onpointerleave={scheduleClose}
	>
		<p class="kd-now">
			<b class="kd-acr">{kind}</b>
			<span class="kd-text"><b>{names[kind]}</b>: {plain[kind]}</span>
		</p>
		<ul class="kd-legend">
			{#each LEGEND as entry (entry)}
				{@const locked = isLockedKind(entry, layer)}
				<li class:on={entry === kind} class:dim={locked}>
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
