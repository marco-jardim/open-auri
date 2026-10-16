<!--
	Import and export: `.txt` (EqualizerAPO), S5 JSON (`open-auri/preset@1`), `.bin` (the exact
	220-byte payload) and the `#p=<S1>` link (copied to the clipboard and shown in a read-only field).
	Imports go to the page (`onimport`), which only loads gate-approved results into the editor.
	Names from files are untrusted: they are rendered as text only.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
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

	interface Props {
		curve: Curve;
		name: string;
		source: string;
		layer: Layer;
		locale: string;
		pageUrl: UrlLike;
		now?: () => number;
		disabled?: boolean;
		onimport: (result: ImportResult) => void;
		notify: (message: string, tone?: 'info' | 'error') => void;
		download?: Downloader;
		clipboard?: ClipboardWriter;
	}
	let {
		curve,
		name,
		source,
		layer,
		locale,
		pageUrl,
		now = Date.now,
		disabled = false,
		onimport,
		notify,
		download = browserDownload,
		clipboard = (text) => navigator.clipboard.writeText(text)
	}: Props = $props();

	const headingId = $props.id();
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

	function onTxt() {
		const result = exportTxt(curve, layer);
		if (!result.ok)
			return notify(m.curva_export_refused({ reason: ioFailureText(result) }), 'error');
		save(fileName(name, 'txt'), new Blob([result.value], { type: 'text/plain;charset=utf-8' }));
	}
	function onJson() {
		const lang = locale.startsWith('en') ? 'en-US' : 'pt-BR';
		const result = exportS5(curve, { name, source, lang, now: now() }, layer);
		if (!result.ok)
			return notify(m.curva_export_refused({ reason: ioFailureText(result) }), 'error');
		save(fileName(name, 'json'), new Blob([result.value], { type: 'application/json' }));
	}
	function onBin() {
		const result = exportBin(curve);
		if (!result.ok)
			return notify(m.curva_export_refused({ reason: ioFailureText(result) }), 'error');
		save(fileName(name, 'bin'), new Blob([result.value], { type: 'application/octet-stream' }));
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

<section class="io" aria-labelledby={headingId}>
	<h2 id={headingId}>{m.curva_io_heading()}</h2>
	<div class="exports">
		<button type="button" class="btn-pl" {disabled} onclick={onTxt}>{m.curva_export_txt()}</button>
		<button type="button" class="btn-pl" {disabled} onclick={onJson}>{m.curva_export_json()}</button
		>
		<button type="button" class="btn-pl" {disabled} onclick={onBin}>{m.curva_export_bin()}</button>
		<label class="btn-pl file">
			<span>{m.curva_import()}</span>
			<input
				type="file"
				accept=".txt,.json,text/plain,application/json"
				{disabled}
				onchange={(event) => void onFile(event.currentTarget)}
			/>
		</label>
		<button type="button" class="btn-pl" {disabled} onclick={() => void onShare()}
			>{m.curva_share()}</button
		>
	</div>
	{#if link}
		<label class="link">
			<span>{m.curva_link_field()}</span>
			<input readonly value={link} onfocus={(event) => event.currentTarget.select()} />
		</label>
	{/if}
	<p class="note">{m.curva_io_note()}</p>
</section>

<style>
	.io {
		padding: 14px 16px;
		border-radius: 6px;
		background: linear-gradient(#2e2d2b, #1f1e1c);
		color: var(--curva-silk, #e9e3d4);
	}
	h2 {
		margin: 0 0 10px;
		font: 400 22px/1.1 var(--font-display, 'Instrument Serif', serif);
	}
	.exports {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.file {
		position: relative;
		overflow: hidden;
	}
	.file input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}
	.file:focus-within {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 2px;
	}
	.link {
		display: grid;
		gap: 4px;
		margin-top: 10px;
		font-size: 11px;
		color: var(--curva-silk-2, #c9c1ae);
	}
	.link input {
		min-height: 30px;
		padding: 4px 8px;
		border: 1px solid rgb(238 233 222 / 0.25);
		border-radius: 2px;
		background: #0d1310;
		color: #b6edb0;
		font: 12px/1.2 var(--font-mono, 'JetBrains Mono', monospace);
	}
	.note {
		margin: 8px 0 0;
		font-size: 11px;
		color: var(--curva-silk-2, #c9c1ae);
	}
</style>
