<!--
	Import and export: `.txt` (EqualizerAPO), S5 JSON (`open-auri/preset@1`), `.bin` (the exact
	220-byte payload) and the `#p=<S1>` link (copied to the clipboard and shown in a read-only field).
	Imports go to the page (`onimport`), which only loads gate-approved results into the editor.
	Names from files are untrusted: they are rendered as text only.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import { Button, Panel } from '#lib/components/primitives/index.ts';
	import type { Layer, UrlLike } from './layers.ts';
	import type { Curve } from './model.ts';
	import {
		exportBin,
		exportS5,
		exportTxt,
		fileName,
		importFileText,
		linkHash,
		linkUrl,
		type ClipboardWriter,
		type Downloader,
		type ImportResult
	} from './io.ts';
	import { ioFailureText } from './io-text.ts';
	import { isYoloCurve } from './yolo.ts';

	interface Props {
		curve: Curve;
		name: string;
		source: string;
		/** Filter labels by wire index; S5 only (`open-auri/preset@2` when one is set). */
		labels?: readonly (string | null)[] | null;
		layer: Layer;
		locale: string;
		pageUrl: UrlLike;
		now?: () => number;
		disabled?: boolean;
		/** Why the controls are unavailable while `disabled` (default: the editor is loading). */
		disabledReason?: string | null;
		/**
		 * Why the exports and the link are unavailable while import stays open: the curve is
		 * rejected (neither standard nor YOLO). `io.ts` refuses it as well; a YOLO curve leaves
		 * marked.
		 */
		exportReason?: string | null;
		onimport: (result: ImportResult) => void;
		notify: (message: string, tone?: 'info' | 'error') => void;
		download?: Downloader;
		clipboard?: ClipboardWriter;
	}
	let {
		curve,
		name,
		source,
		labels = null,
		layer,
		locale,
		pageUrl,
		now = Date.now,
		disabled = false,
		disabledReason = null,
		exportReason = null,
		onimport,
		notify,
		download = browserDownload,
		clipboard = (text) => navigator.clipboard.writeText(text)
	}: Props = $props();

	const uid = $props.id();
	const reasonId = `${uid}-reason`;
	const reason = $derived(disabled ? (disabledReason ?? m.curva_v2_loading_reason()) : null);
	/** Exports and the link: the controls' reason, else the standard gate's refusal. */
	const exportBlocked = $derived(reason ?? exportReason);
	let link = $state('');

	function browserDownload(file: string, blob: Blob) {
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = file;
		anchor.rel = 'noopener';
		document.body.append(anchor);
		anchor.click();
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	function save(file: string, blob: Blob) {
		download(file, blob);
		notify(m.curva_exported({ name: file }));
	}

	const lang = $derived(locale.startsWith('en') ? 'en-US' : 'pt-BR');
	/** A YOLO curve leaves marked: `-yolo` file names, the `.txt` header, this note. */
	const yolo = $derived(isYoloCurve(curve));

	function onTxt() {
		const result = exportTxt(curve, layer, lang);
		if (!result.ok)
			return notify(m.curva_export_refused({ reason: ioFailureText(result) }), 'error');
		save(
			fileName(name, 'txt', result.yolo),
			new Blob([result.value], { type: 'text/plain;charset=utf-8' })
		);
	}
	function onJson() {
		const result = exportS5(curve, { name, source, lang, now: now(), labels }, layer);
		if (!result.ok)
			return notify(m.curva_export_refused({ reason: ioFailureText(result) }), 'error');
		save(
			fileName(name, 'json', result.yolo),
			new Blob([result.value], { type: 'application/json' })
		);
	}
	function onBin() {
		const result = exportBin(curve);
		if (!result.ok)
			return notify(m.curva_export_refused({ reason: ioFailureText(result) }), 'error');
		save(
			fileName(name, 'bin', result.yolo),
			new Blob([result.value], { type: 'application/octet-stream' })
		);
	}
	async function onFile(input: HTMLInputElement) {
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		if (file.size > 65536) {
			onimport({ ok: false, error: 'format', reasons: [] });
			return;
		}
		onimport(importFileText(await file.text(), layer));
	}
	async function onShare() {
		const result = linkHash(curve, layer);
		if (!result.ok) {
			link = '';
			return notify(m.curva_export_refused({ reason: ioFailureText(result) }), 'error');
		}
		link = linkUrl(pageUrl, result.value);
		try {
			await clipboard(link);
			notify(m.curva_link_copied());
		} catch (cause) {
			console.warn('Clipboard refused', cause);
			notify(m.curva_link_copy_failed(), 'error');
		}
	}
</script>

<Panel variant="hardware" class="io" eyebrow={m.curva_v2_io_eyebrow()} title={m.curva_io_heading()}>
	<div class="exports">
		<Button size="sm" caps disabledReason={exportBlocked} onclick={onTxt}
			>{m.curva_export_txt()}</Button
		>
		<Button size="sm" caps disabledReason={exportBlocked} onclick={onJson}
			>{m.curva_export_json()}</Button
		>
		<Button size="sm" caps disabledReason={exportBlocked} onclick={onBin}
			>{m.curva_export_bin()}</Button
		>
		<label class="file" class:off={disabled}>
			<span>{m.curva_import()}</span>
			<input
				type="file"
				accept=".txt,.json,text/plain,application/json"
				{disabled}
				aria-describedby={reason ? reasonId : undefined}
				onchange={(event) => void onFile(event.currentTarget)}
			/>
		</label>
	</div>
	<div class="share">
		<Button size="sm" caps disabledReason={exportBlocked} onclick={() => void onShare()}
			>{m.curva_share()}</Button
		>
		<Explainer term="s1" />
	</div>
	{#if exportBlocked}
		<p class="note" id={reasonId}>{exportBlocked}</p>
	{:else if yolo}
		<p class="note" data-yolo-export>{m.yolopub_export_marked()}</p>
	{/if}
	{#if link}
		<label class="link">
			<span>{m.curva_link_field()}</span>
			<input readonly value={link} onfocus={(event) => event.currentTarget.select()} />
		</label>
	{/if}
	<p class="note">{m.curva_io_note()}</p>
</Panel>

<style>
	/* Rack panel under the instrument: the Curva satin with a wood-grain top edge. */
	:global(.panel.io) {
		--panel-material: linear-gradient(180deg, #2e2d2b, #1f1e1c);
		border-top: 3px solid #4b2b16;
	}
	.exports,
	.share {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}
	.share {
		margin-top: var(--space-2);
	}
	.file {
		position: relative;
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		padding: 0 10px;
		overflow: hidden;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-sm);
		background: color-mix(in srgb, var(--text) 4%, transparent);
		box-shadow: var(--bevel);
		color: var(--text);
		font: 600 var(--fs-caption) / 1 var(--face-engrave);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		cursor: pointer;
	}
	.file.off {
		background: var(--lamp-off);
		color: var(--muted-hi);
		box-shadow: none;
		cursor: not-allowed;
	}
	.file input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: inherit;
	}
	.file:focus-within {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}
	.link {
		display: grid;
		gap: 4px;
		margin-top: 10px;
		color: var(--text-2);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
	.link input {
		min-height: 30px;
		padding: 4px 8px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-xs);
		background: #050505;
		box-shadow: var(--well);
		/* Fixed dark LCD: the text keeps a fallback even without the tokens. */
		color: var(--accent-text, #ff7a2f);
		font: 400 var(--fs-caption) / 1.2 var(--face-data);
	}
	.note {
		margin: 8px 0 0;
		color: var(--muted);
		font: 400 var(--fs-caption) / var(--lh-small) var(--face-body);
	}
</style>
