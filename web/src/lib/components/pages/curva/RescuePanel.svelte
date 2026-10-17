<!--
	Rescue and history (mock v2 .guards): Neutro and Padrão Auri are guarded toggle switches under a
	striped cover, engraved with the CRC of the curve they load. They only load the editor (the app's
	`loadNeutral` / `loadAuriDefault`); the lever reads "thrown" while the editor holds that curve
	unedited (real state). "Gravar no cabo" and "Resgatar o cabo" open the layout's pre-write
	checklist through `app.requestWrite()` / `app.requestRescue()` (passed in as callbacks).
	Undo/redo and the unsaved indicator come from the curve store. Every unavailable action says why.
-->
<script lang="ts">
	import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
	import { m } from '#lib/paraglide/messages.js';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import { hex } from './format.ts';

	interface Props {
		unsaved: boolean;
		canUndo: boolean;
		canRedo: boolean;
		journalCount: number;
		disabled?: boolean;
		/** Why every action is unavailable while `disabled` (default: the editor is loading). */
		disabledReason?: string | null;
		writeDisabled?: boolean;
		/** Why writing is unavailable while `writeDisabled` (default: a write is in progress). */
		writeReason?: string | null;
		/** The editor holds Neutro / Padrão Auri unedited (the switch lever reads thrown). */
		neutralActive?: boolean;
		defaultActive?: boolean;
		onneutral: () => void;
		ondefault: () => void;
		onrescue: () => void;
		onundo: () => void;
		onredo: () => void;
		onwrite: () => void;
	}
	let {
		unsaved,
		canUndo,
		canRedo,
		journalCount,
		disabled = false,
		disabledReason = null,
		writeDisabled = false,
		writeReason = null,
		neutralActive = false,
		defaultActive = false,
		onneutral,
		ondefault,
		onrescue,
		onundo,
		onredo,
		onwrite
	}: Props = $props();
	const legendId = $props.id();
	const crc = (value: number) => `0x${hex(value, 4)}`;

	const offReason = $derived(disabled ? (disabledReason ?? m.curva_v2_loading_reason()) : null);
	const cableReason = $derived(
		offReason ?? (writeDisabled ? (writeReason ?? m.curva_v2_writing_reason()) : null)
	);
</script>

