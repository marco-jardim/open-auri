<!--
	Cabo (Ray Dolby): a 19" rack, U1 to U8 (FUX.P6). Every lamp, node, lever and reel here
	follows real state: the shared cable service (`app.cableState`), the gate verdict of the
	editor's curve and the journal. This page never writes: the only way to the cable is
	`app.requestWrite()`, which opens the layout's checklist, whose GRAVAR lever is the gesture.
-->
<script module lang="ts">
	import { LazyModule } from '#lib/app/lazy.svelte.ts';

	// FUX.B: the rack units below the fold (U4 tape, U5 journal and social status, U6 counters,
	// U7 cable list) are their own chunks, loaded on approach or idle behind same-size boxes.
	const transportTape = new LazyModule(() => import('./TransportTape.svelte'));
	const journal = new LazyModule(() => import('./Journal.svelte'));
	const socialStatus = new LazyModule(() => import('./SocialStatus.svelte'));
	const flashCounters = new LazyModule(() => import('./FlashCounters.svelte'));
	const cableList = new LazyModule(() => import('./CableList.svelte'));
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { PRESETS_BY_ID } from 'open-auri/catalog';
	import Deferred from '#lib/components/pages/lazy/Deferred.svelte';
	import { gateForWrite, isExperimentalKind } from 'open-auri/safety';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { JournalEntry } from '#lib/cable/types.ts';
	import { loadDecision } from './load-entry.ts';
	import { lampsFromGate } from '#lib/cable/checklist.ts';
	import { neutralCurve } from '#lib/state/model.ts';
	// Direct imports (FUX.B): the charts and chrome barrels would bring every chart, HelpOverlay
	// and ConfirmDialog into the page.
	import ByteMap from '#lib/charts/ByteMap.svelte';
	import ResponseChart from '#lib/charts/ResponseChart.svelte';
	import { hexBytes } from '#lib/charts/protocol.ts';
	import EmBreve from '#lib/components/chrome/EmBreve.svelte';
	import LazyArt from '#lib/components/art/LazyArt.svelte';
	import { formatCrc, formatNumber } from '#lib/components/cable/i18n.ts';
	import { criteriaValues } from '#lib/components/cable/criteria.ts';
	import LevelGauge from '#lib/components/cable/LevelGauge.svelte';
	import CriteriaList from '#lib/components/cable/CriteriaList.svelte';
	import LoudnessPanel from '#lib/components/cable/LoudnessPanel.svelte';
	import { Button, Lamp } from '#lib/components/primitives/index.ts';
	import { Explainer, Tour, TourTrigger } from '#lib/components/comprehension/index.ts';
	import RackUnit from './RackUnit.svelte';
	import StateDiagram from './StateDiagram.svelte';

	import {
		CABLE_PROGRESS_EVENT,
		diagramNode,
		encoderData,
		lastWritten,
		parseProgress,
		rackState,
		type DiagramNode,
		type TapeProgress
	} from './model.ts';

	let {
		app,
		signedIn = false,
		tourAutoOpen = true
	}: {
		app: ClientApp | null;
		/** T4.16: shows "instalada" for a community curve; never affects writing. */
		signedIn?: boolean;
		/** First-visit tour on desktop (spec §4.2); hosts and tests may turn it off. */
		tourAutoOpen?: boolean;
	} = $props();
	const fallback = neutralCurve();
	const curve = $derived(app?.state.curve.current ?? fallback);
	const preset = $derived(
		curve.source.startsWith('preset:') ? PRESETS_BY_ID[curve.source.slice(7)] : null
	);
	const cable = $derived(app?.cableState ?? null);
	const entries = $derived(app?.state.journal.entries ?? []);
	const last = $derived(entries.at(-1));
	const encoder = $derived(encoderData(curve));
	const experimental = $derived(curve.bands.some((band) => isExperimentalKind(band.kind)));
	const unconfirmed = { volumeLowered: false, keepConnected: false, experimental: false };
	// One gate verdict for the calibration unit: lamps, values and the checklist reuse it.
	const gate = $derived(gateForWrite(curve.bands, curve.preampDb, { experimental }));
	const lamps = $derived(lampsFromGate(gate));
	const values = $derived(criteriaValues(gate));
	const checklist = $derived.by(() => {
		// The shared checklist owns gate, loudness and confirmation logic. Only read its result here.
		void cable;
		return (
			app?.cable.checklist(
				{
					bands: curve.bands,
					preampDb: curve.preampDb,
					experimental,
					confirmations: unconfirmed
				},
				gate
			) ?? null
		);
	});
	// Wall clock for the local-day rollover of the counters; refreshed every 30 s after mount.
	let now = $state(Date.now());
	let realRequested = $state(false);
	let coverOpen = $state(false);
	/** Live write progress, only if the service reports it (see model.ts). */
	let progress = $state<TapeProgress | null>(null);
	const rackStatus = $derived(rackState(cable, realRequested));
	const node = $derived(diagramNode(rackStatus));
	const realMode = $derived(cable?.mode === 'real');
	const writing = $derived(cable?.writing === true);
	const counters = $derived.by(() => {
		// The counters the pre-write checklist shows (simulated mode included): one source.
		void now;
		void cable;
		return app === null ? { session: 0, day: 0, total: 0 } : app.cable.counters();
	});
	const id = $props.id();
	const nodeLabels: Record<DiagramNode, string> = $derived({
		unsupported: m.cabo_state_unsupported(),
		disconnected: m.cabo_state_disconnected(),
		connecting: m.cabo_state_connecting(),
		connected: m.cabo_state_connected(),
		writing: m.cabo_state_writing(),
		written: m.cabo_fux_state_written(),
		interrupted: m.cabo_state_interrupted()
	});
	const regionLabels = {
		header: () => m.cabo_header(),
		preamp: () => m.cabo_preamp(),
		coefficients: () => m.cabo_coefficients(),
		crc: () => m.cabo_crc()
	};

	/** Why an action that needs the engine idle is unavailable, or null. */
	const busyReason = $derived(
		app === null ? m.cabo_fux_loading() : writing ? m.cabo_fux_busy_writing() : null
	);
	const connectReason = $derived(
		busyReason ?? (cable?.connection === 'connecting' ? m.cabo_fux_connecting() : null)
	);
	const switchReason = $derived(
		app === null ? m.cabo_fux_loading() : realMode ? m.cabo_fux_switch_locked() : null
	);
	const reviewReason = $derived(busyReason ?? (coverOpen ? null : m.cabo_fux_review_closed()));

	onMount(() => {
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 30000);
		return () => clearInterval(timer);
	});

	$effect(() => {
		const events = app?.cable.events;
		if (events === undefined) return;
		const listener = (event: Event) => {
			progress = event instanceof CustomEvent ? parseProgress(event.detail) : null;
		};
		events.addEventListener(CABLE_PROGRESS_EVENT, listener);
		return () => events.removeEventListener(CABLE_PROGRESS_EVENT, listener);
	});
	$effect(() => {
		// Progress belongs to one write: outside a write the tape shows the real result.
		if (!writing) progress = null;
	});

	function requestWrite() {
		app?.requestWrite();
		coverOpen = false;
	}

	function loadEntry(entry: JournalEntry) {
		// Loading a journal card is editor-only, including interrupted and simulated entries, but
		// gated: a YOLO entry needs YOLO on in this tab (and the YOLO gate), any other entry the
		// standard gate; none loads below the editor's −25,5 dB preamp floor.
		if (!app) return;
		const decision = loadDecision(entry, app.yolo.enabled);
		if (!decision.load) {
			const message =
				decision.reason === 'preamp-floor'
					? m.yolo_load_preamp_floor()
					: decision.reason === 'yolo-off'
						? m.yolo_load_refused()
						: m.yolo_load_gate_refused();
			app.toasts.push(message, { tone: 'error' });
			return;
		}
		app.state.curve.set({
			name: entry.name,
			source: 'custom',
			bands: entry.bands,
			preampDb: entry.preampDb
		});
		if (decision.profile === 'yolo') app.toasts.push(m.yolo_load_yolo());
	}
