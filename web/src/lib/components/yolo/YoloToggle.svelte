<!--
	Modo YOLO switch. Mounted with the Curva layer selector (LayerSelector's slot), where the user
	picks how to edit; it shows on every layer:
	- Ouvir and Ajustar: unavailable, and it says why (aria-disabled, still focusable, the reason
	  is its visible description).
	- Engenharia, off: a quiet hazard plate (striped edge, warning glyph, OFF readout). Pressing it
	  opens the consent dialog: the four warning sections and the typed phrase ASSUMO O RISCO
	  (NFKC, trim, uppercase); "Turn on" stays unavailable until the phrase matches, and the
	  validation is announced as you type. Cancel has the initial focus; Escape cancels.
	- On: the plate lights up (ON readout); one press turns YOLO off. Below it: the "Prévia sem
	  limites" sub-switch (codec-only preview behind the limiter; writing disabled while it is on),
	  the reason writing is disabled, and "Trazer para o modo normal" when the page passes it.
	Semantics live in lib/state/yolo.svelte.ts (memory only, Engenharia only); this is the UI.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import Button from '#lib/components/primitives/Button.svelte';
	import {
		isYoloPhrase,
		normalizeYoloPhrase,
		YOLO_LAYER,
		YOLO_PHRASE,
		type YoloState
	} from '#lib/state/yolo.svelte.ts';
	import YoloDialog from './YoloDialog.svelte';
	import YoloGlyph from './YoloGlyph.svelte';

	interface Props {
		yolo: YoloState;
		/** Current editor layer; the switch works only in Engenharia. */
		layer: string;
		/** "Trazer para o modo normal": shown while YOLO is on when given. */
		onbringback?: () => void;
		/** Why a YOLO write is disabled right now (the free preview), shown while YOLO is on. */
		writeReason?: string | null;
	}

	let { yolo, layer, onbringback, writeReason = null }: Props = $props();

	const id = $props.id();
	const locked = $derived(layer !== YOLO_LAYER);
	const mode = $derived(locked ? 'locked' : yolo.enabled ? 'on' : 'off');
	let consentOpen = $state(false);
	let phrase = $state('');

	// Leaving Engenharia (the state turns YOLO off there) also drops a consent in progress.
	$effect(() => {
		if (locked && consentOpen) closeConsent();
	});

	/** Live validation of the typed phrase (the same normalization `enable` applies). */
	const typed = $derived(normalizeYoloPhrase(phrase));
	const matches = $derived(isYoloPhrase(phrase));
	const phraseState = $derived(
		typed === ''
			? 'empty'
			: matches
				? 'ok'
				: YOLO_PHRASE.startsWith(typed)
					? 'partial'
					: 'mismatch'
	);
	const phraseStatus = $derived(
		phraseState === 'ok'
			? m.yolo_phrase_status_ok()
			: phraseState === 'partial'
				? m.yolo_phrase_status_partial()
				: phraseState === 'mismatch'
					? m.yolo_phrase_mismatch()
					: m.yolo_phrase_status_empty()
	);
	const hint = $derived(
		locked ? m.yolo_toggle_locked() : yolo.enabled ? m.yolo_toggle_on_hint() : m.yolo_toggle_hint()
	);

	function onSwitch() {
		// Unavailable outside Engenharia: the visible reason (aria-describedby) says why.
		if (locked) return;
		if (yolo.enabled) {
			yolo.disable();
			return;
		}
		phrase = '';
		consentOpen = true;
	}

	function closeConsent() {
		phrase = '';
		consentOpen = false;
	}

	function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		if (!matches) return;
		if (yolo.enable(phrase, layer)) closeConsent();
	}
</script>

