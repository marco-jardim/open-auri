<script lang="ts">
	import { onMount } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { createAutoEqClient, searchEntries, type AutoEqEntry } from '#lib/data/autoeq.ts';
	import { createSolverWorker } from '#lib/workers/solver-client.ts';
	import { OFFICIAL_PRESETS, PADRAO_AURI } from 'open-auri/catalog';
	import { curveResponseDb, GRID } from 'open-auri/dsp';
	import { normalize } from 'open-auri/io';
	import { numberLabel } from '#lib/charts/scales.ts';
	import { WiggleTrace } from '#lib/charts/index.ts';
	import type { AudioEngine } from '#lib/audio/engine.ts';
	import type { VuReference } from '#lib/audio/meters.ts';
	import type { CurveData } from '#lib/state/model.ts';
	import Attribution from './Attribution.svelte';
	import CsvImport from './CsvImport.svelte';
	import TargetEditor from './TargetEditor.svelte';
	import TracePlot from './TracePlot.svelte';
	import Preview from './Preview.svelte';
	import {
		autoEqTrace,
		drawnTarget,
		initialStation,
		INITIAL_POINTS,
		presetTarget,
		resultCurve,
		solveStation,
		stationTransition,
		type AutoEqClient,
		type Controls,
		type SolverPort,
		type StationEvent,
		type StationState,
		type TargetPoint,
		type Trace
	} from './model.ts';

	interface PageSolver extends SolverPort {
		cancel(): void;
		dispose(): void;
	}
	let {
		current = null,
		audio = null,
		reference = -18,
		onuse = () => false,
		dataClient = createAutoEqClient(),
		solverFactory = createSolverWorker
	}: {
		current?: CurveData | null;
		audio?: AudioEngine | null;
		reference?: VuReference;
		onuse?: (curve: CurveData) => boolean;
		dataClient?: AutoEqClient;
		solverFactory?: () => PageSolver;
	} = $props();
	let station = $state.raw<StationState>(initialStation());
	let entries = $state.raw<AutoEqEntry[]>([]);
	let dataLoading = $state(true);
	let dataMissing = $state(false);
	let missingPacks = $state({ measurement: false, target: false });
	let query = $state('');
	let targetQuery = $state('');
	let measurementId = $state('');
	let targetId = $state('');
	let targetKind = $state<'autoeq' | 'preset' | 'drawn' | 'csv'>('autoeq');
	let presetId = $state(PADRAO_AURI.id);
	let points = $state.raw<TargetPoint[]>(INITIAL_POINTS.map((point) => ({ ...point })));
	let importedTarget: Trace | null = null;
	let loadingMeasurement = $state(false);
	let loadingTarget = $state(false);
	let workerUnavailable = $state(false);
	let used = $state(false);
	let alive = false;
	let indexSequence = 0;
	let measurementSequence = 0;
	let targetSequence = 0;
	let worker: PageSolver | null = null;
	const measurements = $derived(
		searchEntries(
			entries.filter((entry) => entry.type !== 'target'),
			query
		)
	);
	const targets = $derived(
		searchEntries(
			entries.filter((entry) => entry.type === 'target'),
			targetQuery
		)
	);
	const preset = $derived(OFFICIAL_PRESETS.find((entry) => entry.id === presetId) ?? PADRAO_AURI);
	const candidate = $derived(
		resultCurve(station, `${m.soe_title()} X · ${station.target?.name ?? ''}`)
	);
	const predicted = $derived.by(() => {
		if (!station.result || !station.measurement) return null;
		const response = curveResponseDb(station.result, GRID);
		return normalize(
			station.measurement.values.map((value, i) => value + response[i]),
			GRID
		);
	});
	const series = $derived([
		...(station.measurement
			? [{ values: station.measurement.values, label: m.soe_measurement(), color: '#a9bf98' }]
			: []),
		...(station.target
			? [{ values: station.target.values, label: m.soe_target(), color: '#ece7dd' }]
			: []),
		...(predicted ? [{ values: predicted, label: m.soe_prediction(), color: '#ff80b6' }] : [])
	]);
	const stopLabels = $derived({
		flat: m.soe_stop_flat(),
		converged: m.soe_stop_converged(),
		targetLoss: m.soe_stop_targetLoss(),
		time: m.soe_stop_time(),
		iterations: m.soe_stop_iterations()
	});
	function format(value: number, digits = 1) {
		return numberLabel(value, getLocale(), digits);
	}
	function send(event: StationEvent) {
		if (event.type !== 'start' && event.type !== 'result' && event.type !== 'error')
			worker?.cancel();
		station = stationTransition(station, event);
		used = false;
	}
	async function loadIndex() {
		const token = ++indexSequence;
		const retryMeasurement = missingPacks.measurement ? measurementId : '';
		const retryTarget = missingPacks.target ? targetId : '';
		dataLoading = true;
		dataMissing = false;
		try {
			const index = await dataClient.loadIndex();
			if (alive && token === indexSequence) {
				entries = index;
				dataMissing = index.length === 0;
				missingPacks = { measurement: false, target: false };
				const retries: Promise<void>[] = [];
				if (retryMeasurement && measurementId === retryMeasurement) {
					retries.push(chooseEntry(retryMeasurement, 'measurement'));
				}
				if (retryTarget && targetId === retryTarget && targetKind === 'autoeq') {
					retries.push(chooseEntry(retryTarget, 'target'));
				}
				await Promise.all(retries);
			}
		} catch (cause) {
			console.warn('Soe como X AutoEq index unavailable', cause);
			if (alive && token === indexSequence) dataMissing = true;
		} finally {
			if (alive && token === indexSequence) dataLoading = false;
		}
	}
	onMount(() => {
		alive = true;
		void loadIndex();
		return () => {
			alive = false;
			measurementSequence++;
			targetSequence++;
			worker?.dispose();
		};
	});
	async function chooseEntry(id: string, role: 'measurement' | 'target') {
		const entry = entries.find((item) => item.id === id);
		const token = role === 'measurement' ? ++measurementSequence : ++targetSequence;
		missingPacks[role] = false;
		if (role === 'measurement') {
			measurementId = id;
			loadingMeasurement = !!entry;
		} else {
			targetId = id;
			loadingTarget = !!entry;
		}
		send({ type: role, trace: null });
		if (!entry) return;
		try {
			const trace = await autoEqTrace(dataClient, entry);
			if (alive && token === (role === 'measurement' ? measurementSequence : targetSequence)) {
				send({ type: role, trace });
			}
		} catch (cause) {
			console.warn('Soe como X AutoEq pack unavailable', cause);
			if (alive && token === (role === 'measurement' ? measurementSequence : targetSequence)) {
				missingPacks[role] = true;
			}
		} finally {
			if (alive && token === (role === 'measurement' ? measurementSequence : targetSequence)) {
				if (role === 'measurement') loadingMeasurement = false;
				else loadingTarget = false;
			}
		}
	}
	function chooseKind() {
		targetSequence++;
		loadingTarget = false;
		targetId = '';
		missingPacks.target = false;
		send({
			type: 'target',
			trace:
				targetKind === 'preset'
					? presetTarget(presetId)
					: targetKind === 'drawn'
						? drawnTarget(points, m.soe_draw())
						: targetKind === 'csv'
							? importedTarget
							: null
		});
	}
	function importMeasurement(trace: Trace) {
		measurementSequence++;
		measurementId = '';
		loadingMeasurement = false;
		missingPacks.measurement = false;
		send({ type: 'measurement', trace });
	}
	function importTarget(trace: Trace) {
		targetSequence++;
		loadingTarget = false;
		importedTarget = trace;
		send({ type: 'target', trace });
	}
	function draw(next: TargetPoint[]) {
		points = next;
		send({ type: 'target', trace: drawnTarget(next, m.soe_draw()) });
	}
	function controls(patch: Partial<Controls>) {
		send({ type: 'controls', controls: { ...station.controls, ...patch } });
	}
	async function solve() {
		if (!station.measurement || !station.target || station.phase === 'solving') return;
		if (typeof Worker === 'undefined') {
			workerUnavailable = true;
			return;
		}
		workerUnavailable = false;
		try {
			worker ??= solverFactory();
			send({ type: 'start' });
			const result = await solveStation(station, worker);
			if (alive) send(result);
		} catch (cause) {
			console.warn('Soe como X worker unavailable', cause);
			workerUnavailable = true;
		}
	}
	function cancel() {
		worker?.cancel();
		send({ type: 'controls', controls: { ...station.controls } });
	}
	function useCurve() {
		if (candidate) used = onuse(candidate);
	}