</script>

<svelte:head
	><title>{m.cabo_title()} · open-auri</title><meta
		name="description"
		content={m.cabo_intro()}
	/></svelte:head
>

<Tour page="cabo" autoOpen={tourAutoOpen} />

<div class="room">
	<LazyArt load={() => import('#lib/components/art/CaboArt.svelte')} />
	<div class="intro">
		<div>
			<h1>{m.cabo_title()}</h1>
			<p>{m.cabo_intro()}</p>
		</div>
		<div class="intro-side">
			<TourTrigger page="cabo" />
			<p class="meta">CB5100 · USB DSP Audio · 96 kHz<br />{m.cabo_meta()}</p>
		</div>
	</div>
	<div class="rack">
		<div class="rail left" aria-hidden="true"></div>
		<div class="rail right" aria-hidden="true"></div>
		<div class="power">
			<Lamp on={app !== null} />{m.cabo_power()}
		</div>

		<RackUnit number="U1" title={m.cabo_interface()} model="OA-01 · WebHID" silver>
			<div class="interface">
				<div data-tour="cabo-connect">
					<p class="plate">CB5100 · 0xCB · VID 0x3302 · PID 0x8902</p>
					<div class="mode-row">
						<div class="switch-col">
							<span class="legend" aria-hidden="true">{m.cabo_fux_switch_real()}</span>
							<Button
								variant="lever"
								class="mode-switch"
								role="switch"
								aria-checked={realMode || realRequested}
								aria-label={m.cabo_fux_switch_name()}
								data-on={realMode || realRequested}
								disabledReason={switchReason}
								onclick={() => (realRequested = !realRequested)}
							>
								<span class="bat" aria-hidden="true"></span>
							</Button>
							<span class="legend" aria-hidden="true">{m.cabo_fux_switch_sim()}</span>
						</div>
						<Button
							variant="key"
							size="lg"
							class="connect"
							lit={cable?.connection === 'connected'}
							disabledReason={connectReason}
							onclick={() => app?.cable.connect()}
						>
							{realMode ? m.cabo_connect_real() : m.cabo_connect_simulated()}
						</Button>
					</div>
					<p class="mode">{realMode ? m.cabo_real() : m.cabo_simulation()}</p>
					<p class="note">{realMode ? m.cabo_fux_snippet_real() : m.cabo_fux_snippet_sim()}</p>
					<code class="code"
						>navigator.hid.<span class="fn">requestDevice</span
						>{'({ filters: [{ vendorId: 0x3302, productId: 0x8902 }] })'}</code
					>
					<span class="tag-strip">{m.cabo_fux_tag_strip()}</span>
					{#if cable?.device}
						<Button
							variant="plate"
							size="sm"
							class="disconnect"
							disabledReason={writing ? m.cabo_fux_busy_writing() : null}
							onclick={() => app?.cable.disconnect()}>{m.cabo_disconnect()}</Button
						>
					{/if}
				</div>
				<div class="machine">
					<StateDiagram current={node} written={lastWritten(cable)} labels={nodeLabels} />
					<p class="state-readout" role="status">{nodeLabels[node]}</p>
					{#if rackStatus === 'unsupported'}
						<p class="note warn">{m.cabo_fux_unsupported()}</p>
					{/if}
				</div>
				<dl class="readouts">
					<div>
						<dt>{m.cabo_read()}</dt>
						<dd class="lcd">{m.cabo_unknown()}</dd>
					</div>
					<div>
						<dt>{m.cabo_last_write()}</dt>
						<dd class="lcd">{last ? last.name : m.cabo_no_write()}</dd>
					</div>
				</dl>
			</div>
			<p class="note interface-note">{m.cabo_support()}</p>
			{#if cable?.error === 'request-failed' || cable?.error === 'restore-failed'}<p role="status">
					{m.cabo_connection_error()}
				</p>{/if}
		</RackUnit>

		<RackUnit number="U2" title={m.cabo_encoder()} model={m.cabo_regions()}>
			<div class="encoder-top">
				<div class="selector">
					<div class="knob" aria-hidden="true"></div>
					<div>
						<label for={`${id}-preset`}>{m.cabo_presets()}</label>
						<select
							id={`${id}-preset`}
							value={curve.source.startsWith('preset:') ? curve.source.slice(7) : ''}
							disabled={!app || writing}
							aria-disabled={busyReason ? 'true' : undefined}
							aria-describedby={busyReason ? `${id}-preset-why` : undefined}
							onchange={(event) => app?.state.curve.loadPreset(event.currentTarget.value)}
						>
							<option value="" disabled>{m.cabo_custom()}</option>
							{#each Object.values(PRESETS_BY_ID) as preset (preset.id)}<option value={preset.id}
									>{preset.label}</option
								>{/each}
						</select>
						{#if busyReason}
							<p id={`${id}-preset-why`} class="note">{busyReason}</p>
						{/if}
						<p class="curve-label">{m.cabo_current()}</p>
						<h3 class="curve-name">{curve.name}</h3>
						{#if preset && 'description' in preset}
							<p class="description">
								{getLocale() === 'en-US'
									? (preset.descriptionEn ?? preset.description)
									: preset.description}
							</p>
							<p class="credit">{m.cabo_description_credit()} · {m.cabo_preset_license()}</p>
						{/if}
					</div>
				</div>
				<div class="pre-block">
					<span class="legend">{m.cabo_preamp()}</span>
					<output class="readout">{formatNumber(curve.preampDb)} dB</output>
					<p class="small">{m.cabo_fux_preamp_note()}</p>
					<a class="editor-link" href="/">{m.cabo_fux_preamp_editor()}</a>
				</div>
				{#if encoder.ok}<div class="response">
						<ResponseChart
							{curve}
							label={m.cabo_response()}
							description={m.cabo_response_description()}
							locale={getLocale()}
							theme="cable"
						/>
					</div>{/if}
			</div>
			{#if encoder.ok}
				<div data-tour="cabo-bytes">
					<div class="windows">
						{#each encoder.regions as region (region.kind)}
							<figure class="window" class:coefficients={region.kind === 'coefficients'}>
								<figcaption>
									{regionLabels[region.kind]()} <b>{region.bytes.length} B</b>
								</figcaption>
								<textarea
									readonly
									aria-label={regionLabels[region.kind]()}
									value={hexBytes(region.bytes)}
									spellcheck="false"></textarea>
							</figure>
						{/each}
					</div>
					<figure class="sheet">
						<figcaption>{m.cabo_fux_sheet()}</figcaption>
						<span class="tape t1" aria-hidden="true"></span>
						<span class="tape t2" aria-hidden="true"></span>
						<ByteMap {curve} label={m.cabo_byte_map()} description={m.cabo_byte_description()} />
					</figure>
					<p class="crc">
						<span>{m.cabo_crc()} <strong>{formatCrc(encoder.crc)}</strong></span>
						<Explainer term="crc" />
						<Explainer term="q27" />
						<Explainer term="q23" />
					</p>
				</div>
			{:else}<p role="status">{m.cabo_invalid()}</p>{/if}
		</RackUnit>

		<RackUnit
			number="U3"
			title={m.cabo_calibration()}
			model={m.cabo_gate_model()}
			silver
			anchor="cabo-calibracao"
		>
			{#snippet aside()}<Explainer term="checklist" />{/snippet}
			<p class="note lead">{m.cabo_fux_calibration_note()}</p>
			<div class="calibration" data-tour="cabo-checklist">
				<div class="cal-vu">
					<LevelGauge levelDb={checklist?.newLevelDb ?? null} />
				</div>
				<div class="cal-gate">
					<div class="sub-head">
						<span class="legend">{m.cable_checklist_gate_heading()}</span>
						<Explainer term="gate" />
					</div>
					<CriteriaList {lamps} {values} label={m.cable_fux_criteria_label()} />
					<p class="note small">{m.cabo_gate_note()}</p>
				</div>
				<div class="cal-act">
					<LoudnessPanel
						loudness={checklist?.loudness ?? null}
						newLevelDb={checklist?.newLevelDb ?? null}
					/>
					<p class="note small">{m.cabo_checklist_hint()}</p>
					<div class="guard" class:open={coverOpen}>
						<Button
							variant="plate"
							class="cover"
							aria-expanded={coverOpen}
							aria-controls={`${id}-review`}
							disabledReason={busyReason}
							onclick={() => (coverOpen = !coverOpen)}
							>{coverOpen ? m.cabo_close_cover() : m.cabo_lift()}</Button
						>
						<Button
							id={`${id}-review`}
							variant="primary"
							class="review"
							disabledReason={reviewReason}
							onclick={requestWrite}>{m.cabo_review_write()}</Button
						>
					</div>
				</div>
			</div>
		</RackUnit>

		<RackUnit number="U4" title={m.cabo_transport()} model={m.cabo_timing()}>
			<div data-tour="cabo-tape">
				{#if encoder.ok}<Deferred module={transportTape} height="14rem">
						{#snippet children(TransportTape)}<TransportTape
								{curve}
								outcome={cable?.lastOutcome ?? null}
								{writing}
								{progress}
							/>{/snippet}
					</Deferred>{:else}<p>
						{m.cabo_invalid()}
					</p>{/if}
			</div>
		</RackUnit>
		<div class="vent" aria-hidden="true"></div>
		<RackUnit number="U5" title={m.cabo_journal()} model={m.cabo_journal_model()}>
			<div data-tour="cabo-journal">
				<Deferred module={journal} height="18rem">
					{#snippet children(Journal)}
						<Journal {entries} onload={app === null ? undefined : loadEntry} />
					{/snippet}
				</Deferred>
				<Deferred module={socialStatus} height="2.5rem">
					{#snippet children(SocialStatus)}
						<SocialStatus {entries} {signedIn} />
					{/snippet}
				</Deferred>
			</div>
		</RackUnit>
		<RackUnit number="U6" title={m.cabo_counters()} model={m.cabo_flash_model()} silver>
			{#snippet aside()}<Explainer term="flash" />{/snippet}
			<Deferred module={flashCounters} height="6rem">
				{#snippet children(FlashCounters)}
					<FlashCounters {counters} />
				{/snippet}
			</Deferred>
		</RackUnit>
		<RackUnit number="U7" title={m.cabo_multi()} model={m.cabo_multi_model()}>
			<Deferred module={cableList} height="6rem">
				{#snippet children(CableList)}
					<CableList {cable} />
				{/snippet}
			</Deferred>
			<div class="multi-actions">
				<Button variant="key" disabledReason={connectReason} onclick={() => app?.cable.connect()}
					>{m.cabo_add()}</Button
				>
				<Button variant="primary" disabledReason={busyReason} onclick={requestWrite}
					>{m.cabo_queue_review()}</Button
				>
			</div>
		</RackUnit>
		<RackUnit number="U8" title={m.cabo_soon()} model={m.cabo_reserved()} silver>
			<div class="slots">
				<EmBreve title={m.cabo_read()} /><EmBreve title={m.cabo_firmware()} />
				<EmBreve title={m.cabo_ram()} /><EmBreve title={m.cabo_blind()} />
			</div>
		</RackUnit>
	</div>
</div>

<style>
	.room {
		--cabo-accent: #4fd1c5;
		position: relative;
		isolation: isolate;
		padding: 26px 22px 56px;
		color: #ece7dd;
		background: radial-gradient(ellipse at 15% 0, #22302e, #0d0f0f 55%, #060707);
		font: 400 var(--fs-ui, 14px) / 1.5 var(--face-body, 'Geist', sans-serif);
	}
	.intro {
		max-width: 1380px;
		margin: 0 auto 24px;
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 24px;
	}
	h1 {
		margin: 0;
		font: italic 400 var(--fs-display-l, 66px) / 0.95
			var(--face-display, 'Instrument Serif', Georgia, serif);
		letter-spacing: -0.03em;
	}
	.intro p {
		max-width: 640px;
		margin: 10px 0 0;
		color: #b8b3a9;
	}
	.intro-side {
		display: grid;
		justify-items: end;
		gap: 10px;
	}
	.intro .meta {
		margin: 0;
		font: 400 var(--label-min, 11px) / 1.8 var(--face-data, 'JetBrains Mono', monospace);
		text-align: right;
	}
	.rack {
		position: relative;
		max-width: 1380px;
		margin: auto;
		padding: 12px 0;
		background: #040505;
		border-radius: 6px;
		box-shadow:
			0 0 0 1px #000,
			0 0 0 9px #161819,
			0 0 0 10px #2b2e2f,
			0 40px 80px #000d;
	}
	.rail {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 48px;
		background: linear-gradient(90deg, #0c0d0e, #2a2d2f 35%, #1a1c1d 70%, #090a0a);
	}
	.rail::before {
		content: '';
		position: absolute;
		left: 18px;
		width: 12px;
		top: 6px;
		bottom: 6px;
		background: repeating-linear-gradient(#000 0 10px, transparent 10px 14.8px);
	}
	.left {
		left: 0;
	}
	.right {
		right: 0;
	}
	.power {
		position: relative;
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 14px 80px;
		margin-bottom: 5px;
		background: linear-gradient(#242628, #141617);
		font: 600 var(--fs-caption, 12px) var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.legend,
	label {
		font: 600 var(--fs-caption, 12px) / 1.3 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.note {
		font-size: var(--fs-small, 13px);
		line-height: 1.55;
	}
	.small {
		font-size: var(--fs-caption, 12px);
	}
	.lead {
		margin: 0 0 14px;
	}
	/* U1 */
	.interface {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.45fr) minmax(0, 0.9fr);
		gap: 28px;
		align-items: start;
	}
	.plate {
		display: inline-block;
		margin: 0;
		padding: 9px 13px;
		border-radius: 2px;
		background: linear-gradient(#1f2122, #111213);
		color: #e8ece7;
		font: 600 var(--fs-ui, 14px) / 1.6 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.12em;
		box-shadow:
			inset 0 1px 0 #ffffff1f,
			0 1px 0 #ffffffa8;
	}
	.mode-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 18px;
		margin: 16px 0 10px;
	}
	.switch-col {
		display: grid;
		justify-items: center;
		gap: 4px;
	}
	.switch-col :global(.mode-switch) {
		width: 40px;
		height: 54px;
		min-height: 0;
		padding: 0;
		border-radius: 50%;
		--btn-bg: radial-gradient(circle at 35% 30%, #fafbf9, #a3a7a3 50%, #555955);
	}
	.switch-col :global(.mode-switch[aria-disabled='true']) {
		--btn-bg: radial-gradient(circle at 35% 30%, #e1e3e0, #8f938f 55%, #4b4f4c);
		--btn-border: #0000008c;
	}
	.bat {
		display: block;
		width: 8px;
		height: 24px;
		margin: 0 auto;
		border-radius: 4px;
		background: linear-gradient(90deg, #7c807d, #f4f5f3 45%, #8b8f8c);
		box-shadow: 2px 2px 3px #0008;
		transform-origin: 4px 2px;
		transform: translateY(10px) rotate(180deg);
		transition: transform var(--dur-base, 0.2s) var(--ease-mech, cubic-bezier(0.3, 1.4, 0.5, 1));
	}
	.switch-col :global(.mode-switch[data-on='true'] .bat) {
		transform: translateY(10px) rotate(0deg);
	}
	.mode-row :global(.connect) {
		min-width: 190px;
	}
	.mode {
		margin: 0 0 6px;
		font: 600 var(--fs-caption, 12px) / 1.5 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.06em;
	}
	.code {
		display: block;
		margin-top: 6px;
		padding: 7px 9px;
		border-radius: 3px;
		background: #101213;
		color: #9fe9e1;
		font: 400 var(--fs-caption, 12px) / 1.5 var(--face-data, 'JetBrains Mono', monospace);
		overflow-wrap: anywhere;
		box-shadow: inset 0 1px 3px #000;
	}
	.fn {
		color: #ffd08a;
	}
	.tag-strip {
		display: block;
		margin: 6px 0 10px;
		padding: 6px 10px;
		border-radius: 2px;
		background: linear-gradient(180deg, #1f2122, #111213);
		color: #e3e7e2;
		font: 600 var(--fs-caption, 12px) / 1.35 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		box-shadow:
			inset 0 1px 0 #ffffff1f,
			0 1px 0 #ffffffa8;
	}
	.machine {
		min-width: 0;
	}
	.state-readout {
		margin: 8px 0 0;
		font: 400 var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
	}
	.warn {
		padding: 8px 10px;
		border-radius: 3px;
		background: #0000000d;
		box-shadow: inset 3px 0 0 #a3262c;
		color: #4a1013;
	}
	.readouts {
		margin: 0;
		display: grid;
		gap: 12px;
		align-content: start;
		font: 600 var(--fs-caption, 12px) / 1.5 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.lcd {
		margin: 5px 0 0;
		padding: 6px 8px;
		color: #a6f6ed;
		background: #0b1312;
		border-radius: 2px;
		overflow-wrap: anywhere;
		font: 400 var(--label-min, 11px) / 1.5 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0;
		text-transform: none;
	}
	.interface-note {
		border-top: 1px solid #0003;
		margin: 18px 0 0;
		padding-top: 12px;
	}
	/* U2 */
	.encoder-top {
		display: grid;
		grid-template-columns: minmax(0, 1.3fr) 220px minmax(0, 1fr);
		gap: 24px;
		align-items: center;
	}
	.selector {
		display: flex;
		align-items: center;
		gap: 20px;
		min-width: 0;
	}
	.selector > div:last-child {
		min-width: 0;
	}
	.knob {
		position: relative;
		flex: none;
		width: 96px;
		height: 96px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #53585b, #141516 70%);
		box-shadow:
			0 7px 11px #000c,
			inset 0 1px #ffffff33,
			0 0 0 4px #0c0d0e;
	}
	.knob::after {
		content: '';
		position: absolute;
		left: 46px;
		top: 5px;
		width: 4px;
		height: 22px;
		border-radius: 2px;
		background: #4fd1c5;
		transform: rotate(-40deg);
		transform-origin: 2px 43px;
	}
	select {
		display: block;
		max-width: 100%;
		width: 260px;
		min-height: var(--hit, 36px);
		margin-top: 7px;
		padding: 7px 10px;
		background: #0d0f0f;
		color: #e8ece8;
		border: 1px solid #6f7973;
		border-radius: 3px;
		font: 400 var(--fs-small, 13px) var(--face-body, 'Geist', sans-serif);
	}
	select:disabled {
		cursor: not-allowed;
	}
	.curve-label {
		margin: 10px 0 0;
		color: #b6bdb7;
		font-size: var(--label-min, 11px);
	}
	.curve-name {
		margin: 4px 0;
		font: 600 32px/1.05 var(--cond, 'Barlow Condensed', sans-serif);
		overflow-wrap: anywhere;
	}
	.description,
	.credit {
		color: #b6bdb7;
		font-size: var(--fs-caption, 12px);
	}
	.pre-block {
		display: grid;
		gap: 7px;
		justify-items: start;
	}
	.pre-block .small {
		margin: 0;
		color: #b6bdb7;
	}
	.readout {
		display: block;
		min-width: 130px;
		padding: 6px 10px;
		background: #071010;
		border: 1px solid #000;
		color: #8ff0e6;
		font: 500 20px var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
		text-align: right;
		border-radius: 3px;
		box-shadow: inset 0 2px 5px #000;
	}
	.editor-link {
		color: #8fe9df;
		font-size: var(--fs-small, 13px);
		text-underline-offset: 4px;
	}
	.response {
		min-width: 0;
		padding: 6px;
		background: #050707;
		border-radius: 6px;
	}
	.windows {
		display: grid;
		grid-template-columns: 1.2fr 0.95fr 3.4fr 0.85fr;
		gap: 12px;
		margin-top: 20px;
	}
	.window {
		min-width: 0;
		margin: 0;
		padding: 7px;
		background: #090b0b;
		border-radius: 5px;
		box-shadow: inset 0 2px 6px #000;
	}
	.window figcaption {
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 6px;
		font: 600 var(--label-min, 11px) / 1.3 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.window b {
		color: #8fe9df;
	}
	.window textarea {
		box-sizing: border-box;
		width: 100%;
		height: 120px;
		border: 0;
		border-radius: 2px;
		resize: vertical;
		overflow: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		padding: 8px;
		margin: 6px 0 0;
		background: radial-gradient(ellipse at 50% 40%, #11403c, #061413 72%);
		color: #a6f6ed;
		font: 500 var(--fs-caption, 12px) / 19px var(--face-data, 'JetBrains Mono', monospace);
	}
	/* The byte map is a reference sheet taped to the rack, not another page. */
	.sheet {
		position: relative;
		margin: 26px 6px 0;
		padding: 22px 16px 12px;
		border-radius: 2px;
		color: #202723;
		background:
			repeating-linear-gradient(180deg, transparent 0 23px, #6f8fb024 23px 24px),
			linear-gradient(#f3ead2, #e6dcc0);
		box-shadow:
			0 2px 0 #b8ab8b,
			0 14px 22px #000b;
		transform: rotate(-0.25deg);
	}
	.sheet figcaption {
		margin-bottom: 8px;
		font: 600 var(--fs-caption, 12px) var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: #4a4436;
	}
	.tape {
		position: absolute;
		top: -10px;
		width: 92px;
		height: 24px;
		background: linear-gradient(180deg, #efe3a8d9, #d9cb87cc);
		box-shadow: 0 1px 2px #0005;
		opacity: 0.92;
	}
	.t1 {
		left: 18px;
		transform: rotate(-4deg);
	}
	.t2 {
		right: 18px;
		transform: rotate(5deg);
	}
	.crc {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		gap: 8px;
		margin: 14px 0 0;
		color: #b6bdb7;
		font: 400 var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
	}
	.crc strong {
		color: #a6f6ed;
		font-size: 18px;
		font-weight: 500;
	}
	/* U3 */
	.calibration {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 0.95fr);
		gap: 26px;
		align-items: start;
	}
	.cal-gate,
	.cal-act {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.cal-gate .note,
	.cal-act .note {
		margin: 0;
		color: #2f3335;
	}
	.sub-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.guard {
		position: relative;
		width: 100%;
		max-width: 280px;
		margin: 8px auto 0;
		padding: 62px 14px 18px;
		background: linear-gradient(#2a2d2f, #121314);
		border-radius: 8px;
		box-shadow:
			inset 0 2px 5px #000,
			0 1px #ffffffb0;
	}
	.guard :global(.review) {
		width: 100%;
	}
	.guard :global(.cover) {
		position: absolute;
		z-index: 2;
		inset: 0;
		height: auto;
		border-radius: 9px;
		--btn-bg: linear-gradient(#74dacfef, #123f3bf5);
		--btn-fg: #effffd;
		--btn-border: #0b3b37;
		transition: inset var(--dur-slow, 0.36s) var(--ease-mech, cubic-bezier(0.3, 1.4, 0.5, 1));
	}
	.guard.open :global(.cover) {
		bottom: calc(100% - 46px);
	}
	.vent {
		position: relative;
		height: 46px;
		background:
			radial-gradient(circle, #000 0 2.6px, transparent 3.2px) 80px 0/12px 13px,
			#1a1c1d;
		margin-bottom: 5px;
	}
	.multi-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		margin: 14px 0 0;
	}
	.slots {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 14px;
	}
	@media (max-width: 1180px) {
		.interface,
		.encoder-top,
		.calibration {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}
		.machine {
			grid-column: 1 / -1;
			order: -1;
		}
		.response {
			grid-column: 1 / -1;
			max-width: 500px;
		}
		.cal-vu {
			grid-column: 1 / -1;
			max-width: 520px;
		}
		.windows {
			grid-template-columns: 1fr 1fr 1fr;
		}
		.coefficients {
			grid-column: 1 / -1;
			order: 5;
		}
		.slots {
			grid-template-columns: 1fr 1fr;
		}
	}
	@media (max-width: 820px) {
		.room {
			padding: 24px 12px 40px;
		}
		.intro {
			flex-direction: column;
			align-items: flex-start;
			gap: 8px;
		}
		.intro-side {
			justify-items: start;
		}
		h1 {
			font-size: 52px;
		}
		.intro .meta {
			text-align: left;
		}
		.rail {
			width: 28px;
		}
		.rail::before {
			left: 9px;
			width: 10px;
		}
		.power {
			padding: 14px 32px;
		}
		.interface,
		.encoder-top,
		.calibration {
			grid-template-columns: minmax(0, 1fr);
		}
		.selector {
			flex-wrap: wrap;
		}
		.windows {
			grid-template-columns: 1fr 1fr;
		}
		.crc {
			justify-content: flex-start;
		}
		.slots {
			grid-template-columns: 1fr;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bat,
		.guard :global(.cover) {
			transition: none;
		}
	}
</style>
