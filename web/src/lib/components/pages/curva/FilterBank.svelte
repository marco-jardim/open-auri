<!--
	Filter bank (Ajustar and Engenharia): 10 modules in written order. Typed values go through the
	same gate-bounded move as the handles (stop at the boundary, round, revalidate). Kinds offered
	follow the core LAYER_KINDS; HS/LP/HP are locked with a hint outside Engenharia and carry an
	EXPERIMENTAL badge inside it. Each module has a stage LED: live PPM after that section while the
	preview plays, otherwise the prefix peak from the gate metrics (DATA).
-->
<script lang="ts">
	import { LedLadder, MeterModeLabel } from '#lib/components/meters/index.ts';
	import type { MeterFrame, MeterMode } from '#lib/audio/meters.ts';

	/** A LiveMeter, or an idle stand-in (DATA mode) before the preview exists. */
	interface StageMeter {
		readonly mode: MeterMode;
		readonly frame: MeterFrame | null;
	}
	import { m } from '#lib/paraglide/messages.js';
	import { formatSignedDb } from './format.ts';
	import { isLockedKind, kindsForLayer, type Layer } from './layers.ts';
	import { bandValue, hasGain, type BandKind, type Curve, type DragParam } from './model.ts';
	import type { GateVerdict } from './reasons.ts';
	import type { DragTarget } from './drag.ts';
	import { isExperimentalKind } from 'open-auri/safety';

	interface Props {
		curve: Curve;
		verdict: GateVerdict;
		layer: Layer;
		locale: string;
		stages: readonly StageMeter[];
		message?: string | null;
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
		onmove,
		onkind,
		onorder
	}: Props = $props();

	const headingId = $props.id();
	const options = $derived(['OFF', ...kindsForLayer(layer).filter((kind) => kind !== 'OFF')]);
	const stageMode = $derived(stages.some((stage) => stage.mode === 'live') ? 'live' : 'data');

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
</script>

<section class="bank" aria-labelledby={headingId}>
	<header class="bank-head">
		<div>
			<h2 id={headingId}>{m.curva_bank_heading()}</h2>
			<p>{m.curva_bank_sub()}</p>
		</div>
		<button type="button" class="btn-pl" onclick={onorder}>{m.curva_order_reset()}</button>
		<MeterModeLabel mode={stageMode} />
	</header>
	{#if message}
		<p class="bank-msg" role="status">{message}</p>
	{/if}
	<ol class="modules">
		{#each curve.bands as band, index (index)}
			{@const locked = band.kind !== 'OFF' && isLockedKind(band.kind, layer)}
			{@const off = band.kind === 'OFF'}
			<li class="module" class:off class:locked>
				<div class="mod-head">
					<span class="mod-n">{m.curva_filter({ index: String(index + 1) })}</span>
					{#if band.kind !== 'OFF' && isExperimentalKind(band.kind)}
						<span class="badge">{m.curva_exp_badge()}</span>
					{/if}
				</div>
				<label class="field">
					<span>{m.curva_kind()}</span>
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
				{#if band.kind !== 'OFF'}
					<label class="field">
						<span>{m.curva_freq()} (Hz)</span>
						<input
							type="number"
							min="20"
							max="20000"
							step="1"
							value={band.freqHz}
							disabled={locked}
							onchange={(event) => oncommit(index, 'freqHz', event.currentTarget)}
						/>
					</label>
					{#if hasGain(band)}
						<label class="field">
							<span>{m.curva_gain()} (dB)</span>
							<input
								type="number"
								min="-24"
								max="9.2"
								step="0.1"
								value={band.gainDb}
								disabled={locked}
								onchange={(event) => oncommit(index, 'gainDb', event.currentTarget)}
							/>
						</label>
					{/if}
					<label class="field">
						<span>{m.curva_q()}</span>
						<input
							type="number"
							min="0.1"
							max="20"
							step="0.01"
							value={band.qFactor}
							disabled={locked}
							onchange={(event) => oncommit(index, 'qFactor', event.currentTarget)}
						/>
					</label>
					{#if locked}
						<p class="hint">{m.curva_exp_hint()}</p>
					{/if}
				{/if}
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
	<div class="bank-foot">
		<button type="button" class="soon-ctl" aria-disabled="true">{m.curva_soon_raw()}</button>
		<span class="soon-badge">{m.curva_soon()}</span>
		<p class="soon-note">{m.curva_soon_note()}</p>
	</div>
</section>

<style>
	.bank {
		padding: 16px;
		border-radius: 6px;
		background: linear-gradient(#2e2d2b, #1f1e1c);
		color: var(--curva-silk, #e9e3d4);
	}
	.bank-head {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 16px;
		align-items: center;
		justify-content: space-between;
	}
	.bank-head h2 {
		margin: 0;
		font: 400 26px/1.1 var(--font-display, 'Instrument Serif', serif);
	}
	.bank-head p {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--curva-silk-2, #c9c1ae);
	}
	.bank-msg,
	.hint {
		margin: 8px 0 0;
		padding: 4px 8px;
		border-left: 3px solid var(--accent, #ff7a2f);
		font-size: 12px;
	}
	.modules {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 8px;
		margin: 12px 0 0;
		padding: 0;
		list-style: none;
	}
	.module {
		display: grid;
		align-content: start;
		gap: 6px;
		padding: 8px;
		border: 1px solid rgb(238 233 222 / 0.15);
		border-radius: 4px;
		background: linear-gradient(#262523, #191817);
	}
	.module.off {
		opacity: 0.8;
	}
	.module.locked {
		border-style: dashed;
	}
	.mod-head {
		display: flex;
		gap: 6px;
		align-items: center;
		justify-content: space-between;
	}
	.mod-n {
		font: 600 11px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.badge,
	.soon-badge {
		padding: 1px 5px;
		border: 1px solid var(--accent, #ff7a2f);
		border-radius: 2px;
		color: var(--accent, #ff7a2f);
		font: 600 9px/1.3 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
	}
	.field {
		display: grid;
		gap: 2px;
		font-size: 11px;
		color: var(--curva-silk-2, #c9c1ae);
	}
	.field select,
	.field input {
		min-height: 28px;
		padding: 2px 6px;
		border: 1px solid rgb(238 233 222 / 0.25);
		border-radius: 2px;
		background: #0d1310;
		color: #b6edb0;
		font: 12px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
	}
	.field select:focus-visible,
	.field input:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 1px;
	}
	.field :disabled {
		opacity: 0.6;
	}
	.led-row {
		display: flex;
		gap: 6px;
		align-items: center;
		font: 10px var(--font-mono, 'JetBrains Mono', monospace);
	}
	.bank-foot {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		margin-top: 12px;
	}
	.soon-ctl {
		padding: 4px 8px;
		border: 1px dashed rgb(238 233 222 / 0.3);
		background: transparent;
		color: var(--curva-silk-2, #c9c1ae);
		cursor: not-allowed;
	}
	.soon-note {
		flex: 1 1 100%;
		margin: 0;
		font-size: 11px;
		color: var(--curva-silk-2, #c9c1ae);
	}
	@media (max-width: 1100px) {
		.modules {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 420px) {
		.modules {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
