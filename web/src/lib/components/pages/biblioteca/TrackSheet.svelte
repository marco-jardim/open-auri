<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { encodeS1 } from 'open-auri/share';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { ABPreview, ABSide, AudioEngine, AudioEngineState } from '#lib/audio/engine.ts';
	import { LIVE_WINDOW_MS, tap, type MeterTap, type MeterUpdate } from '#lib/audio/meters.ts';
	import type { CurveData } from '#lib/state/model.ts';
	import {
		LIBRARY_DESCRIPTION_MAX,
		LIBRARY_NAME_MAX,
		LibraryUpdateError,
		type LibraryTextField,
		type LibraryTextIssue,
		type LibraryTextPatch
	} from '#lib/state/library.svelte.ts';
	import ResponseChart from '#lib/charts/ResponseChart.svelte';
	import { modalDialog } from '#lib/components/chrome/modal.ts';
	import { Button } from '#lib/components/primitives/index.ts';
	import { Transport } from '#lib/components/audio/index.ts';
	import { Explainer } from '#lib/components/comprehension/index.ts';
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
		onStatus,
		onOutputMeter,
		onEdited
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
		/** Real VU frames of the selected A/B chain output (post-curve, post-trim, pre-volume). */
		onOutputMeter?: (update: MeterUpdate) => void;
		/** The local item's name or description was saved: the library already holds it. */
		onEdited?: () => void;
	} = $props();
	/** Session tag of this sheet's comparison (Transport, navbar). */
	const BIBLIOTECA_SESSION = 'biblioteca';
	const id = $props.id();
	let preview: ABPreview | null = null;
	/** The preview this sheet is audibly running; its selected chain feeds the Preamp dial. */
	let audible = $state.raw<ABPreview | null>(null);
	let side = $state<ABSide>('B');
	let listening = $state(false);
	let busy = $state(false);
	let exporting = $state(false);
	let attempt = 0;
	let comparedCurrent: CurveData | undefined;
	let comparedTape: Tape | undefined;
	let outputExpiry: ReturnType<typeof setTimeout> | undefined;
	let license = $state<'' | 'CC0-1.0' | 'CC-BY-4.0'>('');
	let author = $state('');
	const code = $derived(encodeS1(tape));
	const meterReference = $derived(app?.state.meterRef.value ?? -18);
	// A boolean, so the 5 Hz position updates of the engine state never rebuild the tap.
	const metering = $derived(
		listening && audioState.playing && audioState.session === BIBLIOTECA_SESSION
	);
	const outputNode = $derived(
		metering && audible ? (side === 'A' ? audible.a.output : audible.b.output) : null
	);
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
	/** Every unavailable control says why (spec §2.6): the Button primitive announces it. */
	const audioReason = $derived(app ? null : m.biblioteca_reason_audio());
	const linkReason = $derived(share.url ? null : m.biblioteca_reason_link());
	const writeReason = $derived(
		!app
			? m.biblioteca_reason_loading()
			: verdict === null
				? m.biblioteca_gate_pending()
				: verdict.ok
					? null
					: m.biblioteca_gate_refused()
	);

	// ---- Name and description of a personal local curve (LIBEDIT) ----------------------------
	/** Library id of an editable tape: local shelf only, never an official preset or a
	 * community curve kept locally (its text is its author's). */
	const editableId = $derived(
		tape.group === 'local' && tape.id.startsWith('local:') && !tape.source.startsWith('community:')
			? tape.id.slice('local:'.length)
			: null
	);
	let editing = $state(false);
	let savingEdit = $state(false);
	let draftName = $state('');
	let draftDescription = $state('');
	let editIssues = $state.raw<readonly LibraryTextIssue[]>([]);
	let editFailure = $state('');
	let editButton = $state<HTMLButtonElement>();
	let nameField = $state<HTMLInputElement>();
	let descriptionField = $state<HTMLTextAreaElement>();
	const nameIssues = $derived(issueMessages('name'));
	const descriptionIssues = $derived(issueMessages('description'));
	const editReason = $derived(app ? null : m.biblioteca_reason_loading());

	/** Localised envelope issue (core `env:*` code), once per message, for one field. */
	function issueMessages(field: LibraryTextField): string[] {
		const text = (issue: LibraryTextIssue) => {
			switch (issue.code) {
				case 'env:url':
					return m.biblioteca_edit_url();
				case 'env:url-like':
					return m.biblioteca_edit_url_like();
				case 'env:length':
					return field === 'name'
						? m.biblioteca_edit_name_length()
						: m.biblioteca_edit_description_length();
				case 'env:pattern':
					return m.biblioteca_edit_control();
				default:
					return m.biblioteca_edit_invalid();
			}
		};
		return [...new Set(editIssues.filter((issue) => issue.field === field).map(text))];
	}
	function describedBy(...ids: (string | false)[]): string {
		return ids.filter(Boolean).join(' ');
	}
	function clearIssues(field: LibraryTextField) {
		editIssues = editIssues.filter((issue) => issue.field !== field);
		editFailure = '';
	}
	async function startEdit() {
		if (!app || !editableId) return;
		draftName = tape.name;
		draftDescription = tape.description;
		editIssues = [];
		editFailure = '';
		editing = true;
		await tick();
		nameField?.focus();
	}
	/** Leaves the form (drafts are discarded) and gives focus back to its opener. */
	async function endEdit() {
		editing = false;
		editIssues = [];
		editFailure = '';
		await tick();
		editButton?.focus();
	}
	function cancelEdit() {
		if (!savingEdit) void endEdit();
	}
	async function submitEdit(event: SubmitEvent) {
		event.preventDefault();
		const library = app?.state.library;
		if (!library || !editableId || savingEdit) return;
		// Only what the user changed: an untouched legacy name is never re-validated.
		const patch: LibraryTextPatch = {};
		if (draftName !== tape.name) patch.name = draftName;
		if (draftDescription !== tape.description) patch.description = draftDescription;
		savingEdit = true;
		editIssues = [];
		editFailure = '';
		try {
			await library.update(editableId, patch);
			savingEdit = false;
			onEdited?.();
			onStatus(m.biblioteca_edit_saved());
			await endEdit();
		} catch (error) {
			if (error instanceof LibraryUpdateError && error.code === 'invalid-text') {
				editIssues = error.issues;
				const nameRefused = error.issues.some((issue) => issue.field === 'name');
				await tick();
				(nameRefused ? nameField : descriptionField)?.focus();
			} else if (error instanceof LibraryUpdateError) {
				editFailure = m.biblioteca_edit_missing();
			} else {
				editFailure = m.biblioteca_edit_error();
				console.error('Biblioteca local edit failed', error);
			}
		} finally {
			savingEdit = false;
		}
	}
	/** Form keys: Esc cancels the edit (not the sheet), Ctrl/⌘+Enter saves from the textarea. */
	function editKeys(form: HTMLFormElement) {
		function onKeydown(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				// A canceled keydown sends the dialog no close request: only the form closes.
				event.preventDefault();
				event.stopPropagation();
				cancelEdit();
			} else if (
				event.key === 'Enter' &&
				(event.ctrlKey || event.metaKey) &&
				event.target instanceof HTMLTextAreaElement
			) {
				event.preventDefault();
				form.requestSubmit();
			}
		}
		form.addEventListener('keydown', onKeydown);
		return { destroy: () => form.removeEventListener('keydown', onKeydown) };
	}

	/** The engine this sheet put in chain mode; only that audition is stopped by the sheet. */
	let startedBy: AudioEngine | null = null;

	/** The engine plays or holds paused this sheet's session (not ♪ raw, not another page's). */
	function owned(engine: AudioEngine): boolean {
		const state = engine.state();
		return state.session === BIBLIOTECA_SESSION && (state.playing || state.paused);
	}

	/** Ends the session only if this sheet started it and it is still this sheet's. */
	function release() {
		const engine = startedBy;
		startedBy = null;
		if (engine && owned(engine)) engine.stop();
	}

	function clearOutput() {
		clearTimeout(outputExpiry);
		outputExpiry = undefined;
		onOutputMeter?.({ mode: 'data', frame: null });
	}

	function stop() {
		attempt++;
		clearOutput();
		release();
		if (preview) {
			preview.dispose();
			preview = null;
		}
		audible = null;
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
	// Preamp dial: the selected chain only, never the shared meter bus or the other side.
	$effect(() => {
		const node = outputNode;
		if (node === null) {
			clearOutput();
			return;
		}
		const reference = meterReference;
		let cancelled = false;
		let receivedFrame = false;
		let meter: MeterTap | null = null;
		let unsubscribe: (() => void) | undefined;
		void tap(node, { reference, kinds: ['vu'] })
			.then((source) => {
				if (cancelled) {
					source.disconnect();
					return;
				}
				meter = source;
				unsubscribe = source.subscribe((update) => {
					if (cancelled) return;
					if (update.mode === 'live' && update.frame?.active) {
						receivedFrame = true;
						clearTimeout(outputExpiry);
						onOutputMeter?.(update);
						// Expire from the last real reading, never from a side/reference change.
						outputExpiry = setTimeout(clearOutput, LIVE_WINDOW_MS);
					} else if ((update.mode === 'data' && receivedFrame) || outputExpiry === undefined) {
						// Initial DATA must not erase a fresh handoff; empty/inactive frames cannot renew it.
						clearOutput();
					}
				});
			})
			.catch((error: unknown) => {
				if (!cancelled) console.error('Biblioteca output meter failed', error);
			});
		return () => {
			cancelled = true;
			unsubscribe?.();
			meter?.disconnect();
			// Preserve the last reading while the replacement warms up, only until its expiry.
		};
	});
	// Last teardown, after the tap above is released: `stop()` (onDestroy above) runs first and
	// disposes the preview, so a frame delivered meanwhile may have armed a fresh expiry. No
	// `onOutputMeter` call may outlive the sheet.
	onDestroy(() => {
		clearTimeout(outputExpiry);
		outputExpiry = undefined;
	});

	async function listen(selected: ABSide) {
		if (!app || busy) return;
		const engine = app.audio;
		try {
			if (preview && startedBy === engine && owned(engine)) {
				// Same comparison: switch sides at the same moment; a paused one continues.
				preview.select(selected);
				side = selected;
				if (!engine.state().playing) await engine.resume();
				return;
			}
			stop();
			const token = ++attempt;
			busy = true;
			preview = engine.createAB(current, tape, { experimental: true, initial: selected });
			side = selected;
			// A comparison starts at a random point of the file (SEEK.2); the file loops.
			await engine.start('chains', { startAt: 'random', session: BIBLIOTECA_SESSION });
			if (token !== attempt) {
				// Stopped/closed while starting: nothing of ours may keep playing (raw is not ours).
				if (owned(engine)) engine.stop();
				return;
			}
			startedBy = engine;
			audible = preview;
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
		// A local tape carries its item's filter labels (`CurveData.labels`); presets carry none.
		if (app.state.curve.set({ ...tape, labels: tape.labels ?? null })) {
			onStatus(m.biblioteca_used());
			close();
		} else onStatus(m.biblioteca_local_error());
	}
	function requestWrite() {
		if (!app) return;
		stop();
		// The selected tape may be a deep $state proxy: hand over a plain copy (R2-02).
		const copy = $state.snapshot(tape);
		app.requestWrite({
			...copy,
			schema: 1,
			// A local tape carries its library item's filter labels; presets carry none.
			labels: copy.labels ?? null,
			updatedAt: Date.now()
		});
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
				{#if description && tape.group === 'local'}
					<!-- The user's own text: untranslated, in whatever language they wrote it. -->
					<p class="description own-description">{description}</p>
					<small>{m.biblioteca_edit_local_description()}</small>
				{:else if description}<p
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
				{#if editableId !== null}
					{#if editing}
						<form
							class="edit-form"
							aria-labelledby="{id}-edit-title"
							novalidate
							onsubmit={submitEdit}
							use:editKeys
						>
							<h3 id="{id}-edit-title">{m.biblioteca_edit_open()}</h3>
							<label for="{id}-edit-name">{m.biblioteca_edit_name()}</label>
							<input
								id="{id}-edit-name"
								bind:this={nameField}
								bind:value={draftName}
								maxlength={LIBRARY_NAME_MAX}
								autocomplete="off"
								aria-required="true"
								aria-invalid={nameIssues.length > 0}
								aria-describedby={describedBy(
									nameIssues.length > 0 && `${id}-edit-name-issue`,
									`${id}-edit-hint`
								)}
								oninput={() => clearIssues('name')}
							/>
							{#if nameIssues.length}<p id="{id}-edit-name-issue" class="edit-issue" role="alert">
									{nameIssues.join(' ')}
								</p>{/if}
							<label for="{id}-edit-description">{m.biblioteca_edit_description()}</label>
							<textarea
								id="{id}-edit-description"
								bind:this={descriptionField}
								bind:value={draftDescription}
								maxlength={LIBRARY_DESCRIPTION_MAX}
								rows="5"
								aria-invalid={descriptionIssues.length > 0}
								aria-describedby={describedBy(
									descriptionIssues.length > 0 && `${id}-edit-description-issue`,
									`${id}-edit-hint`
								)}
								oninput={() => clearIssues('description')}></textarea>
							{#if descriptionIssues.length}<p
									id="{id}-edit-description-issue"
									class="edit-issue"
									role="alert"
								>
									{descriptionIssues.join(' ')}
								</p>{/if}
							<p id="{id}-edit-hint" class="edit-hint">{m.biblioteca_edit_hint()}</p>
							{#if editFailure}<p class="edit-issue" role="alert">{editFailure}</p>{/if}
							<div class="actions">
								<Button type="submit" variant="primary" loading={savingEdit}
									>{m.biblioteca_edit_save()}</Button
								><Button
									variant="ghost"
									disabledReason={savingEdit ? m.biblioteca_edit_saving() : null}
									onclick={cancelEdit}>{m.biblioteca_edit_cancel()}</Button
								>
							</div>
						</form>
					{:else}
						<div class="edit-open">
							<Button
								size="sm"
								bind:element={editButton}
								disabledReason={editReason}
								onclick={startEdit}>{m.biblioteca_edit_open()}</Button
							>
						</div>
					{/if}
				{/if}
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
			<div class="head-row">
				<h3>{m.biblioteca_listen()}</h3>
				<Explainer term="ab-nivel" />
			</div>
			<div class="actions">
				<Button
					disabledReason={audioReason}
					loading={busy}
					aria-pressed={listening && audioState.playing && side === 'A'}
					onclick={() => listen('A')}>{m.biblioteca_listen_current()}</Button
				>
				<Button
					disabledReason={audioReason}
					loading={busy}
					aria-pressed={listening && audioState.playing && side === 'B'}
					onclick={() => listen('B')}>{m.biblioteca_listen_tape()}</Button
				>
				<Button
					variant="ghost"
					disabledReason={listening || busy ? null : m.biblioteca_reason_idle()}
					onclick={stop}>{m.biblioteca_stop()}</Button
				>
			</div>
			<!-- Pause keeps the comparison (side, trims, position); "Parar prévia" ends it. -->
			<Transport
				engine={app?.audio ?? null}
				state={app ? audioState : null}
				variant="compact"
				session={BIBLIOTECA_SESSION}
				onplay={() => listen(side)}
				playDisabledReason={audioReason}
			/>
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
				<Button disabledReason={linkReason} loading={exporting} onclick={() => exportSheet('svg')}
					>{m.biblioteca_svg()}</Button
				><Button disabledReason={linkReason} loading={exporting} onclick={() => exportSheet('png')}
					>{m.biblioteca_png()}</Button
				>
			</div>
		</section>
		<div class="sheet-grid" data-tour="biblioteca-share">
			<section class="code">
				<div class="head-row">
					<h3>{m.biblioteca_code()}</h3>
					<Explainer term="s1" />
				</div>
				<textarea readonly aria-label={m.biblioteca_code()} value={code} rows="5"></textarea>
				<Button onclick={copyCode}>{m.biblioteca_copy()}</Button>
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
		<div class="envelope-row">
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
				<Button
					disabledReason={envelope.exportable ? null : m.biblioteca_s5_note()}
					onclick={exportEnvelope}>{m.biblioteca_s5_export()}</Button
				>
			</details>
			<Explainer term="s5" />
		</div>
		<div class="actions bottom">
			<Button disabledReason={app ? null : m.biblioteca_reason_loading()} onclick={useCurve}
				>{m.biblioteca_use()}</Button
			><Button variant="primary" disabledReason={writeReason} onclick={requestWrite}
				>{m.biblioteca_write()}</Button
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
		font: 400 var(--fs-small, 13px) / 1.6 var(--face-body, 'Geist', sans-serif);
		/* The box slides out of the shelf (spec §3, Biblioteca): UI transition, not data. */
		animation: box-out var(--dur-scene, 0.72s) var(--ease-out, ease-out) both;
	}
	.sheet::backdrop {
		background: #080906c9;
		backdrop-filter: blur(5px);
	}
	/* Transform only: fading opacity would drop every text/surface pair below WCAG mid-motion. */
	@keyframes box-out {
		from {
			transform: translateY(32px) scale(0.97) rotate(-0.6deg);
		}
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
		font: 400 var(--fs-eyebrow, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.dialog-head button {
		min-width: 44px;
		min-height: 44px;
		padding: 4px 9px;
		background: transparent;
		border: 0;
		color: #e4d9bc;
		cursor: pointer;
		font: 400 28px/1 var(--type, 'Courier Prime', monospace);
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
		perspective: 700px;
	}
	/* The lid swings open once on the hinge, like the mock (biblioteca.html lid-open). */
	.reel::before {
		content: '';
		position: absolute;
		inset: -5px;
		z-index: 1;
		border: 5px solid #b8a47e;
		background: linear-gradient(135deg, #dbccaa, #ab976f);
		transform-origin: top;
		animation: lid-open var(--dur-scene, 0.72s) var(--ease-out, ease-out) forwards;
	}
	@keyframes lid-open {
		to {
			transform: rotateX(110deg);
			opacity: 0;
		}
	}
	.reel span {
		position: absolute;
		bottom: 8px;
		font: 400 var(--label-min, 11px) / 1 var(--face-data, 'JetBrains Mono', monospace);
	}
	h2 {
		margin: 0;
		overflow-wrap: anywhere;
		font: 400 48px/1.1 var(--type, 'Courier Prime', monospace);
		color: #f0e3c4;
		letter-spacing: -0.04em;
	}
	.byline,
	small,
	.credit,
	.gate-note {
		color: #e4d5ba;
		font: 400 var(--label-min, 11px) / 1.7 var(--face-data, 'JetBrains Mono', monospace);
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
	/* The user's own description keeps its line breaks (at most five, S5). */
	.own-description {
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.edit-open {
		margin: 10px 0 4px;
	}
	.edit-form {
		display: grid;
		max-width: 560px;
		margin: 12px 0 8px;
		padding: 14px;
		color: #ece7dd;
		background: #1c211a;
		border: 1px solid #a69f7144;
	}
	.edit-form h3 {
		margin: 0;
	}
	.edit-form label {
		margin-top: 10px;
	}
	.edit-form input,
	.edit-form textarea {
		box-sizing: border-box;
		width: 100%;
		margin-top: 4px;
		border: 1px solid #a9a68e77;
		font: 400 var(--fs-small, 13px) / 1.5 var(--face-body, 'Geist', sans-serif);
	}
	.edit-hint,
	.edit-issue {
		margin: 6px 0 0;
		font-size: var(--fs-caption, 12px);
	}
	.edit-hint {
		color: #e2dcc3;
	}
	.edit-issue {
		color: #ffe1a3;
	}
	.edit-form .actions {
		margin-top: 12px;
	}
	.listen {
		margin-bottom: 22px;
		padding: 16px 18px;
		color: #ece7dd;
		background: #1c211a;
		border: 1px solid #a69f7144;
	}
	.listen p {
		font-size: var(--label-min, 11px);
		color: #e2dcc3;
	}
	.head-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 0 0 12px;
	}
	.head-row h3 {
		margin: 0;
	}
	h3 {
		font: 400 16px/1.3 var(--type, 'Courier Prime', monospace);
		margin: 0 0 12px;
	}
	/* The track sheet unfolds like paper after the box opens. */
	.paper {
		padding: 23px;
		color: #302c23;
		background:
			repeating-linear-gradient(0deg, #0000 0 26px, #9f895617 27px 28px),
			linear-gradient(125deg, #f0e6cb, #d7c6a0);
		box-shadow: 2px 5px 12px #0007;
		transform-origin: top center;
		animation: paper-open var(--dur-scene, 0.72s) var(--ease-out, ease-out) both;
		animation-delay: calc(var(--dur-scene, 0.72s) * 0.3);
	}
	@keyframes paper-open {
		from {
			transform: perspective(1200px) rotateX(-62deg);
		}
	}
	.paper-title {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		border-block: 2px solid #63583e;
		padding-top: 12px;
	}
	.paper-title span {
		font: 400 var(--label-min, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
	}
	.table-scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin: 14px 0;
		font: 400 var(--fs-small, 13px) / 1.4 var(--type, 'Courier Prime', monospace);
		font-variant-numeric: tabular-nums;
	}
	th,
	td {
		padding: 8px;
		text-align: left;
		border-bottom: 1px solid #8b79584a;
	}
	thead th {
		font-size: var(--label-min, 11px);
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
	.sheet-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 20px;
		margin-top: 22px;
	}
	.code {
		display: grid;
		gap: 10px;
		justify-items: start;
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
		font: 400 var(--label-min, 11px) / 1.8 var(--face-data, 'JetBrains Mono', monospace);
		overflow-wrap: anywhere;
	}
	.print-card {
		padding: 18px;
		background: #e4d8b8;
		color: #302c23;
		font: 400 var(--fs-caption, 12px) / 1.5 var(--type, 'Courier Prime', monospace);
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
	.envelope-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin-top: 22px;
	}
	.envelope {
		flex: 1;
		min-width: 0;
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
		font: 400 var(--label-min, 11px) / 1.5 var(--face-data, 'JetBrains Mono', monospace);
	}
	label {
		display: grid;
		gap: 6px;
		margin-top: 12px;
		font-size: var(--fs-caption, 12px);
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
			display: none;
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
	@media (prefers-reduced-motion: reduce) {
		.sheet,
		.paper {
			animation: none;
		}
		.reel::before {
			display: none;
			animation: none;
		}
	}
</style>
