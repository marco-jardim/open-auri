<!--
	Rescue and history: Neutro / Padrão Auri load the editor only; "rescue the cable" and "write"
	open the layout's pre-write checklist through `app.requestRescue()` / `app.requestWrite()`
	(passed in as callbacks). Undo/redo and the unsaved indicator come from the curve store.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';

	interface Props {
		dirty: boolean;
		canUndo: boolean;
		canRedo: boolean;
		journalCount: number;
		disabled?: boolean;
		writeDisabled?: boolean;
		onneutral: () => void;
		ondefault: () => void;
		onrescue: () => void;
		onundo: () => void;
		onredo: () => void;
		onwrite: () => void;
	}
	let {
		dirty,
		canUndo,
		canRedo,
		journalCount,
		disabled = false,
		writeDisabled = false,
		onneutral,
		ondefault,
		onrescue,
		onundo,
		onredo,
		onwrite
	}: Props = $props();
	const legendId = $props.id();
</script>

<section class="psec ps-res" aria-labelledby={legendId}>
	<div class="guards">
		<button type="button" class="guard" {disabled} onclick={onneutral}>
			<span class="gplate" aria-hidden="true"></span>
			{m.curva_rescue_neutral()}
		</button>
		<button type="button" class="guard" {disabled} onclick={ondefault}>
			<span class="gplate" aria-hidden="true"></span>
			{m.curva_rescue_default()}
		</button>
	</div>
	<p class="res-note">{m.curva_rescue_note()}</p>
	<div class="res-row">
		<button type="button" class="btn-pl" disabled={disabled || !canUndo} onclick={onundo}
			>{m.curva_undo()}</button
		>
		<button type="button" class="btn-pl" disabled={disabled || !canRedo} onclick={onredo}
			>{m.curva_redo()}</button
		>
	</div>
	<p class="dirty" class:on={dirty} aria-live="polite">
		<span class="led" aria-hidden="true"></span>
		{dirty ? m.curva_unsaved() : m.curva_saved()}
	</p>
	<div class="res-row">
		<button type="button" class="btn-pl acc" disabled={disabled || writeDisabled} onclick={onwrite}
			>{m.curva_write()}</button
		>
		<button type="button" class="btn-pl" disabled={disabled || writeDisabled} onclick={onrescue}
			>{m.curva_rescue_cable()}</button
		>
	</div>
	<p class="journal">
		{journalCount === 0
			? m.curva_journal_none()
			: m.curva_journal_count({ count: String(journalCount) })}
	</p>
	<h2 class="legend-bar" id={legendId}>{m.curva_rescue_heading()}</h2>
</section>

<style>
	.guards {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.guard {
		display: grid;
		justify-items: center;
		gap: 4px;
		min-height: 64px;
		padding: 6px;
		border: 1px solid rgb(238 233 222 / 0.22);
		border-radius: 4px;
		background: linear-gradient(#2c2b29, #1d1c1b);
		color: var(--curva-silk, #e9e3d4);
		font: 600 11px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
		cursor: pointer;
	}
	.gplate {
		width: 26px;
		height: 30px;
		border-radius: 3px;
		background: linear-gradient(#b8382a, #7a1e14);
		box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.25);
	}
	.res-note,
	.journal {
		margin: 8px 0 0;
		font-size: 11px;
		color: var(--curva-silk-2, #c9c1ae);
	}
	.res-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}
	.dirty {
		display: flex;
		gap: 6px;
		align-items: center;
		margin: 8px 0 0;
		font-size: 12px;
		color: var(--curva-silk, #e9e3d4);
	}
	.led {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #444;
	}
	.dirty.on .led {
		background: var(--accent, #ff7a2f);
		box-shadow: 0 0 6px var(--accent, #ff7a2f);
	}
</style>
