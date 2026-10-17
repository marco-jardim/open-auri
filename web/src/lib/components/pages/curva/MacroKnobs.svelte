<!--
	Fine adjust (N1 macros, mock v2 .kunit): Grave, Corpo, Presença, Brilho as graduated knobs from
	−6 to +6 dB with an LCD readout and how many sections each one moves.
	- The control is a native range input (keyboard and screen readers); it sits under the knob,
	  visually hidden, and the knob shows its focus ring.
	- Pointer: drag the knob up or down (10 px per dB, 0,1 dB steps). The value is proposed on release
	  and the page runs it through the gate (see macros.ts for the mapping). A refusal shows where it
	  stopped and why, and the knob's skirt flashes the danger colour.
	- Motion: the cap settles with the mechanical detent easing; none while dragging or under
	  prefers-reduced-motion.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { formatSignedDb } from './format.ts';
	import {
		MACRO_MAX_DB,
		MACRO_MIN_DB,
		MACRO_STEP_DB,
		MACROS,
		type MacroId,
		type MacroScope,
		type MacroValues
	} from './macros.ts';

	interface Props {
		values: MacroValues;
		scopes: readonly MacroScope[];
		locale: string;
		disabled?: boolean;
		/** Plain-language result of the last refused macro, if any. */
		message?: string | null;
		/** Index of the macro the gate stopped last (its skirt flashes). */
		stopped?: number | null;
		onchange: (index: number, value: number) => void;
	}
	let {
		values,
		scopes,
		locale,
		disabled = false,
		message = null,
		stopped = null,
		onchange
	}: Props = $props();

	const names: Record<MacroId, () => string> = {
		bass: () => m.curva_macro_bass(),
		body: () => m.curva_macro_body(),
		presence: () => m.curva_macro_presence(),
		air: () => m.curva_macro_air()
	};
	const legendId = $props.id();
	const PX_PER_DB = 10;
	let dragging = $state<{ index: number; value: number } | null>(null);

	// Graduation: a tick per dB, labels at −6, −3, 0, +3 and +6 (mock).
	const TICKS = Array.from({ length: MACRO_MAX_DB - MACRO_MIN_DB + 1 }, (_, i) => MACRO_MIN_DB + i);
	const LABELS = [-6, -3, 0, 3, 6];

	function scopeText(scope: MacroScope | undefined): string {
		if (!scope || scope.type === 'none') return m.curva_macro_none();
		if (scope.type === 'free') return m.curva_macro_free();
		return scope.count === 1
			? m.curva_macro_section_one()
			: m.curva_macro_sections({ count: String(scope.count) });
	}
	function shown(index: number): number {
		return dragging?.index === index ? dragging.value : (values[index] ?? 0);
	}
	function angle(value: number): number {
		return ((value - MACRO_MIN_DB) / (MACRO_MAX_DB - MACRO_MIN_DB)) * 270 - 135;
	}
	function polar(value: number, radius: number): { x: number; y: number } {
		const a = (angle(value) * Math.PI) / 180;
		return { x: radius * Math.sin(a), y: -radius * Math.cos(a) };
	}
	function label(value: number): string {
		return value > 0 ? `+${value}` : value < 0 ? `\u2212${-value}` : '0';
	}
	/** Arc from 0 dB to `value` (the offset this macro applies), in the knob's coordinates. */
	function arc(value: number): string {
		if (Math.abs(value) < MACRO_STEP_DB / 2) return '';
		const from = polar(0, 30);
		const to = polar(value, 30);
		const sweep = value > 0 ? 1 : 0;
		return `M${from.x.toFixed(2)} ${from.y.toFixed(2)} A30 30 0 0 ${sweep} ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
	}
	// Integer steps per dB, so snapped values are exact decimals (3, not 3.0000000000000004).
	const PER_DB = Math.round(1 / MACRO_STEP_DB);
	const snap = (value: number) =>
		Math.round(Math.min(MACRO_MAX_DB, Math.max(MACRO_MIN_DB, value)) * PER_DB) / PER_DB;

	/** Vertical drag on the knob face; proposes the value once, on release. */
	function knobDrag(index: number) {
		return (node: HTMLElement) => {
			let start: { pointer: number; y: number; value: number } | null = null;
			const down = (event: PointerEvent) => {
				if (disabled || event.button > 0) return;
				event.preventDefault();
				node.setPointerCapture(event.pointerId);
				start = { pointer: event.pointerId, y: event.clientY, value: values[index] ?? 0 };
				dragging = { index, value: start.value };
			};
			const move = (event: PointerEvent) => {
				if (!start || event.pointerId !== start.pointer) return;
				dragging = { index, value: snap(start.value + (start.y - event.clientY) / PX_PER_DB) };
			};
			const up = (event: PointerEvent) => {
				if (!start || event.pointerId !== start.pointer) return;
				const from = start.value;
				start = null;
				const value = dragging?.index === index ? dragging.value : from;
				dragging = null;
				if (event.type !== 'pointercancel' && Math.abs(value - from) >= MACRO_STEP_DB / 2) {
					onchange(index, value);
				}
			};
			node.addEventListener('pointerdown', down);
			node.addEventListener('pointermove', move);
			node.addEventListener('pointerup', up);
			node.addEventListener('pointercancel', up);
			return () => {
				node.removeEventListener('pointerdown', down);
				node.removeEventListener('pointermove', move);
				node.removeEventListener('pointerup', up);
				node.removeEventListener('pointercancel', up);
			};
		};
	}
</script>

<section class="psec ps-mac" aria-labelledby={legendId}>
	<div class="macros">
		{#each MACROS as macro, index (macro.id)}
			{@const value = shown(index)}
			<label class="macro" class:stopped={stopped === index} class:disabled>
				<span
					class="knob"
					class:dragging={dragging?.index === index}
					aria-hidden="true"
					{@attach knobDrag(index)}
				>
					<svg viewBox="-46 -46 92 92">
						<g class="grad">
							{#each TICKS as tick (tick)}
								{@const outer = polar(tick, 35)}
								{@const inner = polar(tick, LABELS.includes(tick) ? 30 : 32)}
								<line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
							{/each}
							{#each LABELS as tick (tick)}
								{@const at = polar(tick, 42)}
								<text x={at.x} y={at.y + 3}>{label(tick)}</text>
							{/each}
						</g>
						{#if arc(value)}<path class="offset" d={arc(value)} />{/if}
						<circle r="25" class="skirt" />
						<g class="cap" style:--turn={`${angle(value)}deg`}>
							<circle r="19" class="cap-face" />
							<line x1="0" y1="-17" x2="0" y2="-7" class="cap-index" />
						</g>
					</svg>
				</span>
				<input
					type="range"
					min={MACRO_MIN_DB}
					max={MACRO_MAX_DB}
					step={MACRO_STEP_DB}
					value={values[index] ?? 0}
					{disabled}
					aria-valuetext={formatSignedDb(value, locale)}
					oninput={(event) => (dragging = { index, value: event.currentTarget.valueAsNumber })}
					onchange={(event) => {
						const input = event.currentTarget;
						dragging = null;
						onchange(index, input.valueAsNumber);
						// Snap the native thumb back to where the gate let the macro stop.
						input.valueAsNumber = values[index] ?? 0;
					}}
				/>
				<output class="lcd">{formatSignedDb(value, locale)}</output>
				<span class="name">{names[macro.id]()}</span>
				<small class="scope">{scopeText(scopes[index])}</small>
			</label>
		{/each}
	</div>
	<p class="fine-note">{m.curva_macros_note()}</p>
	{#if message}
		<p class="stopped-msg" role="status">{message}</p>
	{/if}
	<h2 class="legend-bar" id={legendId}>{m.curva_macros_heading()}</h2>
</section>

<style>
	.macros {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3) var(--space-2);
		justify-items: center;
	}
	.macro {
		position: relative;
		display: grid;
		justify-items: center;
		gap: 3px;
		width: 100%;
		color: var(--text);
	}
	.knob {
		display: block;
		width: 92px;
		height: 92px;
		border-radius: 50%;
		cursor: ns-resize;
		touch-action: none;
	}
	.macro.disabled .knob {
		cursor: not-allowed;
		opacity: 0.55;
	}
	.knob svg {
		display: block;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	.grad line {
		stroke: var(--text-2);
		stroke-width: 1.2;
	}
	.grad text {
		fill: var(--text-2);
		font: 500 9px var(--face-data);
		text-anchor: middle;
	}
	.offset {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2.4;
		stroke-linecap: round;
		filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 70%, transparent));
	}
	.skirt {
		fill: #0b0b0b;
		stroke: #000;
		stroke-width: 1;
		transition: stroke var(--dur-base) var(--ease-out);
	}
	.macro.stopped .skirt {
		stroke: var(--danger);
		stroke-width: 3;
	}
	.cap {
		transform: rotate(var(--turn));
		transition: transform var(--dur-base) var(--ease-mech);
	}
	.knob.dragging .cap {
		transition: none;
	}
	.cap-face {
		fill: #1c1d1d;
		stroke: #000;
	}
	.cap-index {
		stroke: var(--text);
		stroke-width: 3;
		stroke-linecap: round;
	}
	.macro:has(input:focus-visible) .knob {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: 2px;
	}
	/* The native slider stays the keyboard and screen-reader control, under the knob. */
	input[type='range'] {
		position: absolute;
		top: 0;
		left: calc(50% - 46px);
		width: 92px;
		height: 92px;
		margin: 0;
		opacity: 0;
		pointer-events: none;
	}
	.lcd {
		min-width: 64px;
		padding: 2px 6px;
		border-radius: var(--rad-xs);
		background: #050505;
		box-shadow: var(--well);
		/* Fixed dark LCD: the text keeps a fallback even without the tokens. */
		color: var(--accent-text, #ff7a2f);
		font: 500 var(--fs-readout) / var(--lh-readout) var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
		letter-spacing: var(--tracking-data);
		text-align: center;
		text-shadow: 0 0 6px color-mix(in srgb, var(--accent) 55%, transparent);
	}
	.name {
		font: 600 var(--fs-small) / 1.1 var(--face-engrave);
		letter-spacing: 0.18em;
		text-transform: uppercase;
	}
	.scope {
		color: var(--text-2);
		font: 400 var(--label-min) / var(--lh-small) var(--face-data);
	}
	.fine-note {
		margin: var(--space-3) 0 0;
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
		text-align: center;
	}
	.stopped-msg {
		margin: 6px 0 0;
		padding: 6px 8px;
		border-left: 3px solid var(--danger);
		color: var(--text);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	@media (prefers-reduced-motion: reduce) {
		.cap,
		.skirt {
			transition: none;
		}
	}
</style>
