<script lang="ts">
	import { onDestroy } from 'svelte';
	import { encodeS1 } from 'open-auri/share';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { ABPreview, ABSide, AudioEngine, AudioEngineState } from '#lib/audio/engine.ts';
	import type { CurveData } from '#lib/state/model.ts';
	import { ResponseChart } from '#lib/charts/index.ts';
	import { modalDialog } from '#lib/components/chrome/modal.ts';
	import { m } from '#lib/paraglide/messages.js';
	// Biblioteca imports this sheet only on selection, deferring the QR encoder with it.
	import { presetUrl, qrSvg } from '#lib/qr/index.ts';
	import { envelopeView, number, type Locale, type Tape, type GateResult } from './archive.ts';

	let {
		tape,
		current,
		origin,
		locale,
		app,
		verdict,
		audioState,
		onClose,
		onStatus
	}: {
		tape: Tape;
		current: CurveData;
		origin: string;
		locale: Locale;
		app: ClientApp | null;
		verdict: GateResult | null;
		audioState: AudioEngineState;
		onClose: () => void;
		onStatus: (message: string) => void;
	} = $props();
	const id = $props.id();
	let preview: ABPreview | null = null;
	let side = $state<ABSide>('B');
	let listening = $state(false);
	let busy = $state(false);
	let exporting = $state(false);
	let attempt = 0;
	let comparedCurrent: CurveData | undefined;
	let comparedTape: Tape | undefined;
	let license = $state<'' | 'CC0-1.0' | 'CC-BY-4.0'>('');
	let author = $state('');
	const code = $derived(encodeS1(tape));
	const share = $derived.by(() => {
		try {
			const url = presetUrl(origin, code);
			return { url, image: `data:image/svg+xml,${encodeURIComponent(qrSvg(url))}` };
		} catch (error) {
			console.error('Biblioteca QR generation failed', error);
			return { url: null, image: null };
		}
	});
	const envelope = $derived.by(() => {
		try {
			return { ...envelopeView(tape, locale, license, author), error: false };
		} catch (error) {
			return { json: '', exportable: false, error: error instanceof Error };
		}
	});
	const localRights = $derived(tape.group === 'local' && !tape.source.startsWith('preset:'));
	const description = $derived(
		locale === 'en-US' && tape.descriptionEn ? tape.descriptionEn : tape.description
	);

	/** The engine this sheet put in chain mode; only that audition is stopped by the sheet. */
	let startedBy: AudioEngine | null = null;

	/** Stops the engine only if this sheet started it and it still plays chains (not ♪ raw). */
	function release() {
		const engine = startedBy;
		startedBy = null;
		if (engine && engine.state().mode === 'chains') engine.stop();
	}

	function stop() {
		attempt++;
		release();
		if (preview) {
			preview.dispose();
			preview = null;
		}
		listening = false;
		busy = false;
	}
	// A preview is a frozen comparison. Changing the editor invalidates it, never rebuilds audibly.
	$effect(() => {
		if (current !== comparedCurrent || tape !== comparedTape) stop();
		comparedCurrent = current;
		comparedTape = tape;
	});
	onDestroy(stop);

	async function listen(selected: ABSide) {
		if (!app || busy) return;
		const engine = app.audio;
		try {
			if (preview && audioState.playing) {
				preview.select(selected);
				side = selected;
				return;
			}
			stop();
			const token = ++attempt;
			busy = true;
			preview = engine.createAB(current, tape, { experimental: true, initial: selected });
			side = selected;
			await engine.start('chains');
			if (token !== attempt) {
				// Stopped/closed while starting: nothing of ours may keep playing (raw is not ours).
				if (engine.state().mode === 'chains') engine.stop();
				return;
			}
			startedBy = engine;
			listening = true;
		} catch (error) {
			stop();
			onStatus(m.biblioteca_audio_error());
			console.error('Biblioteca preview failed', error);
		} finally {
			busy = false;
		}
	}

	function close() {
		stop();
		onClose();
	}
	async function exportSheet(format: 'svg' | 'png') {
		if (exporting) return;
		exporting = true;
		try {
			const { sheetSvg, sheetPng, downloadBlob } = await import('./sheet-export.ts');
			const svg = sheetSvg(tape, origin, locale, {
				title: m.biblioteca_sheet(),
				response: m.biblioteca_response(),
				preamp: m.biblioteca_preamp(),
				track: m.biblioteca_track(),
				frequency: m.biblioteca_frequency(),
				gain: m.biblioteca_gain(),
				license: tape.group === 'local' ? m.biblioteca_local_license() : m.biblioteca_license(),
				card: m.biblioteca_card()
			});
			const blob =
				format === 'svg'
					? new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
					: await sheetPng(svg);
			downloadBlob(blob, `open-auri-sheet.${format}`);
		} catch (error) {
			onStatus(m.biblioteca_export_error());
			console.error('Biblioteca sheet export failed', error);
		} finally {
			exporting = false;
		}
	}
	async function exportEnvelope() {
		try {
			const { downloadBlob } = await import('./sheet-export.ts');
			downloadBlob(
				new Blob([envelope.json], { type: 'application/json' }),
				'open-auri-preset.json'
			);
		} catch (error) {
			onStatus(m.biblioteca_export_error());
			console.error('Biblioteca envelope export failed', error);
		}
	}
	async function copyCode() {
		try {
			await navigator.clipboard.writeText(code);
			onStatus(m.biblioteca_copied());
		} catch (error) {
			onStatus(m.biblioteca_copy_error());
			console.error('Biblioteca clipboard failed', error);
		}
	}
	function useCurve() {
		if (!app) return;
		if (app.state.curve.set(tape)) {
			onStatus(m.biblioteca_used());
			close();
		} else onStatus(m.biblioteca_local_error());
	}
	function requestWrite() {
		if (!app) return;
		stop();
		// The selected tape may be a deep $state proxy: hand over a plain copy (R2-02).
		app.requestWrite({ ...$state.snapshot(tape), schema: 1, updatedAt: Date.now() });
		onClose();
	}
