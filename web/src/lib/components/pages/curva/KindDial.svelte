<script lang="ts">
	import { untrack } from 'svelte';
	import { isExperimentalKind } from 'open-auri/safety';
	import Tooltip from '#lib/components/primitives/Tooltip.svelte';
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
	const names: Record<BandKind, string> = $derived({
		PK: m.curva_kinddial_pk_name(),
		LS: m.curva_kinddial_ls_name(),
		HS: m.curva_kinddial_hs_name(),
		LP: m.curva_kinddial_lp_name(),
		HP: m.curva_kinddial_hp_name(),
		OFF: m.curva_kinddial_off_name()
	});
	const meanings: Record<BandKind, string> = $derived({
		PK: m.curva_kinddial_pk_meaning(),
		LS: m.curva_kinddial_ls_meaning(),
		HS: m.curva_kinddial_hs_meaning(),
		LP: m.curva_kinddial_lp_meaning(),
		HP: m.curva_kinddial_hp_meaning(),
		OFF: m.curva_kinddial_off_meaning()
	});
	const valueText = $derived(
		`${names[kind]} (${kind})${isExperimentalKind(kind) ? ` · ${m.curva_exp_badge()}` : ''}`
	);
	const legend = $derived(
		[
			meanings[kind],
			reason,
			m.curva_kinddial_help(),
			m.curva_kinddial_legend(),
			...STOPS.map((stop) => meanings[stop.kind]),
			layer === 'engenharia' ? `HS, LP, HP: ${m.curva_exp_badge()}.` : m.curva_exp_hint()
		]
			.filter(Boolean)
			.join('\n')
	);
	let tipOpen = $state(false);
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
			tipOpen = true;
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
</script>

<div class="kind-dial">
	<!-- Placed above (or, without room, below): the Tooltip never overlaps its trigger in "top"
	     placement, so the legend stays hoverable without covering the dial's clicks. -->
	<Tooltip text={legend} placement="top" bind:open={tipOpen}>
		{#snippet children(tip)}
			<div
				class="switch"
				role="spinbutton"
				tabindex="0"
				aria-label={m.curva_kind()}
				aria-valuemin={0}
				aria-valuemax={STOPS.length - 1}
				aria-valuenow={STOPS.findIndex((stop) => stop.kind === kind)}
				aria-valuetext={valueText}
				aria-disabled={reason ? 'true' : undefined}
				aria-describedby={tip.id}
				onclick={(event) => step(event.shiftKey ? -1 : 1)}
				onkeydown={handleKey}
				{@attach tip.attach}
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
		{/snippet}
	</Tooltip>
</div>

<style>
	.kind-dial,
	.switch,
	svg {
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
	/* One legend entry per line. The tooltip stays hoverable (WCAG 1.4.13). */
	.kind-dial :global(.tooltip) {
		white-space: pre-line;
	}
	@media (prefers-reduced-motion: reduce) {
		.cap {
			transition: none;
		}
	}
</style>
