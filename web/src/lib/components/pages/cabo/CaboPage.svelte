<script lang="ts">
	import '@fontsource/barlow-condensed/500.css';
	import '@fontsource/barlow-condensed/600.css';
	import '@fontsource/barlow-condensed/700.css';
	import { onMount } from 'svelte';
	import { PRESETS_BY_ID } from 'open-auri/catalog';
	import { isExperimentalKind } from 'open-auri/safety';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { JournalEntry } from '#lib/cable/types.ts';
	import { neutralCurve } from '#lib/state/model.ts';
	import { ByteMap, ResponseChart, hexBytes } from '#lib/charts/index.ts';
	import { EmBreve } from '#lib/components/chrome/index.ts';
	import {
		MultiCableQueue,
		describeReason,
		formatCrc,
		formatNumber,
		lampLabel,
		lampState
	} from '#lib/components/cable/index.ts';
	import { VuMeter } from '#lib/components/meters/index.ts';
	import RackUnit from './RackUnit.svelte';
	import TransportTape from './TransportTape.svelte';
	import Journal from './Journal.svelte';
	import FlashCounters from './FlashCounters.svelte';
	import SocialStatus from './SocialStatus.svelte';
	import { encoderData, rackState, RACK_STATES, type RackState } from './model.ts';

	let {
		app,
		signedIn = false
	}: {
		app: ClientApp | null;
		/** T4.16: shows "instalada" for a community curve; never affects writing. */
		signedIn?: boolean;
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
	const checklist = $derived.by(() => {
		// The shared checklist owns gate, loudness and confirmation logic. Only read its result here.
		void cable;
		return (
			app?.cable.checklist({
				bands: curve.bands,
				preampDb: curve.preampDb,
				experimental,
				confirmations: unconfirmed
			}) ?? null
		);
	});
	// Wall clock for the local-day rollover of the counters; refreshed every 30 s after mount.
	let now = $state(Date.now());
	let realRequested = $state(false);
	let coverOpen = $state(false);
	const rackStatus = $derived(rackState(cable, realRequested));
	const counters = $derived.by(() => {
		// The counters the pre-write checklist shows (simulated mode included): one source.
		void now;
		void cable;
		return app === null ? { session: 0, day: 0, total: 0 } : app.cable.counters();
	});
	const id = $props.id();
	const stateLabels: Record<RackState, () => string> = {
		unsupported: () => m.cabo_state_unsupported(),
		simulated: () => m.cabo_state_simulated(),
		disconnected: () => m.cabo_state_disconnected(),
		connecting: () => m.cabo_state_connecting(),
		connected: () => m.cabo_state_connected(),
		writing: () => m.cabo_state_writing(),
		interrupted: () => m.cabo_state_interrupted()
	};
	const regionLabels = {
		header: () => m.cabo_header(),
		preamp: () => m.cabo_preamp(),
		coefficients: () => m.cabo_coefficients(),
		crc: () => m.cabo_crc()
	};

	onMount(() => {
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 30000);
		return () => clearInterval(timer);
	});

	function requestWrite() {
		app?.requestWrite();
		coverOpen = false;
	}

	function loadEntry(entry: JournalEntry) {
		// Loading a journal card is editor-only, including interrupted and simulated entries.
		app?.state.curve.set({
			name: entry.name,
			source: 'custom',
			bands: entry.bands,
			preampDb: entry.preampDb
		});
	}
</script>

<svelte:head
	><title>{m.cabo_title()} · open-auri</title><meta
		name="description"
		content={m.cabo_intro()}
	/></svelte:head
>