</script>

<div class="soe-page">
	<section class="hero" aria-labelledby="soe-title">
		<div>
			<p class="kicker"><span>04 / C1 · C2 · C4</span> {m.soe_kicker()}</p>
			<h1 id="soe-title">{m.soe_title()} <em>X</em></h1>
		</div>
		<div class="hero-copy">
			<h2>{m.soe_lede()}</h2>
			<p>{m.soe_intro()}</p>
		</div>
		<div class="stamp">
			<strong>{m.soe_engine()}</strong>
			<span>Q27 / Q23 · 10 × BIQUAD</span>
			<span>FIELD 04 / INTERPRETATION</span>
		</div>
	</section>
	<div class="paper-ribbon">
		<span>{m.soe_seismic()}</span>
		{#if station.measurement}
			<div class="ribbon-trace">
				<WiggleTrace
					values={station.measurement.values}
					range={24}
					label={m.soe_measurement()}
					description={m.soe_shape()}
				/>
			</div>
		{:else}
			<span>20 Hz → 20 kHz / ∅</span>
		{/if}
	</div>
	<div class="chassis">
		<i class="screw tl" aria-hidden="true"></i>
		<i class="screw tr" aria-hidden="true"></i>
		<i class="screw bl" aria-hidden="true"></i>
		<i class="screw br" aria-hidden="true"></i>
		<div class="console-top">
			<span>{m.soe_console()}</span><span>96 000 SAMPLES / SECOND</span>
		</div>
		{#if dataMissing || missingPacks.measurement || missingPacks.target}
			<div class="missing" role="status">
				<p>{m.soe_missing()}</p>
				<button type="button" disabled={dataLoading} onclick={loadIndex}>{m.soe_retry()}</button>
			</div>
		{/if}
		<div class="workstation" class:draw-mode={targetKind === 'drawn'} data-phase={station.phase}>
			<section class="station measurement" aria-labelledby="soe-measurement-heading">
				<div class="station-head">
					<span class="station-number">1</span>
					<div>
						<h2 id="soe-measurement-heading">{m.soe_measurement()}</h2>
						<small>INPUT / RAW TRACE</small>
					</div>
				</div>
				<label for="soe-search">{m.soe_search()}</label>
				<input id="soe-search" type="search" bind:value={query} />
				<label for="soe-measurement">{m.soe_choose_measurement()}</label>
				<select
					id="soe-measurement"
					value={measurementId}
					onchange={(event) => chooseEntry(event.currentTarget.value, 'measurement')}
					disabled={dataLoading}
				>
					<option value="">{m.soe_choose()}</option>
					{#each measurements as entry (entry.id)}
						<option value={entry.id}>
							{entry.name} · {entry.source} · {m.soe_data_credit()}
						</option>
					{/each}
				</select>
				{#if dataLoading || loadingMeasurement}
					<p role="status">{m.soe_loading()}</p>
				{:else if !dataMissing && measurements.length === 0}
					<p>{m.soe_no_matches()}</p>
				{/if}
				{#if station.measurement}
					<h3 class="trace-name">{station.measurement.name}</h3>
				{/if}
				<Attribution trace={station.measurement} />
				{#if station.measurement}
					<TracePlot
						compact
						series={[
							{
								values: station.measurement.values,
								label: m.soe_measurement(),
								color: '#a9bf98'
							}
						]}
						label={m.soe_measurement()}
						description={m.soe_shape()}
					/>
				{/if}
				<CsvImport id="soe-input" label={m.soe_import_measurement()} onimport={importMeasurement} />
			</section>
			<section
				class="station target"
				class:drawing={targetKind === 'drawn'}
				aria-labelledby="soe-target-heading"
			>
				<div class="station-head">
					<span class="station-number">2</span>
					<div>
						<h2 id="soe-target-heading">{m.soe_target()}</h2>
						<small>DESTINATION / NOTE GRID</small>
					</div>
				</div>
				<label for="soe-target-kind">{m.soe_target_kind()}</label>
				<select
					id="soe-target-kind"
					value={targetKind}
					onchange={(event) => {
						const value = event.currentTarget.value;
						if (value === 'autoeq' || value === 'preset' || value === 'drawn' || value === 'csv') {
							targetKind = value;
							chooseKind();
						}
					}}
				>
					<option value="autoeq">{m.soe_autoeq()}</option>
					<option value="preset">{m.soe_official()}</option>
					<option value="drawn">{m.soe_draw()}</option>
					<option value="csv">{m.soe_csv()}</option>
				</select>
				{#if targetKind === 'autoeq'}
					<label for="soe-target-search">{m.soe_search()}</label>
					<input id="soe-target-search" type="search" bind:value={targetQuery} />
					<label for="soe-target">{m.soe_choose_target()}</label>
					<select
						id="soe-target"
						value={targetId}
						onchange={(event) => chooseEntry(event.currentTarget.value, 'target')}
						disabled={dataLoading}
					>
						<option value="">{m.soe_choose()}</option>
						{#each targets as entry (entry.id)}
							<option value={entry.id}>
								{entry.name} · {entry.source} · {m.soe_data_credit()}
							</option>
						{/each}
					</select>
					{#if loadingTarget}
						<p role="status">{m.soe_loading()}</p>
					{:else if !dataLoading && !dataMissing && !targets.length}
						<p>{m.soe_no_matches()}</p>
					{/if}
				{:else if targetKind === 'preset'}
					<label for="soe-preset">{m.soe_preset()}</label>
					<select
						id="soe-preset"
						value={presetId}
						onchange={(event) => {
							presetId = event.currentTarget.value;
							send({ type: 'target', trace: presetTarget(presetId) });
						}}
					>
						{#each OFFICIAL_PRESETS as item (item.id)}
							<option value={item.id}>{item.label}</option>
						{/each}
					</select>
					<p>
						{m.soe_kuba_description()}:
						{getLocale() === 'en-US'
							? (preset.descriptionEn ?? preset.description)
							: preset.description}
					</p>
					<p>{m.soe_license()}</p>
				{:else if targetKind === 'drawn'}
					<TargetEditor {points} onchange={draw} />
				{:else}
					<CsvImport id="soe-target-import" label={m.soe_import_target()} onimport={importTarget} />
				{/if}
				{#if station.target}
					<h3 class="trace-name">{station.target.name}</h3>
				{/if}
				<Attribution trace={station.target} />
				{#if station.target && targetKind !== 'drawn'}
					<TracePlot
						compact
						series={[{ values: station.target.values, label: m.soe_target(), color: '#ece7dd' }]}
						label={m.soe_target()}
						description={m.soe_shape()}
					/>
				{/if}
				<p>{m.soe_shape()}</p>
			</section>
			<section class="station correction" aria-labelledby="soe-correction-heading">
				<div class="station-head">
					<span class="station-number">3</span>
					<div>
						<h2 id="soe-correction-heading">{m.soe_correction()}</h2>
						<small>CONSTRAINED / PK + LS</small>
					</div>
				</div>
				<label for="soe-speed" class="knob-title">{m.soe_speed()}</label>
				<div
					class="knob"
					style={`--rotation:${-135 + station.controls.speed * 2.7}deg`}
					aria-hidden="true"
				>
					<i></i>
				</div>
				<output for="soe-speed" class="speed-value">
					{format(station.controls.speed, 0)} <small>/ 100</small>
				</output>
				<input
					id="soe-speed"
					type="range"
					min="0"
					max="100"
					step="1"
					value={station.controls.speed}
					oninput={(event) => controls({ speed: event.currentTarget.valueAsNumber })}
				/>
				<div class="switches">
					<label class="switch">
						<input
							type="checkbox"
							checked={station.controls.iso}
							onchange={(event) => controls({ iso: event.currentTarget.checked })}
						/>{m.soe_iso()}
					</label>
					<label for="soe-d5">{m.soe_d5()}</label>
					<output for="soe-d5">{format(station.controls.d5Weight, 3)}</output>
					<input
						id="soe-d5"
						type="range"
						min="0"
						max="0.1"
						step="0.001"
						value={station.controls.d5Weight}
						oninput={(event) => controls({ d5Weight: event.currentTarget.valueAsNumber })}
					/>
					<p>{m.soe_order()}</p>
				</div>
				<button
					class="primary solve"
					type="button"
					disabled={!station.measurement || !station.target || station.phase === 'solving'}
					onclick={solve}>{m.soe_solve()}</button
				>
				{#if station.phase === 'solving'}
					<button type="button" onclick={cancel}>{m.soe_cancel()}</button>
				{/if}
				<div class="fit-readout">
					<strong>{station.result ? format(station.result.rmsDb, 2) : '∅'}</strong>
					<span>{m.soe_rms()}</span>
				</div>
			</section>
			<section class="station result" aria-labelledby="soe-result-heading">
				<div class="station-head">
					<span class="station-number">4</span>
					<div>
						<h2 id="soe-result-heading">{m.soe_result()}</h2>
						<small>OUTPUT / QUANTIZED Q27</small>
					</div>
				</div>
				{#if station.result && candidate}
					<p class="gate-pass" role="status">{m.soe_gate_pass()}</p>
					<div class="table-well">
						<table aria-label={m.soe_result()}>
							<thead>
								<tr>
									<th scope="col">#</th>
									<th scope="col">{m.soe_type()}</th>
									<th scope="col">f / Hz</th>
									<th scope="col">dB</th>
									<th scope="col">Q</th>
								</tr>
							</thead>
							<tbody>
								{#each station.result.bands as band, i (i)}
									<tr>
										<th scope="row">{i + 1}</th>
										<td>{band.kind}</td>
										<td>{band.kind === 'OFF' ? '·' : format(band.freqHz, 0)}</td>
										<td>{band.kind === 'OFF' ? '·' : format(band.gainDb ?? 0)}</td>
										<td>{band.kind === 'OFF' ? '·' : format(band.qFactor, 2)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<div class="gate-readout">
						<span>{m.soe_preamp()}</span><strong>{format(station.result.preampDb)} dB</strong>
					</div>
					<p>
						{m.soe_iterations()}: {format(station.result.iterations, 0)} · {m.soe_stop()}:
						{stopLabels[station.result.stopReason]}
					</p>
					<Preview {audio} {current} {candidate} {reference} />
					<button type="button" class="primary use" disabled={!current} onclick={useCurve}>
						{m.soe_use()}
					</button>
					<p>{m.soe_use_note()}</p>
					{#if used}
						<p role="status">{m.soe_used()}</p>
						<a href="/?camada=ajustar">{m.soe_editor()}</a>
					{/if}
				{:else}
					<div class="empty-result">
						<span aria-hidden="true">∅ / 10</span>
						<p>{m.soe_empty_result()}</p>
					</div>
				{/if}
				<p class="gate-note">{m.soe_gate_note()}</p>
				<div class="vent" aria-hidden="true"></div>
			</section>
			<section class="panorama" aria-labelledby="soe-monitor-heading">
				<div class="monitor-head">
					<h2 id="soe-monitor-heading">{m.soe_monitor()}</h2>
					<span>LOG f / 20–20k</span>
				</div>
				<div class="screen">
					<h3>{m.soe_response()}</h3>
					{#if series.length}
						<TracePlot {series} label={m.soe_response()} description={m.soe_plot_description()} />
					{:else}
						<div class="no-trace">{m.soe_no_trace()}</div>
					{/if}
				</div>
				<Attribution trace={station.measurement} />
				<Attribution trace={station.target} />
				<div class="monitor-bottom" role="status">
					{#if workerUnavailable}
						{m.soe_worker_unavailable()}
					{:else if station.phase === 'solving'}
						{m.soe_solving()}
					{:else if station.phase === 'error'}
						{m.soe_solver_error()}
					{:else if !station.measurement}
						{m.soe_wait_measurement()}
					{:else if !station.target}
						{m.soe_wait_target()}
					{:else}
						{m.soe_ready()}
					{/if}
				</div>
			</section>
		</div>
		<div class="chassis-bottom">
			<span>FIELD 04 / RESPONSE ALIGNMENT</span>
			<span>GATE v2 · Q27 / Q23</span>
			<span>DSP / 96 kHz</span>
		</div>
	</div>
	<div class="under-console">
		<section>
			<h2>{m.soe_method_title()}</h2>
			<p>{m.soe_method()}</p>
		</section>
		<p>{m.soe_experimental()}</p>
	</div>
</div>

<style>
	.soe-page {
		--pink: #ff99c4;
		max-width: 1600px;
		padding: 35px 24px 0;
		margin: auto;
		color: #ece7dd;
		background: radial-gradient(ellipse at 20% 0, #45473a55, transparent 65%), #131512;
		font-family: var(--font-ui, 'Geist', sans-serif);
	}
	.hero {
		display: grid;
		grid-template-columns: 1.3fr 1fr 0.8fr;
		align-items: end;
		gap: 32px;
		margin-bottom: 28px;
	}
	.kicker {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		font-size: 10px;
		letter-spacing: 0.13em;
		color: #c6c9b7;
	}
	.kicker span {
		color: var(--pink);
	}
	h1 {
		font: 400 clamp(72px, 7.8vw, 124px) / 0.9 var(--font-serif, 'Instrument Serif', Georgia, serif);
		letter-spacing: -0.045em;
		white-space: nowrap;
		margin: 12px 0 0;
	}
	h1 em {
		color: #ff3d8b;
	}
	.hero-copy {
		border-left: 1px solid #737668;
		padding-left: 22px;
		max-width: 350px;
	}
	.hero-copy h2 {
		font-size: 15px;
		font-weight: 450;
		line-height: 1.4;
		margin: 0 0 10px;
	}
	.hero-copy p {
		color: #bfc4b2;
		font-size: 11px;
		line-height: 1.65;
		margin: 0;
	}
	.stamp {
		text-align: right;
		display: grid;
		gap: 6px;
		font: 10px/1.8 var(--font-mono, monospace);
		color: #c6c9b7;
	}
	.stamp strong {
		color: #ece7dd;
		font-size: 12px;
		font-weight: 400;
	}
	.paper-ribbon {
		height: 55px;
		display: flex;
		gap: 25px;
		align-items: center;
		justify-content: space-between;
		overflow: hidden;
		padding: 0 25px;
		margin: 0 9px -1px;
		transform: rotate(-0.25deg);
		background: #dedbce;
		color: #34372e;
		border: 1px solid #9a9b89;
		font: 9px var(--font-mono, monospace);
		letter-spacing: 0.08em;
	}
	.ribbon-trace {
		flex: 1;
		min-width: 0;
		max-height: 55px;
		overflow: hidden;
	}
	.chassis {
		position: relative;
		padding: 23px 20px 18px;
		background: linear-gradient(135deg, #64665a 0, #41443d 2%, #343731 36%, #292c27 100%);
		border: 1px solid #777b69;
		border-bottom: 5px solid #161914;
		border-radius: 9px 9px 14px 14px;
		box-shadow:
			0 2px 0 #000,
			0 25px 45px #0008,
			inset 0 1px 0 #adb19744;
	}
	.screw {
		position: absolute;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: linear-gradient(125deg, #a4a78e, #34382c 55%, #0c100a);
	}
	.screw::after {
		content: '';
		position: absolute;
		left: 2px;
		right: 2px;
		top: 4px;
		height: 1px;
		background: #10140d;
		transform: rotate(-35deg);
	}
	.tl {
		top: 8px;
		left: 8px;
	}
	.tr {
		top: 8px;
		right: 8px;
	}
	.bl {
		bottom: 8px;
		left: 8px;
	}
	.br {
		bottom: 8px;
		right: 8px;
	}
	.console-top,
	.chassis-bottom {
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px 14px;
		color: #d4dec8;
		font: 11px/1.5 var(--font-mono, monospace);
		padding: 0 3px 14px;
	}
	.chassis-bottom {
		padding: 16px 3px 0;
	}
	.workstation {
		display: grid;
		grid-template-columns: 0.94fr 0.94fr 1.05fr 1.35fr;
		gap: 14px;
		align-items: stretch;
	}
	.station {
		position: relative;
		min-width: 0;
		padding: 13px 13px 15px;
		background: linear-gradient(120deg, #45483e, #363a30);
		border: 1px solid #151a11;
		border-radius: 3px;
		box-shadow:
			inset 0 1px 0 #a6b38a22,
			1px 2px 3px #0005;
	}
	.station-head {
		display: flex;
		gap: 9px;
		align-items: center;
		margin-bottom: 12px;
	}
	.station-number {
		display: grid;
		place-items: center;
		width: 27px;
		height: 27px;
		flex-shrink: 0;
		border: 1px solid #b5b8a1;
		background: #c6c7b3;
		color: #2d3227;
		font: 16px var(--font-mono, monospace);
		border-radius: 2px;
		box-shadow: 0 2px 2px #0004;
	}
	.station-head h2 {
		font: 11px var(--font-mono, monospace);
		letter-spacing: 0.07em;
		margin: 0;
	}
	.station-head small {
		font: 9px var(--font-mono, monospace);
		color: #d4dec8;
	}
	label {
		display: block;
		margin: 11px 0 5px;
		font-size: 11px;
		color: #e1e8d5;
	}
	input,
	select {
		box-sizing: border-box;
		min-width: 0;
		width: 100%;
		accent-color: #ff3d8b;
	}
	input[type='search'],
	select {
		background: #101a16;
		color: #e1e8d5;
		border: 1px solid #859175;
		border-radius: 2px;
		padding: 9px 7px;
		font-size: 11px;
	}
	button {
		cursor: pointer;
		border: 1px solid #859175;
		background: #222a1d;
		color: #e1e8d5;
		border-radius: 3px;
		padding: 9px 10px;
		font-size: 11px;
	}
	button:hover:not(:disabled) {
		border-color: var(--pink);
	}
	button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	button.primary {
		background: #ff3d8b;
		border-color: #ff3d8b;
		color: #190b12;
		font-weight: 650;
	}
	button:focus-visible,
	a:focus-visible,
	input:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--pink);
		outline-offset: 3px;
	}
	p {
		font-size: 11px;
		line-height: 1.65;
		color: #d4dec8;
		overflow-wrap: anywhere;
	}
	.trace-name {
		margin: 12px 0 6px;
		font-size: 12px;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.knob-title {
		text-align: center;
		font-family: var(--font-mono, monospace);
	}
	.knob {
		position: relative;
		width: 120px;
		height: 120px;
		margin: 16px auto 10px;
		border-radius: 50%;
		border: 3px solid #777e65;
		outline: 5px solid #23291d;
		background: radial-gradient(circle at 30% 22%, #696c5f, #33372e 44%, #1a2017 80%);
		box-shadow: 3px 7px 8px #0008;
	}
	.knob i {
		position: absolute;
		inset: 10px;
		transform: rotate(var(--rotation));
	}
	.knob i::before {
		content: '';
		position: absolute;
		top: 0;
		left: calc(50% - 2px);
		width: 4px;
		height: 24px;
		background: #ff3d8b;
	}
	.speed-value {
		display: block;
		text-align: center;
		color: var(--pink);
		font: 26px var(--font-mono, monospace);
	}
	.speed-value small {
		font-size: 11px;
		color: #d4dec8;
	}
	.switches {
		margin-top: 15px;
		padding-top: 6px;
		border-top: 1px solid #777e65;
	}
	.switch {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		line-height: 1.6;
	}
	.switch input {
		width: auto;
		margin-top: 3px;
	}
	output {
		font: 12px var(--font-mono, monospace);
		color: var(--pink);
	}
	.solve,
	.use {
		width: 100%;
		margin: 10px 0;
	}
	.fit-readout {
		margin-top: 16px;
		display: grid;
		gap: 3px;
		text-align: center;
		font: 10px var(--font-mono, monospace);
		color: #d4dec8;
	}
	.fit-readout strong {
		font-size: 38px;
		font-weight: 400;
		color: var(--pink);
	}
	.result {
		grid-column: 4;
		grid-row: 1 / 3;
		display: flex;
		flex-direction: column;
		background: linear-gradient(110deg, #3a3f33, #2c3227);
	}
	.gate-pass {
		color: #ffb2d2;
		margin-top: 0;
		font-family: var(--font-mono, monospace);
	}
	.table-well {
		padding: 6px 7px 8px;
		background: #11190f;
		border: 4px solid #1c2119;
		border-radius: 5px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		color: #d4dec8;
		font: 11px var(--font-mono, monospace);
	}
	th,
	td {
		padding: 6px 1px;
		text-align: right;
		border-bottom: 1px solid #35422a;
		font-weight: 400;
	}
	th:first-child,
	td:nth-child(2) {
		text-align: left;
	}
	.gate-readout {
		display: grid;
		gap: 6px;
		margin-top: 14px;
		padding: 10px 0;
		border-top: 1px solid #606e4f;
		font: 11px var(--font-mono, monospace);
		color: #d4dec8;
	}
	.gate-readout strong {
		font-size: 24px;
		font-weight: 400;
		color: var(--pink);
	}
	.gate-note {
		margin-top: auto;
		padding-top: 16px;
	}
	.empty-result {
		display: grid;
		align-content: center;
		min-height: 350px;
		text-align: center;
		border: 5px solid #1c2119;
		background: #11190f;
	}
	.empty-result > span {
		color: #d4dec8;
		font: 36px var(--font-mono, monospace);
	}
	.vent {
		height: 28px;
		background: repeating-linear-gradient(90deg, #141b10 0 3px, transparent 3px 7px);
		margin: 14px 0 0;
	}
	.panorama {
		grid-column: 1 / 4;
		grid-row: 2;
		min-width: 0;
		padding: 12px 13px 10px;
		border: 1px solid #151d10;
		border-radius: 5px;
		background: linear-gradient(120deg, #343b2c, #2a3024);
	}
	.monitor-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
		margin: 0 3px 9px;
		color: #d4dec8;
		font: 11px var(--font-mono, monospace);
	}
	.monitor-head h2 {
		font: inherit;
		margin: 0;
	}
	.screen {
		background: #0b120e;
		border: 8px solid #1b1f19;
		border-radius: 14px 14px 9px 9px;
		box-shadow: inset 0 0 18px #000;
		overflow: hidden;
	}
	.screen h3 {
		margin: 12px 15px;
		font: 11px var(--font-mono, monospace);
		color: #e2ead8;
	}
	.no-trace {
		min-height: 240px;
		display: grid;
		place-items: center;
		font-size: 12px;
		color: #d4dec8;
	}
	.monitor-bottom {
		margin-top: 12px;
		font: 11px/1.65 var(--font-mono, monospace);
		color: #d4dec8;
	}
	.missing {
		padding: 12px;
		background: #222a1d;
		border: 1px solid #c4c9b4;
		margin-bottom: 14px;
	}
	.missing p {
		margin-top: 0;
	}
	.under-console {
		display: grid;
		grid-template-columns: 1fr 1.1fr;
		gap: 30px;
		margin: 24px 7px 0;
	}
	.under-console h2 {
		font-size: 12px;
		font-weight: 500;
		color: #e1e8d5;
		margin-bottom: 4px;
	}
	.under-console p {
		color: #bfc4b2;
	}
	a {
		color: #ffb2d2;
		font-size: 12px;
		text-underline-offset: 4px;
	}
	@media (max-width: 1080px) {
		.hero {
			grid-template-columns: 1.3fr 1fr;
		}
		.stamp {
			display: none;
		}
		.workstation {
			grid-template-columns: repeat(3, 1fr);
		}
		.result {
			grid-column: 1 / 4;
			grid-row: 3;
		}
		.empty-result {
			min-height: 140px;
		}
	}
	@media (max-width: 720px) {
		.soe-page {
			padding: 27px 16px 0;
		}
		.hero {
			display: block;
			margin-bottom: 22px;
		}
		h1 {
			font-size: 80px;
		}
		.hero-copy {
			margin-top: 22px;
			max-width: none;
			padding-left: 15px;
		}
		.paper-ribbon {
			padding-inline: 12px;
			margin-inline: 5px;
			height: 43px;
			gap: 10px;
			font-size: 8px;
		}
		.chassis {
			padding: 18px 10px 13px;
		}
		.console-top {
			font-size: 10px;
		}
		.workstation {
			grid-template-columns: 1fr 1fr;
			gap: 10px;
		}
		.station {
			padding: 10px;
		}
		.station-head {
			gap: 6px;
		}
		.station-head h2 {
			font-size: 10px;
			letter-spacing: 0;
		}
		.station-head small {
			font-size: 8px;
		}
		.station-number {
			width: 23px;
			font-size: 13px;
		}
		.target.drawing,
		.correction {
			grid-column: 1 / 3;
		}
		.draw-mode .measurement {
			grid-column: 1 / 3;
		}
		.draw-mode .correction {
			grid-row: 3;
		}
		.panorama {
			grid-column: 1 / 3;
			grid-row: 3;
			padding: 9px 7px;
		}
		.result {
			grid-column: 1 / 3;
			grid-row: 4;
		}
		.draw-mode .panorama {
			grid-row: 4;
		}
		.draw-mode .result {
			grid-row: 5;
		}
		.screen {
			border-width: 5px;
		}
		.under-console {
			grid-template-columns: 1fr;
			gap: 10px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		*,
		*::before,
		*::after {
			scroll-behavior: auto;
			transition: none;
			animation: none;
		}
	}
</style>
