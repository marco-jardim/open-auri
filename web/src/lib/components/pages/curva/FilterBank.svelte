<!--
	Filter bank (Ajustar and Engenharia, mock v2 .bank): 10 strips in written order, laid out as a
	grid that never scrolls sideways (5 × 2 when the bank is at least 590 px wide, otherwise as many
	columns of at least 116 px as fit: 4, 3, 2 or 1). Each strip has
	- a header: the slot badge (A to J, the same letter as the scope handle), the functional name
	  (`band-names.ts`) or the user's own one, a rename button (inline field, up to LABEL_MAX = 24
	  code points under the strict label rules, a refused name keeps the field open with the
	  reason; Enter saves, Esc cancels) and, on hover or focus, the processing stage ("estágio N");
	- a click-stepped rotary kind switch (PK, LS, OFF; HS, LP and HP engraved and locked outside
	  Engenharia), with keyboard stepping and a hover/focus legend;
	- CORTE and REFORÇO lamps (the sign of the band's real gain) and a mini response of the section;
	- FREQ, GANHO and Q knobs with LCD fields. Typing goes through the same gate-bounded move as the
	  handles (stop at the boundary, round, revalidate). Dragging a knob (up or down) previews the
	  value on the scope every frame (`ondrag`, advisory only) and proposes it once, on release;
	- a stage LED: live PPM after that section while the preview plays, otherwise the prefix peak
	  from the gate metrics (DATA).
	The head carries the observed-envelope strip: the gate's seven criteria (a) to (g), each with a
	lamp that is lit while it passes and the measured value; limits and the gate's technical words
	sit behind "Ver detalhes técnicos" (open in Engenharia). The bank is its own size container:
	head and strips follow its width, not the viewport's.
	The technical words themselves open their explainers (term variant, dotted underline): the
	strip title, the word "gate" in the strip's note and every strip's Q label.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { isExperimentalKind } from 'open-auri/safety';
	// Direct imports (FUX.B): the meters barrel would bring every meter component into the page.
	import LedLadder from '#lib/components/meters/LedLadder.svelte';
	import MeterModeLabel from '#lib/components/meters/MeterModeLabel.svelte';
	import type { MeterFrame, MeterMode } from '#lib/audio/meters.ts';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import { Button, Lamp } from '#lib/components/primitives/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { bandWords, useBandLabels } from './band-labels.svelte.ts';
	import { bandNames, checkLabel, LABEL_MAX, type LabelIssue } from './band-names.ts';
	import { criteria, criterionName } from './envelope.ts';
	import { formatSignedDb } from './format.ts';
	import KindDial, { type KindCheck } from './KindDial.svelte';
	import { changeKind } from './edit.ts';
	import { isLockedKind, type Layer } from './layers.ts';
	import { miniPath } from './mini.ts';
	import {
		bandValue,
		hasGain,
		type Band,
		type BandKind,
		type Curve,
		type DragParam
	} from './model.ts';
	import { firstReasonText, type GateVerdict } from './reasons.ts';
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
		/** Non-mutating preflight from the editor, including its current gate profile. */
		canApplyKind?: (index: number, kind: BandKind) => KindCheck | Promise<KindCheck>;
		/** Profile changes cancel pending dials, just like an external curve change. */
		kindContext?: unknown;
		kindDisabledReason?: string | null;
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
		canApplyKind,
		kindContext,
		kindDisabledReason = null,
		onorder
	}: Props = $props();

	const headingId = $props.id();
	let focusGeneration = $state(0);
	const dialContext = $derived({ curve, kindContext, focusGeneration });
	function checkKind(index: number, kind: BandKind): KindCheck | Promise<KindCheck> {
		if (canApplyKind) return canApplyKind(index, kind);
		// Standalone banks keep the same full-grid, standard-profile discrete-edit gate.
		const result = changeKind(curve, index, kind);
		return result.ok
			? { ok: true }
			: { ok: false, reason: firstReasonText(result.reasons, { bands: curve.bands, locale }) };
	}
	const stageMode = $derived(stages.some((stage) => stage.mode === 'live') ? 'live' : 'data');
	const rows = $derived(criteria(verdict, locale));
	// The note's own word "gate" (both locales say it) is the gate explainer; no text is added.
	// Should a translation drop the word, the whole note becomes the trigger.
	const envNote = $derived.by(() => {
		const text = m.curva_v2_envelope_strip();
		const match = /\bgate\b/i.exec(text);
		if (!match) return { before: '', word: text, after: '' };
		return {
			before: text.slice(0, match.index),
			word: match[0],
			after: text.slice(match.index + match[0].length)
		};
	});

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
	/** Real sign of the band: a cut (negative gain, LP, HP) or a boost (positive gain). */
	function sign(band: Band): { cut: boolean; boost: boolean } {
		if (band.kind === 'OFF') return { cut: false, boost: false };
		if (!hasGain(band)) return { cut: true, boost: false };
		return { cut: band.gainDb < 0, boost: band.gainDb > 0 };
	}

	// --- names: badge, functional or custom name, inline rename --------------------------------

	const labelStore = useBandLabels();
	const words = bandWords();
	const names = $derived(bandNames(curve.bands, words, labelStore.labels));
	let bankElement: HTMLElement | undefined = $state();
	/** Slot whose name is being edited. */
	let renaming = $state<number | null>(null);
	/** Why the open field's name is refused (envelope codes); shown inline, the field stays open. */
	let renameIssues = $state.raw<readonly LabelIssue[]>([]);
	const renameIssueText: Record<LabelIssue, () => string> = {
		'env:url': () => m.curva_bn_rename_url(),
		'env:url-like': () => m.curva_bn_rename_url_like(),
		'env:length': () => m.curva_bn_rename_length({ max: LABEL_MAX }),
		'env:pattern': () => m.curva_bn_rename_pattern()
	};

	function startRename(index: number): void {
		renameIssues = [];
		renaming = index;
	}
	/**
	 * The focused rename field that Enter or Escape is closing. Its removal blurs it with no
	 * `relatedTarget` before its button exists again; that handoff is not focus leaving the bank.
	 */
	let renameHandoff: Element | null = null;
	function focusRename(index: number): void {
		void tick().then(() => {
			bankElement?.querySelector<HTMLButtonElement>(`[data-rename="${index}"]`)?.focus();
			const handedOff = renameHandoff !== null;
			renameHandoff = null;
			// Only a handoff that failed to land back in the bank counts as a real exit.
			if (handedOff && !bankElement?.contains(document.activeElement)) focusGeneration++;
		});
	}
	/**
	 * Ends the edit of `index`: `value` null cancels. The name goes through the strict label rules
	 * (`checkLabel`): a refused one is never stored or cut, the field stays open with the reason. A
	 * name equal to the automatic one (or empty) goes back to the automatic name, so it keeps
	 * following the band.
	 */
	function endRename(index: number, value: string | null, refocus: boolean): void {
		if (renaming !== index) return;
		if (value !== null) {
			const checked = checkLabel(value);
			const result = checked.ok
				? labelStore.rename(index, checked.label === names[index]?.auto ? null : checked.label)
				: checked;
			if (!result.ok) {
				renameIssues = result.issues;
				return;
			}
		}
		const active = document.activeElement;
		if (refocus && active instanceof HTMLInputElement && bankElement?.contains(active)) {
			renameHandoff = active;
		}
		renaming = null;
		renameIssues = [];
		if (refocus) focusRename(index);
	}
	/** Live length in code points (as the envelope counts them); other reasons wait for Enter. */
	function renameInput(value: string): void {
		const checked = checkLabel(value);
		renameIssues = !checked.ok && checked.issues.includes('env:length') ? ['env:length'] : [];
	}
	function renameKey(
		event: KeyboardEvent & { currentTarget: HTMLInputElement },
		index: number
	): void {
		if (event.key === 'Enter') {
			event.preventDefault();
			endRename(index, event.currentTarget.value, true);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			endRename(index, null, true);
		}
	}
	const selectAll = (node: HTMLInputElement) => {
		node.focus();
		node.select();
	};
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