<div class="room">
	<div class="intro">
		<div>
			<h1>{m.cabo_title()}</h1>
			<p>{m.cabo_intro()}</p>
		</div>
		<p class="meta">CB5100 · USB DSP Audio · 96 kHz<br />{m.cabo_meta()}</p>
	</div>
	<div class="rack">
		<div class="rail left" aria-hidden="true"></div>
		<div class="rail right" aria-hidden="true"></div>
		<div class="power">
			<span class="lamp" class:on={app !== null} aria-hidden="true"></span>{m.cabo_power()}
		</div>

		<RackUnit number="U1" title={m.cabo_interface()} model="OA-01 · WebHID" silver>
			<div class="interface">
				<div>
					<p class="plate">CB5100 · 0xCB<br />VID 0x3302 · PID 0x8902</p>
					<p class="mode">{cable?.mode === 'real' ? m.cabo_real() : m.cabo_simulation()}</p>
					<button
						class="key teal"
						type="button"
						disabled={!app || cable?.writing || cable?.connection === 'connecting'}
						onclick={() => app?.cable.connect()}
					>
						{cable?.mode === 'real' ? m.cabo_connect_real() : m.cabo_connect_simulated()}
					</button>
					{#if cable?.mode === 'simulated'}
						<button
							class="text-button"
							type="button"
							onclick={() => (realRequested = !realRequested)}
							aria-pressed={realRequested}>{m.cabo_try_real()}</button
						>
					{/if}
					{#if cable?.device}
						<button
							class="text-button"
							type="button"
							disabled={cable.writing}
							onclick={() => app?.cable.disconnect()}>{m.cabo_disconnect()}</button
						>
					{/if}
				</div>
				<div class="machine">
					<ol aria-label={m.cabo_state_machine()}>
						{#each RACK_STATES as item (item)}
							<li data-state={item} aria-current={rackStatus === item ? 'step' : undefined}>
								<span
									class="lamp"
									class:on={rackStatus === item}
									class:error={item === 'interrupted' || item === 'unsupported'}
									aria-hidden="true"
								></span>
								<span>{stateLabels[item]()}</span>
								{#if rackStatus === item}<span class="state-marker" aria-hidden="true">●</span>{/if}
							</li>
						{/each}
					</ol>
					<p class="state-readout" role="status">{stateLabels[rackStatus]()}</p>
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
							disabled={!app || cable?.writing}
							onchange={(event) => app?.state.curve.loadPreset(event.currentTarget.value)}
						>
							<option value="" disabled>{m.cabo_custom()}</option>
							{#each Object.values(PRESETS_BY_ID) as preset (preset.id)}<option value={preset.id}
									>{preset.label}</option
								>{/each}
						</select>
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
				<div>
					<span class="legend">{m.cabo_preamp()}</span><output class="readout"
						>{formatNumber(curve.preampDb)} dB</output
					>
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
				<div class="windows">
					{#each encoder.regions as region (region.kind)}
						<figure class="window" class:coefficients={region.kind === 'coefficients'}>
							<figcaption>{regionLabels[region.kind]()} <b>{region.bytes.length} B</b></figcaption>
							<textarea
								readonly
								aria-label={regionLabels[region.kind]()}
								value={hexBytes(region.bytes)}
								spellcheck="false"></textarea>
						</figure>
					{/each}
				</div>
				<div class="byte-map">
					<ByteMap {curve} label={m.cabo_byte_map()} description={m.cabo_byte_description()} />
				</div>
				<p class="crc">{m.cabo_crc()} <strong>{formatCrc(encoder.crc)}</strong></p>
			{:else}<p role="status">{m.cabo_invalid()}</p>{/if}
		</RackUnit>

		<RackUnit number="U3" title={m.cabo_calibration()} model={m.cabo_gate_model()} silver>
			<div class="calibration">
				<div>
					<div class="vu">
						<VuMeter mode="data" data={checklist?.newLevelDb ?? null} label="Δ dB" />
					</div>
					<p class="legend">{m.cabo_data()}</p>
					<p class="note">
						{m.cabo_level()}:
						<strong
							>{checklist?.newLevelDb == null
								? '∅'
								: `${formatNumber(checklist.newLevelDb)} dB`}</strong
						>
					</p>
				</div>
				<div>
					<ul class="checks">
						{#each checklist?.lamps ?? [] as lamp (lamp.id)}
							<li data-state={lamp.state}>
								<span class="check-title"
									><b>{lamp.id}</b>
									{lampLabel[lamp.labelKey]()} <span>{lampState[lamp.state]()}</span></span
								>
								{#each lamp.reasons as reason, index (index)}<p>{describeReason(reason)}</p>{/each}
							</li>
						{/each}
					</ul>
					<p class="note">{m.cabo_gate_note()}</p>
				</div>
				<div>
					<p class="note">{m.cabo_checklist_hint()}</p>
					<div class="guard" class:open={coverOpen}>
						<button
							class="cover"
							type="button"
							aria-expanded={coverOpen}
							aria-controls={`${id}-review`}
							disabled={!app || cable?.writing}
							onclick={() => (coverOpen = !coverOpen)}
							>{coverOpen ? m.cabo_close_cover() : m.cabo_lift()}</button
						>
						<button
							id={`${id}-review`}
							class="key teal"
							type="button"
							disabled={!coverOpen || !app || cable?.writing}
							onclick={requestWrite}
							><span class="lever" aria-hidden="true"></span>{m.cabo_review_write()}</button
						>
					</div>
				</div>
			</div>
		</RackUnit>

		<RackUnit number="U4" title={m.cabo_transport()} model={m.cabo_timing()}>
			{#if encoder.ok}<TransportTape {curve} outcome={cable?.lastOutcome ?? null} />{:else}<p>
					{m.cabo_invalid()}
				</p>{/if}
		</RackUnit>
		<div class="vent" aria-hidden="true"></div>
		<RackUnit number="U5" title={m.cabo_journal()} model={m.cabo_journal_model()}>
			<Journal {entries} onload={app === null ? undefined : loadEntry} />
			<SocialStatus {entries} {signedIn} />
		</RackUnit>
		<RackUnit number="U6" title={m.cabo_counters()} model={m.cabo_flash_model()} silver>
			<FlashCounters {counters} />
		</RackUnit>
		<RackUnit number="U7" title={m.cabo_multi()} model={m.cabo_multi_model()}>
			<p class="note">{m.cabo_multi_hint()}</p>
			<div class="multi-actions">
				<button
					class="key"
					type="button"
					disabled={!app || cable?.writing || cable?.connection === 'connecting'}
					onclick={() => app?.cable.connect()}>{m.cabo_add()}</button
				>
				<button
					class="key teal"
					type="button"
					disabled={!app || cable?.writing}
					onclick={requestWrite}>{m.cabo_queue_review()}</button
				>
			</div>
			{#if app}
				<!-- Display/selection only here. Authorization and the active queue live in the layout checklist. -->
				<MultiCableQueue
					service={app.cable}
					bands={curve.bands}
					preampDb={curve.preampDb}
					{experimental}
					confirmations={unconfirmed}
					canWrite={false}
					name={curve.name}
				/>
			{/if}
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
		padding: 26px 22px 56px;
		color: #ece7dd;
		background: radial-gradient(ellipse at 15% 0, #22302e, #0d0f0f 55%, #060707);
		font: 14px/1.5 var(--ui, 'Geist', sans-serif);
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
		font:
			italic 66px/0.95 'Instrument Serif',
			Georgia,
			serif;
		letter-spacing: -0.03em;
	}
	.intro p {
		max-width: 640px;
		margin: 10px 0 0;
		color: #b8b3a9;
	}
	.intro .meta {
		font: 11px/1.8 var(--mono, monospace);
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
		font:
			600 12px 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.lamp {
		display: inline-block;
		flex: none;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #56625f, #111615 70%);
		box-shadow:
			0 0 0 2px #0b0c0c,
			0 0 0 3.5px #8d918d;
	}
	.lamp.on {
		background: radial-gradient(circle at 35% 30%, #f1fffd, #86e8de 25%, #4fd1c5 52%, #1b7f76);
		box-shadow:
			0 0 0 2px #0b0c0c,
			0 0 0 3.5px #8d918d,
			0 0 12px #4fd1c5aa;
	}
	.lamp.error.on {
		background: #d52e36;
		box-shadow:
			0 0 0 2px #0b0c0c,
			0 0 0 3.5px #8d918d;
	}
	.interface {
		display: grid;
		grid-template-columns: 1fr 1.35fr 1fr;
		gap: 28px;
	}
	.plate {
		display: inline-block;
		margin: 0;
		padding: 9px 13px;
		border-radius: 2px;
		background: linear-gradient(#1f2122, #111213);
		color: #e8ece7;
		font:
			600 14px/1.6 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.1em;
	}
	.mode {
		min-height: 3em;
		font:
			600 12px/1.5 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.05em;
	}
	.key {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		min-height: 40px;
		padding: 8px 14px;
		border: 1px solid #000;
		border-radius: 3px;
		background: linear-gradient(#3b3e40, #1c1e1f);
		color: #e9ece8;
		font:
			600 13px 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.1em;
		box-shadow:
			0 3px #000,
			inset 0 1px #ffffff2a;
	}
	.teal {
		background: linear-gradient(#68e3d8, #2aa79c);
		color: #062321;
		border-color: #0d3a36;
	}
	.text-button {
		display: block;
		min-height: 36px;
		padding: 6px 0;
		margin-top: 8px;
		border: 0;
		color: inherit;
		background: none;
		text-align: left;
		text-decoration: underline;
		text-underline-offset: 3px;
		font-size: 12px;
	}
	.machine ol {
		list-style: none;
		margin: 0;
		padding: 12px 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}
	.machine li {
		display: flex;
		align-items: center;
		gap: 10px;
		font:
			600 12px/1.3 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.state-marker {
		margin-left: auto;
		font-size: 8px;
	}
	.state-readout {
		font: 12px var(--mono, monospace);
	}
	.readouts {
		margin: 0;
		display: grid;
		gap: 12px;
		align-content: start;
		font:
			600 12px/1.5 'Barlow Condensed',
			sans-serif;
	}
	.lcd {
		margin: 5px 0 0;
		padding: 6px 8px;
		color: #a6f6ed;
		background: #0b1312;
		border-radius: 2px;
		overflow-wrap: anywhere;
		font: 11px/1.5 var(--mono, monospace);
	}
	.note {
		font-size: 12.5px;
		line-height: 1.55;
	}
	.interface-note {
		border-top: 1px solid #0003;
		margin: 18px 0 0;
		padding-top: 12px;
	}
	.encoder-top {
		display: grid;
		grid-template-columns: 1.3fr 180px 1fr;
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
		left: 48px;
		top: 5px;
		width: 4px;
		height: 22px;
		border-radius: 2px;
		background: #4fd1c5;
		transform: rotate(-40deg);
		transform-origin: 0 43px;
	}
	label,
	.legend {
		font:
			600 12px/1.4 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	select {
		display: block;
		max-width: 100%;
		width: 250px;
		margin-top: 7px;
		padding: 7px 10px;
		background: #0d0f0f;
		color: #e8ece8;
		border: 1px solid #6f7973;
		border-radius: 3px;
		font: 13px var(--ui, sans-serif);
	}
	.curve-label {
		margin: 10px 0 0;
		color: #b6bdb7;
		font-size: 11px;
	}
	.curve-name {
		margin: 4px 0;
		font:
			600 32px/1.05 'Barlow Condensed',
			sans-serif;
		overflow-wrap: anywhere;
	}
	.description {
		color: #b6bdb7;
		font-size: 12.5px;
	}
	.credit {
		color: #b6bdb7;
		font-size: 11px;
	}
	.readout {
		display: block;
		padding: 6px 10px;
		margin-top: 7px;
		background: #071010;
		border: 1px solid #000;
		color: #8ff0e6;
		font: 500 20px var(--mono, monospace);
		text-align: right;
		border-radius: 3px;
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
		font:
			600 11px/1.3 'Barlow Condensed',
			sans-serif;
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
		font: 500 12px/19px var(--mono, monospace);
	}
	.byte-map {
		background: #c9ccc7;
		color: #202723;
		border-radius: 3px;
		margin-top: 16px;
	}
	.crc {
		text-align: right;
		color: #b6bdb7;
		font: 12px var(--mono, monospace);
	}
	.crc strong {
		color: #a6f6ed;
		font-size: 18px;
	}
	.calibration {
		display: grid;
		grid-template-columns: 1fr 1.1fr 0.9fr;
		gap: 26px;
		align-items: start;
	}
	.vu {
		padding: 16px 10px 8px;
		background: linear-gradient(150deg, #f7ebc7, #d6c79e);
		border: 12px solid #202324;
		border-radius: 12px;
		color: #2a2822;
		box-shadow: 0 9px 16px #0006;
		text-align: center;
	}
	.checks {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.checks li {
		padding: 7px 10px;
		background: linear-gradient(#0000000f, #ffffff26);
		box-shadow:
			inset 0 1px 2px #0003,
			0 1px #ffffff80;
		border-radius: 3px;
	}
	.check-title {
		display: flex;
		gap: 8px;
		align-items: center;
		font:
			600 12px/1.3 'Barlow Condensed',
			sans-serif;
	}
	.check-title > span {
		margin-left: auto;
	}
	.checks p {
		margin: 6px 0 0;
		color: #761115;
		font-size: 12px;
	}
	.checks [data-state='fail'] {
		border-left: 3px solid #a22028;
	}
	.guard {
		position: relative;
		padding: 62px 14px 20px;
		margin: 24px auto 0;
		max-width: 260px;
		background: linear-gradient(#2a2d2f, #121314);
		border-radius: 8px;
		box-shadow:
			inset 0 2px 5px #000,
			0 1px #ffffffb0;
	}
	.guard .key {
		width: 100%;
		flex-direction: column;
	}
	.lever {
		display: block;
		width: 10px;
		height: 35px;
		border-radius: 5px;
		background: linear-gradient(90deg, #7c807d, #f4f5f3 45%, #8b8f8c);
		box-shadow: 2px 2px 3px #0008;
		transform: rotate(15deg);
	}
	.cover {
		position: absolute;
		z-index: 2;
		inset: 0;
		border: 1px solid #0b3b37;
		border-radius: 9px;
		background: linear-gradient(#74dacfef, #123f3bf5);
		color: #effffd;
		padding: 16px;
		font:
			700 13px 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.12em;
		cursor: pointer;
		transition: inset 0.2s;
	}
	.guard.open .cover {
		bottom: calc(100% - 45px);
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
		margin: 14px 0 20px;
	}
	.slots {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 14px;
	}
	button:disabled,
	select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 4px;
	}
	@media (max-width: 1180px) {
		.interface,
		.encoder-top,
		.calibration {
			grid-template-columns: 1fr 1fr;
		}
		.machine {
			grid-column: 1 / -1;
			order: -1;
		}
		.machine ol {
			grid-template-columns: repeat(4, 1fr);
		}
		.response {
			grid-column: 1 / -1;
			max-width: 500px;
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
			grid-template-columns: 1fr;
		}
		.machine ol {
			grid-template-columns: 1fr 1fr;
		}
		.selector {
			flex-wrap: wrap;
		}
		.windows {
			grid-template-columns: 1fr 1fr;
		}
		.crc {
			text-align: left;
		}
		.slots {
			grid-template-columns: 1fr;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.cover {
			transition: none;
		}
	}
</style>
