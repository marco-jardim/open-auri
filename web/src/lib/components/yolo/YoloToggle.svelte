<!--
	Modo YOLO toggle (Curva, Engenharia layer only). Turning it on opens a modal with the full
	warning and the typed phrase ASSUMO O RISCO (NFKC, trim, uppercase); nothing else turns it on.
	While on: "Desligar", and the "Prévia sem limites" sub-toggle (codec-only preview behind the
	limiter; writing disabled while it is on). Memory only: see lib/state/yolo.svelte.ts.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { isYoloPhrase, YOLO_LAYER, type YoloState } from '#lib/state/yolo.svelte.ts';

	interface Props {
		yolo: YoloState;
		/** Current editor layer; the toggle exists only in Engenharia. */
		layer: string;
	}

	let { yolo, layer }: Props = $props();

	const id = $props.id();
	let dialog = $state<HTMLDialogElement>();
	let phrase = $state('');
	let tried = $state(false);
	const matches = $derived(isYoloPhrase(phrase));

	function openDialog() {
		phrase = '';
		tried = false;
		dialog?.showModal();
	}

	function closeDialog() {
		phrase = '';
		dialog?.close();
	}

	function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		tried = true;
		if (yolo.enable(phrase, layer)) closeDialog();
	}
</script>

{#if layer === YOLO_LAYER}
	<div class="yolo-toggle" data-yolo-toggle>
		{#if yolo.enabled}
			<span class="on">{m.yolo_toggle()}</span>
			<label class="sub">
				<input
					type="checkbox"
					checked={yolo.freePreview}
					onchange={(event) => yolo.setFreePreview(event.currentTarget.checked)}
					data-yolo-free-preview
				/>
				<span>{m.yolo_free_preview()}</span>
			</label>
			<p class="hint">{m.yolo_free_preview_hint()}</p>
			<button type="button" class="off" onclick={() => yolo.disable()}>{m.yolo_off()}</button>
		{:else}
			<button
				type="button"
				class="arm"
				aria-haspopup="dialog"
				onclick={openDialog}
				data-yolo-open>{m.yolo_toggle()}</button
			>
			<p class="hint">{m.yolo_toggle_hint()}</p>
		{/if}
	</div>

	<dialog bind:this={dialog} class="yolo-dialog" aria-labelledby={`${id}-title`}>
		<form method="dialog" onsubmit={onSubmit}>
			<h2 id={`${id}-title`}>{m.yolo_dialog_title()}</h2>
			<p class="warning" id={`${id}-warning`}>{m.yolo_warning()}</p>
			<label class="phrase">
				<span>{m.yolo_phrase_label()}</span>
				<input
					type="text"
					autocomplete="off"
					autocapitalize="characters"
					spellcheck="false"
					bind:value={phrase}
					aria-describedby={`${id}-warning`}
					aria-invalid={tried && !matches ? 'true' : undefined}
					data-yolo-phrase
				/>
			</label>
			{#if tried && !matches}
				<p class="error" role="alert">{m.yolo_phrase_mismatch()}</p>
			{/if}
			<div class="actions">
				<button type="button" onclick={closeDialog}>{m.yolo_cancel()}</button>
				<button type="submit" class="danger" disabled={!matches} data-yolo-enable
					>{m.yolo_enable()}</button
				>
			</div>
		</form>
	</dialog>
{/if}

<style>
	.yolo-toggle {
		display: grid;
		gap: 4px;
		padding: 8px 10px;
		border: 1px dashed #a3262c;
		border-radius: 3px;
	}
	.on {
		color: #a3262c;
		font-weight: 700;
		letter-spacing: 0.08em;
	}
	.sub {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.hint {
		margin: 0;
		font-size: var(--fs-caption, 12px);
	}
	.arm,
	.off,
	.actions button {
		justify-self: start;
		padding: 4px 12px;
		border: 1px solid #a3262c;
		border-radius: 3px;
		background: transparent;
		color: #761115;
		font: inherit;
		cursor: pointer;
	}
	.yolo-dialog {
		max-width: min(40rem, 92vw);
		border: 3px solid #a3262c;
		border-radius: 4px;
	}
	.warning {
		line-height: 1.5;
	}
	.phrase {
		display: grid;
		gap: 4px;
	}
	.phrase input {
		font: 600 1rem var(--face-data, 'JetBrains Mono', monospace);
		padding: 6px 8px;
	}
	.error {
		color: #a3262c;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 12px;
	}
	.actions .danger {
		background: #a3262c;
		color: #fff;
	}
	.actions .danger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
