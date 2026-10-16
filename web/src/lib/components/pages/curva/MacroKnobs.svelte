<!--
	N1 macros: Grave, Corpo, Presença, Brilho. Each knob is a native range input (keyboard and
	screen-reader friendly); the value is proposed on release and the page runs it through the gate
	(see macros.ts for the documented mapping). A refusal shows where it stopped and why.
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
		onchange: (index: number, value: number) => void;
	}
	let { values, scopes, locale, disabled = false, message = null, onchange }: Props = $props();

	const names: Record<MacroId, () => string> = {
		bass: () => m.curva_macro_bass(),
		body: () => m.curva_macro_body(),
		presence: () => m.curva_macro_presence(),
		air: () => m.curva_macro_air()
	};
	const legendId = $props.id();
	let dragging = $state<{ index: number; value: number } | null>(null);

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
</script>

<section class="psec ps-mac" aria-labelledby={legendId}>
	<div class="macros">
		{#each MACROS as macro, index (macro.id)}
			{@const value = shown(index)}
			<label class="macro">
				<span class="knob" aria-hidden="true" style:--turn={`${angle(value)}deg`}>
					<span class="cap"></span>
				</span>
				<span class="name">{names[macro.id]()}</span>
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
				<output class="readout">{formatSignedDb(value, locale)}</output>
				<small class="scope">{scopeText(scopes[index])}</small>
			</label>
		{/each}
	</div>
	<p class="fine-note">{m.curva_macros_note()}</p>
	{#if message}
		<p class="stopped" role="status">{message}</p>
	{/if}
	<h2 class="legend-bar" id={legendId}>{m.curva_macros_heading()}</h2>
</section>

<style>
	.macros {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px 6px;
		justify-items: center;
	}
	.macro {
		display: grid;
		justify-items: center;
		gap: 3px;
		width: 100%;
		color: var(--curva-silk, #e9e3d4);
	}
	.knob {
		position: relative;
		display: block;
		width: 52px;
		height: 52px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #3d3e3e, #171818 55%, #050505);
		box-shadow: 0 3px 6px rgb(0 0 0 / 0.6);
	}
	.cap {
		position: absolute;
		inset: 7px;
		border-radius: 50%;
		background: radial-gradient(circle at 38% 30%, #2f3030, #060606);
		transform: rotate(var(--turn));
		transition: transform 120ms ease-out;
	}
	.cap::after {
		content: '';
		position: absolute;
		top: 3px;
		left: calc(50% - 1.5px);
		width: 3px;
		height: 12px;
		border-radius: 2px;
		background: #f6f2e8;
	}
	.name {
		font: 600 10px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	input[type='range'] {
		width: 100%;
		max-width: 120px;
		accent-color: var(--accent, #ff7a2f);
	}
	input[type='range']:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 2px;
	}
	.readout {
		font: 12px/1 var(--font-mono, 'JetBrains Mono', monospace);
	}
	.scope,
	.fine-note {
		font-size: 11px;
		color: var(--curva-silk-2, #c9c1ae);
	}
	.fine-note {
		margin: 8px 0 0;
	}
	.stopped {
		margin: 6px 0 0;
		padding: 6px 8px;
		border-left: 3px solid var(--accent, #ff7a2f);
		font-size: 12px;
		color: var(--curva-silk, #e9e3d4);
	}
	@media (prefers-reduced-motion: reduce) {
		.cap {
			transition: none;
		}
	}
</style>