<section class="psec ps-res" aria-labelledby={legendId}>
	<div class="guards">
		<Button
			variant="ghost"
			class="guard"
			data-thrown={neutralActive}
			disabledReason={offReason}
			onclick={onneutral}
		>
			<span class="gplate" aria-hidden="true">
				<span class="gbase"></span><span class="glever"></span><span class="gcover"></span>
			</span>
			<span class="gl">{m.curva_rescue_neutral()}</span>
			<span class="gs" aria-hidden="true">{crc(NEUTRO.crc)}</span>
		</Button>
		<Button
			variant="ghost"
			class="guard"
			data-thrown={defaultActive}
			disabledReason={offReason}
			onclick={ondefault}
		>
			<span class="gplate" aria-hidden="true">
				<span class="gbase"></span><span class="glever"></span><span class="gcover"></span>
			</span>
			<span class="gl">{m.curva_rescue_default()}</span>
			<span class="gs" aria-hidden="true">{crc(PADRAO_AURI.crc)}</span>
		</Button>
	</div>
	<div class="res-note">{m.curva_rescue_note()} <Explainer term="neutro" /></div>
	<div class="res-row">
		<Button
			size="sm"
			caps
			disabledReason={offReason ?? (canUndo ? null : m.curva_v2_undo_none())}
			onclick={onundo}>{m.curva_undo()}</Button
		>
		<Button
			size="sm"
			caps
			disabledReason={offReason ?? (canRedo ? null : m.curva_v2_redo_none())}
			onclick={onredo}>{m.curva_redo()}</Button
		>
	</div>
	<p class="dirty" class:on={unsaved} aria-live="polite">
		<span class="led" aria-hidden="true"></span>
		{unsaved ? m.curva_unsaved() : m.curva_saved()}
	</p>
	<div class="res-row">
		<Button
			size="sm"
			caps
			class="acc"
			data-tour="curva-write"
			disabledReason={cableReason}
			onclick={onwrite}>{m.curva_write()}</Button
		>
		<Button size="sm" caps disabledReason={cableReason} onclick={onrescue}
			>{m.curva_rescue_cable()}</Button
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
		display: flex;
		gap: var(--space-2);
		justify-content: space-around;
		margin: 6px 0 8px;
	}
	.ps-res :global(.btn.guard) {
		--btn-bg: transparent;
		--btn-border: transparent;
		--btn-shadow: none;
		flex-direction: column;
		min-height: 0;
		padding: 4px;
	}
	.ps-res :global(.btn.guard .btn__label) {
		flex-direction: column;
		gap: 5px;
	}
	.ps-res :global(.btn.guard:hover:not([aria-disabled='true'])) {
		box-shadow: none;
	}
	.gplate {
		position: relative;
		display: block;
		width: 46px;
		height: 70px;
		border-radius: 5px;
		background: linear-gradient(#2a2a28, #121211);
		box-shadow:
			var(--bevel),
			0 3px 5px rgb(0 0 0 / 0.6);
	}
	.gbase {
		position: absolute;
		top: 27px;
		left: 13px;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: radial-gradient(circle, #cfcac0 0 4px, #6c6962 5px, #1b1a19 9px);
	}
	.glever {
		position: absolute;
		top: 12px;
		left: 19px;
		width: 8px;
		height: 22px;
		border-radius: 4px;
		background: linear-gradient(90deg, #8a867e, #f4f0e7 45%, #a19c93);
		box-shadow: 0 2px 2px rgb(0 0 0 / 0.6);
		transition: top var(--dur-base) var(--ease-mech);
	}
	.ps-res :global(.guard[data-thrown='true'] .glever) {
		top: 34px;
	}
	/* The striped safety cover lifts while the switch is pointed at or focused. */
	.gcover {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 40px;
		height: 64px;
		border: 1px solid #000;
		border-radius: 5px 5px 4px 4px;
		background: repeating-linear-gradient(
			135deg,
			rgb(236 231 221 / 0.75) 0 4px,
			rgb(20 20 19 / 0.75) 4px 8px
		);
		box-shadow: 0 4px 6px rgb(0 0 0 / 0.5);
		transform-origin: 50% 0;
		transition: transform var(--dur-slow) var(--ease-mech);
	}
	.ps-res :global(.guard:not([aria-disabled='true']):hover .gcover),
	.ps-res :global(.guard:focus-visible .gcover) {
		transform: perspective(220px) rotateX(78deg);
	}
	.gl {
		color: var(--text);
		font: 600 var(--fs-caption) / 1 var(--face-engrave);
		letter-spacing: 0.18em;
		text-transform: uppercase;
	}
	.gs {
		color: var(--text-2);
		font: 400 var(--label-min) / 1 var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.res-note,
	.journal {
		margin: 8px 0 0;
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.journal {
		font-family: var(--face-data);
		font-size: var(--label-min);
	}
	.res-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}
	.ps-res :global(.btn.acc:not([aria-disabled='true'])) {
		--btn-border: color-mix(in srgb, var(--accent) 55%, transparent);
		--btn-fg: var(--accent-text);
	}
	.dirty {
		display: flex;
		gap: 6px;
		align-items: center;
		margin: 8px 0 0;
		color: var(--text);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.led {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--lamp-off);
	}
	.dirty.on .led {
		background: var(--accent);
		box-shadow: 0 0 6px var(--accent);
	}
	@media (prefers-reduced-motion: reduce) {
		.glever,
		.gcover {
			transition: none;
		}
	}
</style>
