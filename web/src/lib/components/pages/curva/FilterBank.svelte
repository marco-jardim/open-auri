<!--
	Filter bank (Ajustar and Engenharia, mock v2 .bank): 10 strips in written order, each with
	- a rotary kind switch (PK, LS, OFF; HS, LP and HP engraved and locked outside Engenharia). The
	  native select is the control, laid over the switch, so keyboard and screen readers keep it;
	- CORTE and REFORÇO lamps (the sign of the band's real gain) and a mini response of the section;
	- FREQ, GANHO and Q knobs with LCD fields. Typing goes through the same gate-bounded move as the
	  handles (stop at the boundary, round, revalidate). Dragging a knob (up or down) previews the
	  value on the scope every frame (`ondrag`, advisory only) and proposes it once, on release;
	- a stage LED: live PPM after that section while the preview plays, otherwise the prefix peak
	  from the gate metrics (DATA).
	The head carries the observed-envelope strip: the gate's seven criteria (a) to (g), each with a
	lamp that is lit while it passes and the measured value; limits and the gate's technical words
	sit behind "Ver detalhes técnicos" (open in Engenharia).
-->
<script lang="ts">
	import { isExperimentalKind } from 'open-auri/safety';
	import { LedLadder, MeterModeLabel } from '#lib/components/meters/index.ts';
	import type { MeterFrame, MeterMode } from '#lib/audio/meters.ts';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import { Button, Lamp } from '#lib/components/primitives/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { criteria, criterionName } from './envelope.ts';
	import { formatSignedDb } from './format.ts';
	import { isLockedKind, kindsForLayer, type Layer } from './layers.ts';
	import { miniPath } from './mini.ts';
	import {
		bandValue,
		hasGain,
		type Band,
		type BandKind,
		type Curve,
		type DragParam
	} from './model.ts';
	import type { GateVerdict } from './reasons.ts';
	import type { DragTarget } from './drag.ts';

	/** A LiveMeter, or an idle stand-in (DATA mode) before the preview exists. */
	interface StageMeter {
		readonly mode: MeterMode;
		readonly frame: MeterFrame | null;
	}

	interface Props {
		curve: Curve;
		/** Gate verdict of the committed editor curve (envelope strip and stage peaks). */
		verdict: GateVerdict;
		layer: Layer;
		locale: string;
		stages: readonly StageMeter[];
		message?: string | null;
		/** Section selected on the scope (its strip is outlined). */
		selected?: number | null;
		/** Advisory preview while a knob turns (never committed as such). */
		ondrag?: (index: number, target: DragTarget) => void;
		onmove: (index: number, target: DragTarget) => void;
		onkind: (index: number, kind: BandKind) => void;
		onorder: () => void;
	}
	let {
		curve,
		verdict,
		layer,
		locale,
		stages,
		message = null,
		selected = null,
		ondrag,
		onmove,
		onkind,
		onorder
	}: Props = $props();

	const headingId = $props.id();
	const options = $derived(['OFF', ...kindsForLayer(layer).filter((kind) => kind !== 'OFF')]);
	const stageMode = $derived(stages.some((stage) => stage.mode === 'live') ? 'live' : 'data');
	const rows = $derived(criteria(verdict, locale));

	// Rotary kind switch: where each position sits (degrees from 12 o'clock).
	const SWITCH: readonly { kind: BandKind; angle: number }[] = [
		{ kind: 'PK', angle: -60 },
		{ kind: 'LS', angle: 0 },
		{ kind: 'OFF', angle: 60 },
		{ kind: 'HS', angle: 120 },
		{ kind: 'LP', angle: 180 },
		{ kind: 'HP', angle: -120 }
	];
	const switchAngle = (kind: BandKind) => SWITCH.find((s) => s.kind === kind)?.angle ?? 60;
	const at = (angle: number, radius: number) => {
		const a = (angle * Math.PI) / 180;
		return { x: radius * Math.sin(a), y: -radius * Math.cos(a) };
	};

	// Knobs: value ↔ position (0…1 across 270°) and pointer sensitivity.
	interface KnobSpec {
		min: number;
		max: number;
		log: boolean;
		/** Pointer pixels for the full travel. */
		travel: number;
		round: (value: number) => number;
	}
	const KNOBS: Record<DragParam, KnobSpec> = {
		freqHz: { min: 20, max: 20000, log: true, travel: 360, round: (v) => Math.round(v) },
		gainDb: { min: -15, max: 9.2, log: false, travel: 240, round: (v) => Math.round(v * 10) / 10 },
		qFactor: { min: 0.1, max: 20, log: true, travel: 300, round: (v) => Math.round(v * 100) / 100 }
	};
	function position(param: DragParam, value: number): number {
		const spec = KNOBS[param];
		const clamped = Math.min(spec.max, Math.max(spec.min, value));
		return spec.log
			? Math.log(clamped / spec.min) / Math.log(spec.max / spec.min)
			: (clamped - spec.min) / (spec.max - spec.min);
	}
	function valueAt(param: DragParam, t: number): number {
		const spec = KNOBS[param];
		const u = Math.min(1, Math.max(0, t));
		const raw = spec.log
			? spec.min * (spec.max / spec.min) ** u
			: spec.min + u * (spec.max - spec.min);
		return spec.round(raw);
	}
	const knobAngle = (param: DragParam, value: number) => position(param, value) * 270 - 135;
	const KNOB_TICKS = Array.from({ length: 11 }, (_, i) => i * 27 - 135);

	let knob = $state<{ index: number; param: DragParam; value: number } | null>(null);

	function shownValue(band: Band, index: number, param: DragParam): number | null {
		if (knob && knob.index === index && knob.param === param) return knob.value;
		return bandValue(band, param);
	}

	/** Vertical drag on a knob: previews on the scope every move, proposes once on release. */
	function knobDrag(index: number, param: DragParam) {
		return (node: HTMLElement) => {
			let start: { pointer: number; y: number; t: number; value: number } | null = null;
			const down = (event: PointerEvent) => {
				const band = curve.bands[index];
				if (!band || event.button > 0 || node.dataset.locked === 'true') return;
				const value = bandValue(band, param);
				if (value === null) return;
				event.preventDefault();
				node.setPointerCapture(event.pointerId);
				start = { pointer: event.pointerId, y: event.clientY, t: position(param, value), value };
				knob = { index, param, value };
			};
			const move = (event: PointerEvent) => {
				if (!start || event.pointerId !== start.pointer) return;
				const value = valueAt(param, start.t + (start.y - event.clientY) / KNOBS[param].travel);
				if (knob?.value === value) return;
				knob = { index, param, value };
				ondrag?.(index, { [param]: value });
			};
			const up = (event: PointerEvent) => {
				if (!start || event.pointerId !== start.pointer) return;
				const from = start.value;
				start = null;
				const value = knob?.index === index && knob.param === param ? knob.value : from;
				knob = null;
				if (event.type !== 'pointercancel' && value !== from) onmove(index, { [param]: value });
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

	function kindName(kind: string): string {
		if (kind === 'OFF') return m.curva_kind_off();
		return isExperimentalKind(kind) ? `${kind} · ${m.curva_exp_badge()}` : kind;
	}
	function prefixPeak(index: number): number | null {
		return verdict.metrics.prefixAudible?.find((peak) => peak.stage === index + 1)?.db ?? null;
	}
	function liveLevel(index: number): number | null {
		const frame = stages[index]?.frame;
		return frame ? Math.max(frame.ppmL, frame.ppmR) : null;
	}
	function oncommit(index: number, param: DragParam, input: HTMLInputElement) {
		const value = input.valueAsNumber;
		const band = curve.bands[index];
		const current = band ? bandValue(band, param) : null;
		// Show the accepted value until the gate answers; an accepted move updates the prop.
		if (current !== null) input.valueAsNumber = current;
		if (!Number.isFinite(value)) return;
		onmove(index, { [param]: value });
	}
	function isKind(value: string): value is BandKind {
		return ['OFF', 'PK', 'LS', 'HS', 'LP', 'HP'].includes(value);
	}
	/** Real sign of the band: a cut (negative gain, LP, HP) or a boost (positive gain). */
	function sign(band: Band): { cut: boolean; boost: boolean } {
		if (band.kind === 'OFF') return { cut: false, boost: false };
		if (!hasGain(band)) return { cut: true, boost: false };
		return { cut: band.gainDb < 0, boost: band.gainDb > 0 };
	}
</script>

{#snippet dial(index: number, param: DragParam, value: number, locked: boolean)}
	<span
		class="kdial"
		class:turning={knob?.index === index && knob.param === param}
		data-locked={locked}
		aria-hidden="true"
		{@attach knobDrag(index, param)}
	>
		<svg viewBox="-30 -30 60 60">
			{#each KNOB_TICKS as tick (tick)}
				{@const outer = at(tick, 28)}
				{@const inner = at(tick, 24.5)}
				<line class="ktick" x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
			{/each}
			<circle r="21" class="kskirt" />
			<g class="kcap" style:--turn={`${knobAngle(param, value)}deg`}>
				<circle r="16" class="kface" />
				<line x1="0" y1="-14" x2="0" y2="-6" class="kindex" />
			</g>
		</svg>
	</span>
{/snippet}

<section class="bank" aria-labelledby={headingId}>
	<span class="hinge" aria-hidden="true"></span>
	<header class="bank-head">
		<div class="bank-title">
			<h2 id={headingId}>{m.curva_bank_heading()}</h2>
			<p>{m.curva_bank_sub()}</p>
			<div class="bank-tools">
				<Button size="sm" caps onclick={onorder}>{m.curva_order_reset()}</Button>
				<MeterModeLabel mode={stageMode} />
			</div>
		</div>
		<div class="envelope">
			<div class="env-head">
				<h3 class="env-title" id="{headingId}-env">{m.curva_v2_envelope_title()}</h3>
				<Explainer term="envelope" />
				<Explainer term="gate" />
			</div>
			<ul class="gaterow" aria-labelledby="{headingId}-env" aria-describedby="{headingId}-envnote">
				{#each rows as row (row.id)}
					<li class="crit" class:fail={!row.pass}>
						<Lamp on={row.known || !row.pass} tone={row.pass ? 'accent' : 'danger'} />
						<span class="crit-name"
							><span class="crit-id">({row.id})</span> {criterionName[row.id]()}</span
						>
						<span class="crit-value">{row.value}</span>
						<span class="sr-only">{row.pass ? m.curva_chip_inside() : m.curva_chip_outside()}</span>
					</li>
				{/each}
			</ul>
			<p class="env-note" id="{headingId}-envnote">{m.curva_v2_envelope_strip()}</p>
		</div>
	</header>
	{#if message}
		<p class="bank-msg" role="status">{message}</p>
	{/if}
	<div class="modules-scroll">
		<ol class="modules">
			{#each curve.bands as band, index (index)}
				{@const locked = band.kind !== 'OFF' && isLockedKind(band.kind, layer)}
				{@const off = band.kind === 'OFF'}
				{@const lamps = sign(band)}
				<li class="module" class:off class:locked class:sel={selected === index}>
					<span class="screw sa" aria-hidden="true"></span>
					<span class="screw sb" aria-hidden="true"></span>
					<div class="mod-head">
						<span class="mod-n">{m.curva_filter({ index: String(index + 1) })}</span>
						<span class="mod-stage">{m.curva_v2_stage({ index: String(index + 1) })}</span>
						{#if band.kind !== 'OFF' && isExperimentalKind(band.kind)}
							<span class="badge">{m.curva_exp_badge()}</span>
						{/if}
					</div>
					<label class="kind">
						<span class="sr-only">{m.curva_kind()}</span>
						<span class="switch" aria-hidden="true">
							<svg viewBox="-46 -34 92 68">
								{#each SWITCH as stop (stop.kind)}
									{@const p = at(stop.angle, 25)}
									<text
										class="sw-label"
										class:on={band.kind === stop.kind}
										class:dim={stop.kind !== 'OFF' && isLockedKind(stop.kind, layer)}
										x={p.x}
										y={p.y + 3}>{stop.kind}</text
									>
								{/each}
								<circle r="12" class="sw-skirt" />
								<g class="sw-cap" style:--turn={`${switchAngle(band.kind)}deg`}>
									<line x1="0" y1="-11" x2="0" y2="-3" class="sw-index" />
								</g>
							</svg>
						</span>
						<select
							value={band.kind}
							disabled={locked}
							onchange={(event) => {
								const select = event.currentTarget;
								if (isKind(select.value)) onkind(index, select.value);
								select.value = curve.bands[index]?.kind ?? 'OFF';
							}}
						>
							{#if locked}
								<option value={band.kind}>{kindName(band.kind)}</option>
							{/if}
							{#each options as kind (kind)}
								<option value={kind}>{kindName(kind)}</option>
							{/each}
						</select>
					</label>
					<div class="signs">
						<span class="sign"><Lamp on={lamps.cut} />{m.curva_v2_cut()}</span>
						<span class="sign"><Lamp on={lamps.boost} />{m.curva_v2_boost()}</span>
					</div>
					{#if band.kind !== 'OFF'}
						{@const freq = shownValue(band, index, 'freqHz') ?? band.freqHz}
						<div class="kctl">
							{@render dial(index, 'freqHz', freq, locked)}
							<label class="field">
								<span>{m.curva_freq()} (Hz)</span>
								<input
									type="number"
									min="20"
									max="20000"
									step="1"
									value={freq}
									disabled={locked}
									onchange={(event) => oncommit(index, 'freqHz', event.currentTarget)}
								/>
							</label>
						</div>
						{#if hasGain(band)}
							{@const gain = shownValue(band, index, 'gainDb') ?? band.gainDb}
							<div class="kctl">
								{@render dial(index, 'gainDb', gain, locked)}
								<label class="field">
									<span>{m.curva_gain()} (dB)</span>
									<input
										type="number"
										min="-24"
										max="9.2"
										step="0.1"
										value={gain}
										disabled={locked}
										onchange={(event) => oncommit(index, 'gainDb', event.currentTarget)}
									/>
								</label>
							</div>
						{/if}
						{@const q = shownValue(band, index, 'qFactor') ?? band.qFactor}
						<div class="kctl">
							{@render dial(index, 'qFactor', q, locked)}
							<label class="field">
								<span>{m.curva_q()}</span>
								<input
									type="number"
									min="0.1"
									max="20"
									step="0.01"
									value={q}
									disabled={locked}
									onchange={(event) => oncommit(index, 'qFactor', event.currentTarget)}
								/>
							</label>
						</div>
						{#if index === 0 || selected === index}
							<div class="q-help"><Explainer term="q" /></div>
						{/if}
						{#if locked}
							<p class="hint">{m.curva_exp_hint()}</p>
						{/if}
					{/if}
					<svg class="mini" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
						<line x1="0" y1="12" x2="100" y2="12" />
						{#if !off}<path
								d={miniPath([band], 100, 24, 15)}
								vector-effect="non-scaling-stroke"
							/>{/if}
					</svg>
					<div class="led-row">
						<LedLadder
							mode={stages[index]?.mode ?? 'data'}
							live={liveLevel(index)}
							data={prefixPeak(index)}
							label={m.curva_stage_led({ index: String(index + 1) })}
							orientation="horizontal"
						/>
						{#if prefixPeak(index) !== null && !off}
							<small>{formatSignedDb(prefixPeak(index) ?? 0, locale)}</small>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
	</div>
	<details class="tech" open={layer === 'engenharia'}>
		<summary>{m.curva_v2_details()}</summary>
		<table>
			<thead>
				<tr>
					<th scope="col">{m.curva_v2_details_criterion()}</th>
					<th scope="col">{m.curva_v2_details_value()}</th>
					<th scope="col">{m.curva_v2_details_limit()}</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.id)}
					<tr class:fail={!row.pass}>
						<th scope="row">({row.id}) {criterionName[row.id]()}</th>
						<td>{row.value}</td>
						<td>{row.limit}</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<p>{m.curva_v2_details_note()}</p>
	</details>
	<div class="bank-foot">
		<button type="button" class="soon-ctl" aria-disabled="true">{m.curva_soon_raw()}</button>
		<span class="soon-badge">{m.curva_soon()}</span>
		<p class="soon-note">{m.curva_soon_note()}</p>
	</div>
</section>

<style>
	.bank {
		position: relative;
		padding: var(--space-4) var(--space-5) var(--space-4);
		border-radius: var(--rad-lg);
		background:
			linear-gradient(180deg, rgb(255 255 255 / 0.05), transparent 30%),
			linear-gradient(#2e2d2b, #1f1e1c);
		box-shadow: var(--elev-2);
		color: var(--text);
	}
	.hinge {
		position: absolute;
		top: -6px;
		left: 4%;
		right: 4%;
		height: 6px;
		border-radius: var(--rad-xs) var(--rad-xs) 0 0;
		background: linear-gradient(180deg, #5d5c58, #2a2927);
	}
	.bank-head {
		display: grid;
		grid-template-columns: minmax(220px, 1fr) minmax(0, 2.4fr);
		gap: var(--space-3) var(--space-5);
		align-items: start;
	}
	.bank-title h2 {
		margin: 0;
		font: 600 var(--fs-title) / var(--lh-title) var(--face-engrave);
		letter-spacing: 0.18em;
		text-transform: uppercase;
	}
	.bank-title p {
		margin: 2px 0 0;
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.bank-tools {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-3);
		align-items: center;
		margin-top: var(--space-2);
	}
	.env-head {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
	.env-title {
		margin: 0;
		color: var(--text-2);
		font: 600 var(--label-min) / var(--lh-caps) var(--face-engrave);
		letter-spacing: 0.2em;
		text-transform: uppercase;
	}
	.gaterow {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		gap: var(--space-2);
		margin: var(--space-2) 0 0;
		padding: 0;
		list-style: none;
	}
	.crit {
		display: grid;
		justify-items: center;
		gap: 3px;
		text-align: center;
	}
	.crit-name {
		color: var(--text);
		font: 600 var(--label-min) / 1.15 var(--face-engrave);
		letter-spacing: 0.04em;
	}
	.crit-id {
		color: var(--text-2);
	}
	.crit-value {
		color: var(--text-2);
		font: 400 var(--label-min) / 1.15 var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.crit.fail .crit-value {
		color: #ffb3b6;
	}
	.env-note {
		margin: var(--space-2) 0 0;
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.bank-msg,
	.hint {
		margin: 8px 0 0;
		padding: 4px 8px;
		border-left: 3px solid var(--accent);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.modules-scroll {
		margin-top: var(--space-4);
		overflow-x: auto;
		padding-bottom: var(--space-1);
	}
	.modules {
		display: grid;
		grid-template-columns: repeat(10, minmax(118px, 1fr));
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.module {
		position: relative;
		display: grid;
		align-content: start;
		justify-items: center;
		gap: 6px;
		padding: 10px 8px;
		border: 1px solid rgb(0 0 0 / 0.7);
		border-radius: var(--rad-md);
		background: linear-gradient(180deg, #262523, #191817);
		box-shadow: var(--bevel);
	}
	.module.sel {
		border-color: var(--accent);
		box-shadow: var(--bevel), var(--glow-1);
	}
	.module.off .kctl,
	.module.off .signs {
		opacity: 0.55;
	}
	.module.locked {
		border-style: dashed;
		border-color: var(--rule-control);
	}
	.screw {
		position: absolute;
		top: 4px;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 35%, #d9d5cc, #77736b 70%);
	}
	.sa {
		left: 4px;
	}
	.sb {
		right: 4px;
	}
	.mod-head {
		display: grid;
		justify-items: center;
		gap: 1px;
	}
	.mod-n {
		font: 600 var(--fs-small) / 1.1 var(--face-engrave);
		letter-spacing: 0.16em;
		text-transform: uppercase;
	}
	.mod-stage {
		color: var(--text-2);
		font: 400 var(--label-min) / 1.1 var(--face-data);
	}
	.badge,
	.soon-badge {
		padding: 1px 5px;
		border: 1px solid var(--accent);
		border-radius: var(--rad-xs);
		color: var(--accent-text);
		font: 500 var(--label-min) / 1.3 var(--face-data);
		letter-spacing: 0.08em;
	}
	.kind {
		position: relative;
		display: block;
		width: 92px;
		height: 68px;
	}
	.switch svg {
		display: block;
		width: 92px;
		height: 68px;
	}
	.sw-label {
		fill: var(--text-2);
		font: 600 10px var(--face-engrave);
		letter-spacing: 0.06em;
		text-anchor: middle;
	}
	.sw-label.dim {
		fill-opacity: 0.45;
	}
	.sw-label.on {
		fill: var(--accent);
		fill-opacity: 1;
	}
	.sw-skirt {
		fill: #0d0d0d;
		stroke: #000;
	}
	.sw-cap {
		transform: rotate(var(--turn));
		transition: transform var(--dur-base) var(--ease-mech);
	}
	.sw-index {
		stroke: var(--text);
		stroke-width: 2.6;
		stroke-linecap: round;
	}
	/* The native select is the switch's control: invisible, over the whole switch. */
	.kind select {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		opacity: 0;
		cursor: pointer;
	}
	.kind select:disabled {
		cursor: not-allowed;
	}
	.kind:has(select:focus-visible) .switch {
		display: block;
		border-radius: var(--rad-md);
		outline: var(--focus-width) solid var(--accent);
		outline-offset: 1px;
	}
	.signs {
		display: flex;
		gap: 8px;
		justify-content: center;
	}
	.sign {
		display: inline-flex;
		gap: 4px;
		align-items: center;
		color: var(--text-2);
		font: 600 var(--label-min) / 1 var(--face-engrave);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.sign :global(.lamp) {
		width: 7px;
		height: 7px;
	}
	.kctl {
		display: grid;
		justify-items: center;
		gap: 2px;
	}
	.kdial {
		display: block;
		width: 52px;
		height: 52px;
		cursor: ns-resize;
		touch-action: none;
	}
	.kdial[data-locked='true'] {
		cursor: not-allowed;
		opacity: 0.5;
	}
	.kdial svg {
		display: block;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	.ktick {
		stroke: var(--text-2);
		stroke-opacity: 0.6;
		stroke-width: 1.2;
	}
	.kskirt {
		fill: #0b0b0b;
		stroke: #000;
	}
	.kcap {
		transform: rotate(var(--turn));
		transition: transform var(--dur-base) var(--ease-mech);
	}
	.kdial.turning .kcap {
		transition: none;
	}
	.kface {
		fill: #1d1e1e;
		stroke: #000;
	}
	.kindex {
		stroke: var(--text);
		stroke-width: 2.6;
		stroke-linecap: round;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 2px;
		align-items: center;
		color: var(--text);
		font: 600 var(--label-min) / 1.1 var(--face-engrave);
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.field span {
		order: 2;
	}
	.field input {
		order: 1;
		box-sizing: border-box;
		width: 88px;
		min-height: 26px;
		padding: 2px 6px;
		border: 1px solid #262624;
		border-radius: var(--rad-xs);
		background: #050505;
		box-shadow: var(--well);
		/* Fixed dark LCD: the text keeps a fallback even without the tokens. */
		color: var(--accent-text, #ff7a2f);
		font: 500 var(--fs-caption) / 1.2 var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
		letter-spacing: var(--tracking-data);
		text-align: center;
		text-transform: none;
	}
	.field input:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: 1px;
	}
	.field input:disabled {
		color: var(--muted-hi);
	}
	.mini {
		display: block;
		width: 100%;
		height: 24px;
		border-radius: var(--rad-xs);
		background: #050505;
		box-shadow: var(--well);
	}
	.mini line {
		stroke: var(--rule);
	}
	.mini path {
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.3;
	}
	.led-row {
		display: flex;
		gap: 6px;
		align-items: center;
		color: var(--text-2);
		font: 400 var(--label-min) var(--face-data);
	}
	.tech {
		margin-top: var(--space-4);
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.tech summary {
		width: fit-content;
		min-height: var(--hit);
		display: flex;
		align-items: center;
		color: var(--text);
		font: 500 var(--fs-small) / 1 var(--face-body);
		cursor: pointer;
	}
	.tech summary:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.tech table {
		border-collapse: collapse;
		margin-top: var(--space-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.tech th,
	.tech td {
		padding: 3px 14px 3px 0;
		border-bottom: 1px solid var(--rule);
		text-align: left;
	}
	.tech thead th {
		color: var(--text-2);
		font-family: var(--face-body);
		font-weight: 500;
	}
	.tech tbody th {
		color: var(--text);
		font-weight: 400;
	}
	.tech tr.fail td {
		color: #ffb3b6;
	}
	.bank-foot {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		margin-top: 12px;
		padding-top: 10px;
		border-top: 1px solid var(--rule);
	}
	.soon-ctl {
		padding: 4px 8px;
		border: 1px dashed var(--rule-control);
		border-radius: var(--rad-sm);
		background: transparent;
		color: var(--text-2);
		font: 500 var(--fs-caption) / 1.2 var(--face-body);
		cursor: not-allowed;
	}
	.soon-note {
		flex: 1 1 100%;
		margin: 0;
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (prefers-reduced-motion: reduce) {
		.sw-cap,
		.kcap {
			transition: none;
		}
	}
	@media (max-width: 1100px) {
		.bank-head {
			grid-template-columns: minmax(0, 1fr);
		}
		.gaterow {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	@media (max-width: 720px) {
		.bank {
			padding: var(--space-3);
		}
	}
</style>