</script>

<dialog
	class="sheet"
	aria-labelledby="{id}-title"
	use:modalDialog={{ open: true, onDismiss: close, initialFocus: '[data-close]' }}
>
	<header class="dialog-head">
		<span>{m.biblioteca_sheet()}</span><button
			type="button"
			data-close
			onclick={close}
			aria-label={m.biblioteca_close()}>×</button
		>
	</header>
	<div class="sheet-body">
		<div class="opened-box">
			<div class="reel" aria-hidden="true">◉<span>96 kHz / MASTER</span></div>
			<div>
				<h2 id="{id}-title">{tape.name}</h2>
				<p class="byline">{tape.id} / {m.biblioteca_preamp()} {number(tape.preampDb, locale)} dB</p>
				{#if description}<p
						class="description"
						lang={locale === 'en-US' && !tape.descriptionEn ? 'pt-BR' : locale}
					>
						{description}
					</p>
					<small
						>{locale === 'en-US' && !tape.descriptionEn
							? m.biblioteca_original_description()
							: m.biblioteca_description()}</small
					>{/if}
				{#if tape.source === 'preset:padrao'}<p class="credit">{m.biblioteca_credit()}</p>{/if}
				<p class="gate-line">
					{verdict === null
						? m.biblioteca_gate_pending()
						: verdict.ok
							? m.biblioteca_gate_ok()
							: m.biblioteca_gate_refused()}
				</p>
				<p class="gate-note">{m.biblioteca_gate_note()}</p>
			</div>
		</div>
		<section class="listen" aria-label={m.biblioteca_listen()}>
			<h3>{m.biblioteca_listen()}</h3>
			<div class="actions">
				<button
					type="button"
					disabled={!app || busy}
					aria-pressed={listening && audioState.playing && side === 'A'}
					onclick={() => listen('A')}>{m.biblioteca_listen_current()}</button
				>
				<button
					type="button"
					disabled={!app || busy}
					aria-pressed={listening && audioState.playing && side === 'B'}
					onclick={() => listen('B')}>{m.biblioteca_listen_tape()}</button
				>
				<button type="button" disabled={!listening && !busy} onclick={stop}
					>{m.biblioteca_stop()}</button
				>
			</div>
			<p>{m.biblioteca_listen_note()}</p>
			{#if !audioState.exact}<p>{m.biblioteca_approximate()}</p>{/if}
		</section>
		<section class="paper" aria-label={m.biblioteca_sheet()}>
			<div class="paper-title">
				<h3>{m.biblioteca_sheet()}</h3>
				<span>10 × BIQUAD / Q27 + Q23</span>
			</div>
			<ResponseChart
				curve={tape}
				label={tape.name}
				description={m.biblioteca_response()}
				{locale}
				theme="paper"
			/>
			<div class="table-scroll">
				<table>
					<caption class="sr-only">{m.biblioteca_sheet()} · {tape.name}</caption>
					<thead
						><tr
							><th scope="col">{m.biblioteca_track()}</th><th scope="col">TYPE</th><th scope="col"
								>{m.biblioteca_frequency()}</th
							><th scope="col">{m.biblioteca_gain()}</th><th scope="col">Q</th></tr
						></thead
					>
					<tbody
						>{#each tape.bands as band, index (band)}<tr
								><th scope="row">{String(index + 1).padStart(2, '0')}</th><td>{band.kind}</td><td
									>{band.kind === 'OFF' ? '∅' : number(band.freqHz, locale, 0)}</td
								><td
									>{band.kind === 'OFF' || band.kind === 'LP' || band.kind === 'HP'
										? '∅'
										: number(band.gainDb, locale)}</td
								><td>{band.kind === 'OFF' ? '∅' : number(band.qFactor, locale, 2)}</td></tr
							>{/each}</tbody
					>
				</table>
			</div>
			<div class="actions">
				<button type="button" disabled={exporting || !share.url} onclick={() => exportSheet('svg')}
					>{m.biblioteca_svg()}</button
				><button type="button" disabled={exporting || !share.url} onclick={() => exportSheet('png')}
					>{m.biblioteca_png()}</button
				>
			</div>
		</section>
		<div class="sheet-grid">
			<section class="code">
				<h3>{m.biblioteca_code()}</h3>
				<textarea readonly aria-label={m.biblioteca_code()} value={code} rows="5"></textarea><button
					type="button"
					onclick={copyCode}>{m.biblioteca_copy()}</button
				>
			</section>
			<section class="print-card">
				<h3>{m.biblioteca_card()}</h3>
				<strong>{tape.name}</strong>
				<p>{tape.group === 'local' ? m.biblioteca_local_license() : m.biblioteca_license()}</p>
				{#if share.image && share.url}<img
						src={share.image}
						width="180"
						height="180"
						alt={m.biblioteca_qr()}
					/><a href={share.url}>{m.biblioteca_link()}</a>{:else}<p>
						{m.biblioteca_export_error()}
					</p>{/if}
			</section>
		</div>
		<details class="envelope">
			<summary>{m.biblioteca_s5()}</summary>
			{#if localRights}<label
					>{m.biblioteca_s5_license()}<select bind:value={license}
						><option value="">{m.biblioteca_s5_choose()}</option><option value="CC0-1.0"
							>CC0-1.0</option
						><option value="CC-BY-4.0">CC-BY-4.0</option></select
					></label
				><label>{m.biblioteca_author()}<input bind:value={author} maxlength="64" /></label>{/if}
			{#if !envelope.exportable}<p>{m.biblioteca_s5_note()}</p>{/if}
			{#if envelope.error}<p role="alert">
					{m.biblioteca_s5_error()}
				</p>{:else}<pre>{envelope.json}</pre>{/if}
			<button type="button" disabled={!envelope.exportable} onclick={exportEnvelope}
				>{m.biblioteca_s5_export()}</button
			>
		</details>
		<div class="actions bottom">
			<button type="button" disabled={!app} onclick={useCurve}>{m.biblioteca_use()}</button><button
				class="primary"
				type="button"
				disabled={!app || !verdict?.ok}
				onclick={requestWrite}>{m.biblioteca_write()}</button
			>
		</div>
	</div>
</dialog>

<style>
	.sheet {
		box-sizing: border-box;
		width: 1060px;
		max-width: calc(100vw - 30px);
		max-height: 92dvh;
		padding: 0;
		overflow: auto;
		border: 8px solid #4d3523;
		border-radius: 4px;
		color: #ece7dd;
		background: repeating-linear-gradient(90deg, #44291c 0, #5b3823 8px, #392318 90px);
		box-shadow: 0 20px 90px #000b;
		font:
			13px/1.6 'Geist',
			sans-serif;
	}
	.sheet::backdrop {
		background: #080906c9;
		backdrop-filter: blur(5px);
	}
	.dialog-head {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 10px 18px;
		background: #232920;
		color: #e4d9bc;
		font:
			11px 'JetBrains Mono',
			monospace;
	}
	.dialog-head button {
		background: transparent;
		border: 0;
		font-size: 28px;
	}
	.sheet-body {
		padding: 24px;
	}
	.opened-box {
		display: grid;
		grid-template-columns: 150px 1fr;
		gap: 25px;
		align-items: center;
		margin-bottom: 23px;
	}
	.reel {
		position: relative;
		display: grid;
		place-items: center;
		height: 150px;
		border: 5px solid #baa885;
		background: linear-gradient(135deg, #5c5946, #3d4232);
		color: #bdbb9b;
		font-size: 118px;
		line-height: 1;
		box-shadow: inset 3px 5px 16px #0008;
	}
	.reel span {
		position: absolute;
		bottom: 8px;
		font:
			8px 'JetBrains Mono',
			monospace;
	}
	h2 {
		margin: 0;
		overflow-wrap: anywhere;
		font:
			48px/1.1 'Courier Prime',
			monospace;
		color: #f0e3c4;
		letter-spacing: -0.04em;
	}
	.byline,
	small,
	.credit,
	.gate-note {
		color: #e4d5ba;
		font:
			11px/1.7 'JetBrains Mono',
			monospace;
	}
	.description {
		margin-bottom: 3px;
		color: #e8d8b8;
	}
	.gate-line {
		color: #ffe1a3;
		margin-bottom: 4px;
	}
	.gate-note {
		margin-top: 0;
	}
	.listen {
		margin-bottom: 22px;
		padding: 16px 18px;
		background: #1c211a;
		border: 1px solid #a69f7144;
	}
	.listen p {
		font-size: 11px;
		color: #e2dcc3;
	}
	h3 {
		font:
			16px 'Courier Prime',
			monospace;
		margin: 0 0 12px;
	}
	.paper {
		padding: 23px;
		color: #302c23;
		background:
			repeating-linear-gradient(0deg, #0000 0 26px, #9f895617 27px 28px),
			linear-gradient(125deg, #f0e6cb, #d7c6a0);
		box-shadow: 2px 5px 12px #0007;
	}
	.paper-title {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		border-block: 2px solid #63583e;
		padding-top: 12px;
	}
	.paper-title span {
		font:
			9px 'JetBrains Mono',
			monospace;
	}
	.table-scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin: 14px 0;
		font:
			13px 'Courier Prime',
			monospace;
	}
	th,
	td {
		padding: 8px;
		text-align: left;
		border-bottom: 1px solid #8b79584a;
	}
	thead th {
		font-size: 11px;
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.bottom {
		justify-content: flex-end;
		margin-top: 20px;
	}
	button {
		min-height: 38px;
		padding: 8px 12px;
		cursor: pointer;
		color: #ece7dd;
		background: #272d23;
		border: 1px solid #a9a68e77;
		border-radius: 2px;
		font:
			12px 'Geist',
			sans-serif;
	}
	button[aria-pressed='true'],
	.primary {
		background: #d9a441;
		color: #1c180e;
		border-color: #d9a441;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.paper button {
		color: #302c23;
		background: #d7c6a0;
		border-color: #6c5e42;
	}
	.sheet-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 20px;
		margin-top: 22px;
	}
	.code {
		min-width: 0;
	}
	textarea {
		box-sizing: border-box;
		resize: vertical;
		width: 100%;
		background: #1a2017;
		color: #e4dfca;
		border: 1px solid #a9a68e77;
		padding: 12px;
		font:
			11px/1.8 'JetBrains Mono',
			monospace;
		overflow-wrap: anywhere;
	}
	.print-card {
		padding: 18px;
		background: #e4d8b8;
		color: #302c23;
		font:
			12px 'Courier Prime',
			monospace;
	}
	.print-card strong {
		display: block;
		overflow-wrap: anywhere;
		font-size: 22px;
	}
	.print-card img {
		display: block;
		max-width: 100%;
		height: auto;
		margin: 14px 0;
	}
	.print-card a {
		color: inherit;
		text-underline-offset: 4px;
	}
	.envelope {
		margin-top: 22px;
		padding: 14px;
		background: #1c211a;
	}
	.envelope summary {
		cursor: pointer;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 350px;
		overflow: auto;
		font-size: 11px;
	}
	label {
		display: grid;
		gap: 6px;
		margin-top: 12px;
		font-size: 12px;
	}
	input,
	select {
		min-height: 36px;
		background: #e4d8b8;
		color: #302c23;
		padding: 6px;
	}
	:where(button, a, textarea, summary, input, select):focus-visible {
		outline: 3px solid #f6bd55;
		outline-offset: 4px;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		clip-path: inset(50%);
		overflow: hidden;
	}
	@media (max-width: 780px) {
		.sheet-body {
			padding: 16px;
		}
		.opened-box {
			grid-template-columns: 80px 1fr;
			gap: 14px;
		}
		.reel {
			height: 90px;
			font-size: 70px;
		}
		.reel span {
			font-size: 5px;
		}
		h2 {
			font-size: 30px;
		}
		.paper {
			padding: 13px;
		}
		.sheet-grid {
			grid-template-columns: 1fr;
		}
		.paper-title {
			flex-direction: column;
		}
		.paper-title span {
			margin-bottom: 10px;
		}
	}
</style>