<div class="yt" data-state={mode} data-yolo-toggle>
	<button
		type="button"
		role="switch"
		class="yt-switch"
		aria-checked={yolo.enabled}
		aria-disabled={locked ? 'true' : undefined}
		aria-describedby="{id}-hint"
		onclick={onSwitch}
		data-yolo-switch
	>
		<span class="yt-stripe" aria-hidden="true"></span>
		<YoloGlyph class="yt-glyph" />
		<span class="yt-name">{m.yolo_toggle()}</span>
		<span class="yt-lcd" aria-hidden="true">
			{yolo.enabled ? m.yolo_toggle_state_on() : m.yolo_toggle_state_off()}
		</span>
	</button>
	<p class="yt-hint" id="{id}-hint">{hint}</p>

	{#if yolo.enabled}
		<div class="yt-on">
			<label class="yt-sub">
				<input
					type="checkbox"
					checked={yolo.freePreview}
					aria-describedby="{id}-preview"
					onchange={(event) => yolo.setFreePreview(event.currentTarget.checked)}
					data-yolo-free-preview
				/>
				<span>{m.yolo_free_preview()}</span>
			</label>
			<p class="yt-hint" id="{id}-preview">{m.yolo_free_preview_hint()}</p>
			{#if writeReason}
				<p class="yt-why" role="status">{writeReason}</p>
			{/if}
			{#if onbringback}
				<button type="button" class="yt-back" onclick={onbringback} data-yolo-bring-back>
					{m.yolo_bring_back()}
				</button>
			{/if}
		</div>
	{/if}
</div>

{#if consentOpen && !locked}
	<YoloDialog
		title={m.yolo_dialog_title()}
		ondismiss={closeConsent}
		initialFocus="[data-yolo-cancel]"
		onsubmit={onSubmit}
	>
		<div class="yc-phrase" data-tone={phraseState}>
			<label class="yc-label" for="{id}-phrase">{m.yolo_phrase_label()}</label>
			<p class="yc-plate" aria-hidden="true">{YOLO_PHRASE}</p>
			<p class="yc-note" id="{id}-note">{m.yolo_phrase_note()}</p>
			<input
				id="{id}-phrase"
				class="yc-input"
				type="text"
				autocomplete="off"
				autocapitalize="characters"
				spellcheck="false"
				bind:value={phrase}
				aria-describedby="{id}-status {id}-note"
				aria-invalid={phraseState === 'mismatch' ? 'true' : undefined}
				data-yolo-phrase
			/>
			<p class="yc-status" id="{id}-status" aria-live="polite" data-yolo-phrase-status>
				<span class="yc-dot" aria-hidden="true"></span>{phraseStatus}
			</p>
		</div>
		{#snippet actions()}
			<Button variant="plate" data-yolo-cancel onclick={closeConsent}>{m.yolo_cancel()}</Button>
			<Button
				type="submit"
				variant="danger"
				disabledReason={matches ? null : m.yolo_enable_locked()}
				data-yolo-enable
			>
				{m.yolo_enable()}
			</Button>
		{/snippet}
	</YoloDialog>
{/if}

<style>
	.yt {
		display: grid;
		gap: 6px;
		max-width: 300px;
		margin-top: var(--space-1);
	}
	/* The plate: the rack's machined button (.btn-pl) with a hazard edge. Quiet while off. */
	.yt-switch {
		position: relative;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-2);
		box-sizing: border-box;
		width: 100%;
		min-height: var(--hit);
		padding: 0 var(--space-2) 0 18px;
		overflow: hidden;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		background: linear-gradient(#262725, #141514);
		box-shadow:
			var(--bevel),
			0 2px 3px rgb(0 0 0 / 0.6);
		color: var(--text);
		font: 600 var(--fs-caption) / 1 var(--face-engrave);
		letter-spacing: var(--tracking-caps);
		text-align: left;
		text-transform: uppercase;
		cursor: pointer;
		transition:
			border-color var(--dur-fast) var(--ease-out),
			box-shadow var(--dur-fast) var(--ease-out),
			transform var(--dur-instant) var(--ease-mech);
	}
	.yt-switch:hover:not([aria-disabled='true']) {
		border-color: color-mix(in srgb, var(--warn) 70%, transparent);
	}
	.yt-switch:active:not([aria-disabled='true']) {
		transform: translateY(1px);
		box-shadow: var(--well);
	}
	.yt-switch:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.yt-stripe {
		position: absolute;
		inset: 0 auto 0 0;
		width: 8px;
		background: repeating-linear-gradient(-45deg, #e5a23a 0 4px, #141210 4px 8px);
		opacity: 0.6;
		transition:
			opacity var(--dur-fast) var(--ease-out),
			width var(--dur-base) var(--ease-out);
	}
	.yt-switch:hover:not([aria-disabled='true']) .yt-stripe {
		opacity: 1;
	}
	.yt-switch :global(.yt-glyph) {
		color: color-mix(in srgb, var(--warn) 75%, var(--text-2));
		font-size: 15px;
	}
	.yt-name {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	/* LCD readout (the rack's .lcd): the real state, never decorative. */
	.yt-lcd {
		min-width: 4.5em;
		padding: 4px 6px;
		border-radius: var(--rad-xs);
		background: #050505;
		box-shadow: var(--well);
		color: var(--muted-hi);
		font: 500 var(--label-min) / 1 var(--face-data);
		letter-spacing: var(--tracking-data);
		text-align: center;
	}
	/* On: the plate lights up red, the full hazard edge and a lit readout. */
	.yt[data-state='on'] .yt-switch {
		border-color: var(--danger);
		background: linear-gradient(#4a1013, #2a0709);
		box-shadow:
			var(--bevel),
			0 0 0 1px color-mix(in srgb, var(--danger) 45%, transparent),
			0 0 16px color-mix(in srgb, var(--danger) 35%, transparent);
	}
	.yt[data-state='on'] .yt-stripe {
		width: 12px;
		opacity: 1;
	}
	.yt[data-state='on'] :global(.yt-glyph) {
		color: var(--warn);
	}
	.yt[data-state='on'] .yt-lcd {
		color: #ff7b7f;
		text-shadow: 0 0 6px rgb(229 72 77 / 0.7);
	}
	/* Unavailable (not Engenharia): unlit face, grey edge, the reason below. */
	.yt[data-state='locked'] .yt-switch {
		background: var(--lamp-off);
		box-shadow: none;
		color: var(--muted-hi);
		cursor: not-allowed;
	}
	.yt[data-state='locked'] .yt-stripe {
		opacity: 0.3;
		filter: grayscale(1);
	}
	.yt[data-state='locked'] :global(.yt-glyph) {
		color: var(--muted-hi);
	}
	.yt-hint {
		margin: 0;
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.yt-on {
		display: grid;
		gap: 6px;
		justify-items: start;
		padding: var(--space-2) 0 0 var(--space-3);
		border-left: 2px solid color-mix(in srgb, var(--danger) 55%, transparent);
	}
	.yt-sub {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 28px;
		color: var(--text);
		font: 500 var(--fs-small) / var(--lh-ui) var(--face-body);
		cursor: pointer;
	}
	.yt-sub input {
		width: 16px;
		height: 16px;
		margin: 0;
		accent-color: var(--warn);
	}
	.yt-why {
		margin: 0;
		color: color-mix(in srgb, var(--danger) 70%, white);
		font: 500 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.yt-back {
		min-height: 32px;
		padding: 4px 12px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		background: linear-gradient(#262725, #141514);
		box-shadow: var(--bevel);
		color: var(--text);
		font: 500 var(--fs-caption) / 1.2 var(--face-body);
		cursor: pointer;
	}
	.yt-back:hover {
		border-color: color-mix(in srgb, var(--text) 62%, transparent);
	}
	.yt-back:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}

	/* Consent dialog: the typed-phrase block (rendered inside YoloDialog, styled here). */
	.yc-phrase {
		--tone: var(--text-2);
		display: grid;
		gap: var(--space-2);
		padding: var(--space-4);
		border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
		border-radius: var(--rad-md);
		background: color-mix(in srgb, var(--warn) 6%, var(--ink-2));
	}
	.yc-phrase[data-tone='ok'] {
		--tone: var(--ok);
	}
	.yc-phrase[data-tone='mismatch'] {
		--tone: color-mix(in srgb, var(--danger) 70%, white);
	}
	.yc-label {
		color: var(--text);
		font: 600 var(--fs-ui) / var(--lh-ui) var(--face-body);
	}
	.yc-plate {
		justify-self: start;
		margin: 0;
		padding: 6px 10px;
		border-radius: var(--rad-xs);
		background: #050505;
		box-shadow: var(--well);
		color: var(--warn);
		font: 500 var(--fs-readout) / var(--lh-readout) var(--face-data);
		letter-spacing: 0.12em;
		text-shadow: 0 0 6px rgb(229 162 58 / 0.55);
	}
	.yc-note {
		margin: 0;
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	/* 16 px: no zoom on focus in mobile Safari. */
	.yc-input {
		box-sizing: border-box;
		width: 100%;
		min-height: var(--hit);
		padding: 6px 10px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		background: var(--ink);
		color: var(--text);
		font: 500 16px / 1.3 var(--face-data);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.yc-phrase[data-tone='ok'] .yc-input,
	.yc-phrase[data-tone='mismatch'] .yc-input {
		border-color: var(--tone);
	}
	.yc-input:focus-visible {
		outline: var(--focus-width) solid var(--warn);
		outline-offset: 1px;
	}
	.yc-status {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		margin: 0;
		color: var(--tone);
		font: 500 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.yc-dot {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
		transform: translateY(-1px);
	}
	@media (prefers-reduced-motion: reduce) {
		.yt-switch,
		.yt-stripe {
			transition: none;
		}
	}
	@media (max-width: 720px) {
		.yt {
			max-width: none;
		}
	}
</style>
