<!--
	Modular cabinet (Engenharia): PREAMP, S1…S10 in written order, OUTPUT, joined by patch cords.
	Dragging a module (or Alt + ←/→, or the move buttons) asks the page to reorder; the page runs
	the gate on the real order and a refusal springs the module back with the reason.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { isExperimentalKind } from 'open-auri/safety';
	import { m } from '#lib/paraglide/messages.js';
	import { formatHz, formatSignedDb } from './format.ts';
	import { hasGain, type Band, type Curve } from './model.ts';

	interface Props {
		curve: Curve;
		locale: string;
		selected: number;
		/** Index that was just refused (springs back), or null. */
		refused?: number | null;
		message?: string | null;
		onselect: (index: number) => void;
		onreorder: (from: number, to: number) => void;
	}
	let {
		curve,
		locale,
		selected,
		refused = null,
		message = null,
		onselect,
		onreorder
	}: Props = $props();

	const headingId = $props.id();
	let dragFrom = $state<number | null>(null);
	let over = $state<number | null>(null);
	const buttons = $state<HTMLButtonElement[]>([]);

	function describe(band: Band): string {
		if (band.kind === 'OFF') return m.curva_kind_off();
		const gain = hasGain(band) ? ` ${formatSignedDb(band.gainDb, locale)}` : '';
		return `${band.kind} ${formatHz(band.freqHz, locale)}${gain}`;
	}
	function move(from: number, to: number) {
		if (to < 0 || to >= curve.bands.length || from === to) return;
		onreorder(from, to);
		// Focus follows the selected module (the page selects `to` when the gate accepts).
		void tick().then(() => buttons[selected]?.focus());
	}
	function onkeydown(event: KeyboardEvent, index: number) {
		if (!event.altKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
		event.preventDefault();
		move(index, index + (event.key === 'ArrowRight' ? 1 : -1));
	}
	function ondrop(event: DragEvent, index: number) {
		event.preventDefault();
		const from = dragFrom ?? Number(event.dataTransfer?.getData('text/plain'));
		dragFrom = null;
		over = null;
		if (Number.isInteger(from)) move(from, index);
	}
</script>

<section class="cab" aria-labelledby={headingId}>
	<header class="cab-head">
		<div>
			<h2 id={headingId}>{m.curva_cab_heading()}</h2>
			<p>{m.curva_cab_sub()}</p>
		</div>
		<span class="keyhint" id="{headingId}-hint">{m.curva_move_hint()}</span>
	</header>
	{#if message}
		<p class="cab-msg" role="status">{message}</p>
	{/if}
	<div class="rack">
		<div class="jackmod fixed" aria-hidden="true">
			<span class="jt">{m.curva_module_preamp()}</span>
			<small>{formatSignedDb(curve.preampDb, locale)}</small>
		</div>
		<ol class="modules">
			{#each curve.bands as band, index (index)}
				<!-- Pointer drag-and-drop is an enhancement: the module button (Alt + arrows) and the
					move buttons below are the keyboard/screen-reader path to the same reorder. -->
				<li
					class="cmod"
					class:selected={selected === index}
					class:over={over === index}
					class:spring={refused === index}
					class:exp={band.kind !== 'OFF' && isExperimentalKind(band.kind)}
					draggable="true"
					ondragstart={(event) => {
						dragFrom = index;
						event.dataTransfer?.setData('text/plain', String(index));
					}}
					ondragend={() => {
						dragFrom = null;
						over = null;
					}}
					ondragover={(event) => {
						event.preventDefault();
						over = index;
					}}
					ondragleave={() => (over = over === index ? null : over)}
					ondrop={(event) => ondrop(event, index)}
				>
					<span class="cord" aria-hidden="true"></span>
					<button
						bind:this={buttons[index]}
						type="button"
						class="cmod-main"
						aria-pressed={selected === index}
						aria-describedby="{headingId}-hint"
						onclick={() => onselect(index)}
						onkeydown={(event) => onkeydown(event, index)}
					>
						<!-- The visible text is the accessible name (WCAG 2.5.3): "Filtro 1 PK 1 kHz −6,0 dB". -->
						<span class="jt">{m.curva_filter({ index: String(index + 1) })}</span>
						<small>{describe(band)}</small>
					</button>
					<span class="moves">
						<button
							type="button"
							class="mv"
							disabled={index === 0}
							aria-label={m.curva_v2_move_left({ index: String(index + 1) })}
							onclick={() => move(index, index - 1)}>←</button
						>
						<button
							type="button"
							class="mv"
							disabled={index === curve.bands.length - 1}
							aria-label={m.curva_v2_move_right({ index: String(index + 1) })}
							onclick={() => move(index, index + 1)}>→</button
						>
					</span>
				</li>
			{/each}
		</ol>
		<div class="jackmod fixed" aria-hidden="true">
			<span class="jt">{m.curva_module_output()}</span>
			<small>DAC</small>
		</div>
	</div>
	<div class="soon-mods">
		<button type="button" class="soon-ctl" aria-disabled="true">{m.curva_soon_read()}</button>
		<button type="button" class="soon-ctl" aria-disabled="true">{m.curva_soon_ram()}</button>
		<button type="button" class="soon-ctl" aria-disabled="true">{m.curva_soon_blind()}</button>
		<span class="soon-badge">{m.curva_soon()}</span>
		<p class="soon-note">{m.curva_soon_note()}</p>
	</div>
</section>

<style>
	.cab {
		content-visibility: auto;
		contain-intrinsic-size: auto 300px;
		padding: 16px;
		border-radius: 6px;
		background: linear-gradient(#2e2d2b, #1f1e1c);
		color: var(--curva-silk, #e9e3d4);
	}
	.cab-head {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 16px;
		align-items: end;
		justify-content: space-between;
	}
	.cab-head h2 {
		margin: 0;
		font: 400 26px/1.1 var(--font-display, 'Instrument Serif', serif);
	}
	.cab-head p,
	.keyhint {
		margin: 2px 0 0;
		font-size: 12px;
		color: var(--curva-silk-2, #c9c1ae);
	}
	.cab-msg {
		margin: 8px 0 0;
		padding: 4px 8px;
		border-left: 3px solid var(--accent, #ff7a2f);
		font-size: 12px;
	}
	.rack {
		display: flex;
		gap: 6px;
		align-items: stretch;
		margin-top: 12px;
		overflow-x: auto;
		padding-bottom: 6px;
	}
	.modules {
		display: flex;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.jackmod,
	.cmod {
		position: relative;
		display: grid;
		gap: 4px;
		min-width: 84px;
		padding: 8px 6px;
		border: 1px solid rgb(238 233 222 / 0.18);
		border-radius: 4px;
		background: linear-gradient(#262523, #191817);
	}
	.jackmod {
		align-content: center;
		justify-items: center;
		font-size: 11px;
	}
	.cmod {
		cursor: grab;
		transition: transform 200ms ease;
	}
	.cmod.selected {
		border-color: var(--accent, #ff7a2f);
	}
	.cmod.over {
		transform: translateY(-4px);
		border-style: dashed;
	}
	.cmod.exp small {
		color: var(--accent, #ff7a2f);
	}
	.cmod.spring {
		animation: spring 420ms cubic-bezier(0.3, 1.6, 0.5, 1);
	}
	@keyframes spring {
		0% {
			transform: translateY(-14px);
		}
		100% {
			transform: none;
		}
	}
	.cord {
		position: absolute;
		top: 50%;
		left: -7px;
		width: 8px;
		height: 3px;
		border-radius: 2px;
		background: var(--accent, #ff7a2f);
	}
	.cmod-main {
		display: grid;
		gap: 2px;
		padding: 2px;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}
	.jt {
		font: 600 11px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
	}
	.cmod small {
		font: 600 12px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		color: var(--curva-silk-2, #c9c1ae);
	}
	.moves {
		display: flex;
		gap: 2px;
	}
	.mv {
		flex: 1;
		min-height: 24px;
		border: 1px solid rgb(238 233 222 / 0.2);
		border-radius: 2px;
		background: #1a1918;
		color: inherit;
		cursor: pointer;
	}
	.mv:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	button:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 2px;
	}
	.soon-mods {
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
	.soon-badge {
		padding: 1px 5px;
		border: 1px solid var(--accent, #ff7a2f);
		border-radius: 2px;
		color: var(--accent, #ff7a2f);
		font: 600 9px/1.3 var(--font-mono, 'JetBrains Mono', monospace);
	}
	.soon-note {
		flex: 1 1 100%;
		margin: 0;
		font-size: 11px;
		color: var(--curva-silk-2, #c9c1ae);
	}
	@media (prefers-reduced-motion: reduce) {
		.cmod {
			transition: none;
		}
		.cmod.spring {
			animation: none;
			outline: 2px dashed var(--accent, #ff7a2f);
		}
	}
</style>