<section
	class="bank"
	aria-labelledby={headingId}
	bind:this={bankElement}
	onfocusout={(event) => {
		// The closing rename field: focusRename returns focus to its button, or counts the exit.
		if (renameHandoff !== null && event.target === renameHandoff) return;
		if (
			!(event.relatedTarget instanceof Node) ||
			!event.currentTarget.contains(event.relatedTarget)
		) {
			focusGeneration++;
		}
	}}
>
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
				<h3 class="env-title" id="{headingId}-env">
					<Explainer term="envelope" variant="term">{m.curva_v2_envelope_title()}</Explainer>
				</h3>
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
			<p class="env-note" id="{headingId}-envnote">
				{envNote.before}<Explainer term="gate" variant="term">{envNote.word}</Explainer
				>{envNote.after}
			</p>
		</div>
	</header>
	{#if message}
		<p class="bank-msg" role="status">{message}</p>
	{/if}
	<p class="sr-only" id="{headingId}-rename">{m.curva_bn_rename_hint_max({ max: LABEL_MAX })}</p>
	<ol class="modules">
		{#each curve.bands as band, index (index)}
			{@const locked = band.kind !== 'OFF' && isLockedKind(band.kind, layer)}
			{@const off = band.kind === 'OFF'}
			{@const lamps = sign(band)}
			{@const name = names[index]}
			{@const badge = name?.badge ?? String(index + 1)}
			{@const stage = String(index + 1)}
			<li class="module" class:off class:locked class:sel={selected === index}>
				<span class="screw sa" aria-hidden="true"></span>
				<span class="screw sb" aria-hidden="true"></span>
				<!-- Reading order: badge, name, stage, rename (the grid places them, see .mod-head). -->
				<div class="mod-head">
					<span class="mod-badge" data-kind={band.kind}>{badge}</span>
					{#if renaming === index}
						{@const invalid = renameIssues.length > 0}
						<!-- No maxlength: it counts UTF-16 units; the limit is checked in code points. -->
						<input
							class="mod-input"
							type="text"
							value={name?.custom ? name.label : ''}
							placeholder={name?.auto}
							aria-label={m.curva_bn_rename_field({ badge })}
							aria-describedby={invalid
								? `${headingId}-rename-issue ${headingId}-rename`
								: `${headingId}-rename`}
							aria-invalid={invalid ? 'true' : undefined}
							title={m.curva_bn_rename_hint_max({ max: LABEL_MAX })}
							oninput={(event) => renameInput(event.currentTarget.value)}
							onkeydown={(event) => renameKey(event, index)}
							onblur={(event) => endRename(index, event.currentTarget.value, false)}
							{@attach selectAll}
						/>
						<span class="mod-issue" id="{headingId}-rename-issue" aria-live="polite"
							>{renameIssues.map((issue) => renameIssueText[issue]()).join(' ')}</span
						>
					{:else}
						<span
							class="mod-name"
							class:custom={name?.custom}
							title={name?.custom ? name.detail : undefined}>{name?.label}</span
						>
					{/if}
					<span class="mod-stage" title={m.curva_bn_stage_title({ index: stage })}
						>{m.curva_v2_stage({ index: stage })}</span
					>
					<!-- Hidden while its field is open: Enter or blur ends the edit with an accepted name
						 (a refused one keeps the field open with its reason), Esc always cancels. -->
					{#if renaming !== index}
						<button
							type="button"
							class="mod-rename"
							data-rename={index}
							aria-label={m.curva_bn_rename({ badge })}
							onclick={() => startRename(index)}
						>
							<svg viewBox="0 0 16 16" aria-hidden="true">
								<path d="M3 13l.8-3.2L10.6 3l2.4 2.4-6.8 6.8z" />
								<path d="M9.2 4.4l2.4 2.4" />
							</svg>
						</button>
					{/if}
					{#if band.kind !== 'OFF' && isExperimentalKind(band.kind)}
						<span class="badge">{m.curva_exp_badge()}</span>
					{/if}
				</div>
				<KindDial
					kind={band.kind}
					{layer}
					disabledReason={kindDisabledReason}
					canApply={(kind) => checkKind(index, kind)}
					resetKey={dialContext}
					focusBoundary={bankElement}
					onkind={(kind) => onkind(index, kind)}
				/>
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
						<!-- Not a <label>: its first labelable child would be the explainer button. -->
						<div class="field">
							<span><Explainer term="q" variant="term">{m.curva_q()}</Explainer></span>
							<input
								type="number"
								aria-label={m.curva_q()}
								min="0.1"
								max="20"
								step="0.01"
								value={q}
								disabled={locked}
								onchange={(event) => oncommit(index, 'qFactor', event.currentTarget)}
							/>
						</div>
					</div>
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
		<p class="soon-note">{m.curva_bn_kind_foot()}</p>
		<button type="button" class="soon-ctl" aria-disabled="true">{m.curva_soon_raw()}</button>
		<span class="soon-badge">{m.curva_soon()}</span>
		<p class="soon-note">{m.curva_soon_note()}</p>
	</div>
</section>

<style>
	.bank {
		position: relative;
		/* Head and strips follow the bank's own width (the @container blocks below). */
		container: filter-bank / inline-size;
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
	/* Stacked by default; title beside the envelope strip from 860 px of bank (see below). */
	.bank-head {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
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
	/* Seven criteria: 2, 4 or 7 per row by the bank's width (each cell keeps 75 px or more). */
	.gaterow {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-2);
		margin: var(--space-2) 0 0;
		padding: 0;
		list-style: none;
	}
	.crit {
		min-width: 0;
		display: grid;
		justify-items: center;
		gap: 3px;
		text-align: center;
	}
	.crit-name,
	.crit-value {
		max-width: 100%;
		overflow-wrap: break-word;
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
	/* No sideways scroll at any width: as many strips of 116 px or more as fit (2 on a 320 px
	   phone, 4 on a tablet), and 5 × 2 from 590 px of bank (desktop from 1101 px: about 119 px
	   each at the narrowest, 185 px at 1440 px). 116 px holds the 92 px kind switch and the
	   88 px fields inside the strip's padding. */
	.modules {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(116px, 1fr));
		gap: var(--space-2);
		margin: var(--space-4) 0 0;
		padding: 0;
		list-style: none;
	}
	@container filter-bank (min-width: 590px) {
		.modules {
			grid-template-columns: repeat(5, minmax(0, 1fr));
		}
	}
	@container filter-bank (min-width: 400px) {
		.gaterow {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
	@container filter-bank (min-width: 600px) {
		.gaterow {
			grid-template-columns: repeat(7, minmax(0, 1fr));
		}
	}
	/* Beside the title the strip still gets 590 px or more (77 px per criterion). */
	@container filter-bank (min-width: 860px) {
		.bank-head {
			grid-template-columns: minmax(220px, 1fr) minmax(0, 2.4fr);
		}
	}
	.module {
		position: relative;
		min-width: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
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
	/* Header: the badge, the stage (shown on hover or focus) and the rename button on top, the
	   name on a full row of its own (16 characters fit at 116 px; a longer label, up to 24, is
	   shortened on screen by the ellipsis of .mod-name; it is stored and read out whole). */
	.mod-head {
		width: 100%;
		min-width: 0;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-areas:
			'badge stage tool'
			'name name name'
			'exp exp exp';
		gap: 3px 4px;
		align-items: center;
		justify-items: center;
	}
	.mod-badge {
		grid-area: badge;
		justify-self: start;
		box-sizing: border-box;
		min-width: 18px;
		height: 18px;
		display: inline-grid;
		place-items: center;
		padding: 0 3px;
		border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
		border-radius: var(--rad-xs);
		background: #0b0b0b;
		color: var(--accent-text);
		font: 600 var(--label-min) / 1 var(--face-data);
	}
	.module.off .mod-badge {
		border-style: dashed;
		border-color: var(--rule-control);
		color: var(--text-2);
	}
	.mod-name {
		grid-area: name;
		max-width: 100%;
		overflow: hidden;
		color: var(--text);
		font: 600 var(--fs-small) / 1.25 var(--face-body);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* The user's own name; its title gives the automatic one. */
	.mod-name.custom {
		font-style: italic;
	}
	.module.off .mod-name {
		color: var(--text-2);
		font-weight: 500;
	}
	.mod-input {
		grid-area: name;
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		min-height: 24px;
		padding: 2px 5px;
		border: 1px solid var(--accent);
		border-radius: var(--rad-xs);
		background: #050505;
		color: var(--text);
		font: 500 var(--fs-caption) / 1.2 var(--face-body);
	}
	.mod-input::placeholder {
		color: var(--muted-hi);
	}
	.mod-input:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: 1px;
	}
	.mod-input[aria-invalid='true'] {
		border-color: var(--warn);
	}
	/* Why the name is refused: under the open field, across the strip, wrapped (never cut). */
	.mod-issue {
		grid-column: 1 / -1;
		max-width: 100%;
		color: var(--warn);
		font: 400 var(--label-min) / 1.25 var(--face-body);
		overflow-wrap: anywhere;
		text-align: center;
	}
	/* Processing order: secondary, so it waits for hover or focus (always on touch screens). */
	.mod-stage {
		grid-area: stage;
		max-width: 100%;
		overflow: hidden;
		color: var(--text-2);
		font: 400 var(--label-min) / 1.1 var(--face-data);
		text-overflow: ellipsis;
		white-space: nowrap;
		opacity: 0;
		transition: opacity var(--dur-fast) var(--ease-out);
	}
	.module:hover .mod-stage,
	.module:focus-within .mod-stage {
		opacity: 1;
	}
	@media (hover: none) {
		.mod-stage {
			opacity: 1;
		}
	}
	.mod-rename {
		grid-area: tool;
		justify-self: end;
		box-sizing: border-box;
		width: 24px;
		height: 24px;
		display: grid;
		place-items: center;
		margin: -3px -3px -3px 0;
		padding: 0;
		border: 1px solid transparent;
		border-radius: var(--rad-xs);
		background: none;
		color: var(--text-2);
		cursor: pointer;
	}
	.mod-rename:hover {
		border-color: var(--rule-control);
		color: var(--text);
	}
	.mod-rename:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: 1px;
	}
	.mod-rename svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.mod-head .badge {
		grid-area: exp;
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
	/* CORTE / REFORÇO wrap onto two lines in a narrow strip instead of pushing it wider. */
	.signs {
		max-width: 100%;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 8px;
		justify-content: center;
	}
	.sign {
		min-width: 0;
		display: inline-flex;
		gap: 4px;
		align-items: center;
		white-space: nowrap;
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
	/* The stage ladder fills the strip and the dB readout sits under it, so neither can push
	   the strip wider than its column (the ladder's LEDs shrink to share the width). */
	.led-row {
		width: 100%;
		min-width: 0;
		display: grid;
		justify-items: center;
		gap: 3px;
		color: var(--text-2);
		font: 400 var(--label-min) / 1 var(--face-data);
		font-variant-numeric: tabular-nums;
	}
	.led-row :global(.oa-leds) {
		display: flex;
		width: 100%;
		min-width: 0;
	}
	.led-row :global(.oa-leds-list) {
		flex: 1 1 auto;
		min-width: 0;
		gap: 1px;
	}
	.led-row :global(.oa-led) {
		flex: 1 1 0;
		min-width: 2px;
		width: auto;
	}
	.led-row small {
		max-width: 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
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
	.tech table {
		max-width: 100%;
	}
	/* A phone-wide bank keeps the table inside it: long values break instead of overflowing. */
	.tech th,
	.tech td {
		padding: 3px 14px 3px 0;
		border-bottom: 1px solid var(--rule);
		overflow-wrap: anywhere;
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
		.kcap,
		.mod-stage {
			transition: none;
		}
	}
	@media (max-width: 720px) {
		.bank {
			padding: var(--space-3);
		}
	}
</style>
