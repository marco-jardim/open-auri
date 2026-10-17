<script lang="ts">
	import { onMount } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { AutoEqEntry, searchEntries } from '#lib/data/autoeq.ts';
	import { createSolverWorker } from '#lib/workers/solver-client.ts';
	import { OFFICIAL_PRESETS, PADRAO_AURI } from 'open-auri/catalog';
	import { numberLabel } from '#lib/charts/scales.ts';
	// Direct chart imports (FUX.B): the charts barrel would bring every chart into the page.
	import WiggleTrace from '#lib/charts/WiggleTrace.svelte';
	import type { AudioEngine } from '#lib/audio/engine.ts';
	import type { VuReference } from '#lib/audio/meters.ts';
	import type { CurveData } from '#lib/state/model.ts';
	import { Button, EmptyState, Skeleton } from '#lib/components/primitives/index.ts';
	import { Explainer, Tour, TourTrigger } from '#lib/components/comprehension/index.ts';
	import LazyArt from '#lib/components/art/LazyArt.svelte';
	import Attribution from './Attribution.svelte';
	import CsvImport from './CsvImport.svelte';
	import Deferred from '#lib/components/pages/lazy/Deferred.svelte';
	import { targetEditor } from './lazy.ts';
	import TracePlot from './TracePlot.svelte';
	import Preview from './Preview.svelte';
	import { createCurveSocial, type CurveSocial } from '../comparar/social.svelte.ts';
	import { socialTarget, solverRecipe } from './social.ts';
	import {
		autoEqTrace,
		deviation,
		drawnTarget,
		initialStation,
		INITIAL_POINTS,
		MAX_ITERATIONS,
		predictedValues,
		presetTarget,
		progressFrom,
		PROGRESS_BUDGETS,
		resultCurve,
		solveStationWithProgress,
		stationTransition,
		type AutoEqClient,
		type Controls,
		type SolveProgress,
		type SolverPort,
		type StationEvent,
		type StationState,
		type TargetPoint,
		type Trace
	} from './model.ts';
	import { AUTOEQ_INDEX_ON_IDLE, fire, onIdle, sharedWarmers, type PageWarmers } from './warm.ts';

	interface PageSolver extends SolverPort {
		cancel(): void;
		dispose(): void;
	}
	let {
		current = null,
		audio = null,
		reference = -18,
		onuse = () => false,
		dataClient,
		solverFactory = createSolverWorker,
		social = createCurveSocial(),
		warmers = sharedWarmers
	}: {
		current?: CurveData | null;
		audio?: AudioEngine | null;
		reference?: VuReference;
		onuse?: (curve: CurveData) => boolean;
		dataClient?: AutoEqClient;
		solverFactory?: () => PageSolver;
		social?: CurveSocial;
		warmers?: PageWarmers;
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
	let targetKind = $state<'autoeq' | 'preset' | 'drawn' | 'csv' | 'community'>('autoeq');
	let presetId = $state(PADRAO_AURI.id);
	let points = $state.raw<TargetPoint[]>(INITIAL_POINTS.map((point) => ({ ...point })));
	let importedTarget: Trace | null = null;
	let loadingMeasurement = $state(false);
	let loadingTarget = $state(false);
	let workerUnavailable = $state(false);
	let used = $state(false);
	/** Real solver passes: latest numbers, one deviation row per pass and its LM trials. */
	let progress = $state.raw<SolveProgress | null>(null);
	let rows = $state.raw<number[][]>([]);
	let rowIterations = $state.raw<number[]>([]);
	let alive = false;
	let indexRequested = false;
	let indexSequence = 0;
	let measurementSequence = 0;
	let targetSequence = 0;
	let worker: PageSolver | null = null;
	let ownedDataClient: AutoEqClient | undefined;
	let search = $state.raw<typeof searchEntries | null>(null);
	async function getDataClient(): Promise<AutoEqClient> {
		if (dataClient) return dataClient;
		if (ownedDataClient) return ownedDataClient;
		const { createAutoEqClient } = await import('#lib/data/autoeq.ts');
		return (ownedDataClient ??= createAutoEqClient());
	}
	const measurementEntries = $derived(entries.filter((entry) => entry.type !== 'target'));
	const measurements = $derived(search?.(measurementEntries, query) ?? []);
	const targets = $derived(
		search?.(
			entries.filter((entry) => entry.type === 'target'),
			targetQuery
		) ?? []
	);
	const preset = $derived(OFFICIAL_PRESETS.find((entry) => entry.id === presetId) ?? PADRAO_AURI);
	const candidate = $derived(
		resultCurve(station, `${m.soe_title()} X · ${station.target?.name ?? ''}`)
	);
	const fitted = $derived(
		station.result && station.measurement
			? predictedValues(station.measurement.values, station.result)
			: null
	);
	/** While solving, the converging curve of the latest real pass; afterwards the final fit. */
	const shownPrediction = $derived(
		station.phase === 'solving' ? (progress?.predicted ?? null) : fitted
	);
	const rmsValue = $derived(
		station.result ? station.result.rmsDb : station.phase === 'solving' ? progress?.rmsDb : null
	);
	const maxError = $derived(
		fitted && station.target
			? deviation(fitted, station.target.values).maxErrorDb
			: station.phase === 'solving'
				? progress?.maxErrorDb
				: null
	);
	const series = $derived([
		...(station.measurement
			? [{ values: station.measurement.values, label: m.soe_measurement(), color: '#a9bf98' }]
			: []),
		...(station.target
			? [{ values: station.target.values, label: m.soe_target(), color: '#ece7dd' }]
			: []),
		...(shownPrediction
			? [{ values: shownPrediction, label: m.soe_prediction(), color: '#ff80b6' }]
			: [])
	]);
	const stopLabels = $derived({
		flat: m.soe_stop_flat(),
		converged: m.soe_stop_converged(),
		targetLoss: m.soe_stop_targetLoss(),
		time: m.soe_stop_time(),
		iterations: m.soe_stop_iterations()
	});
	const solveReason = $derived(
		!station.measurement || !station.target ? m.soe_fux_solve_reason() : null
	);

	// Decorative seismic field behind the hero: static paths, computed once, never animated.
	const SEISMIC = Array.from({ length: 15 }, (_, row) => {
		const y0 = 10 + row * 15;
		const centre = 160 + ((row * 173) % 860);
		let d = `M0 ${y0}`;
		for (let x = 6; x <= 1200; x += 6) {
			const burst = Math.exp(-((x - centre) ** 2) / 14000);
			const y =
				y0 + Math.sin(x * 0.13 + row * 1.7) * (0.9 + 6 * burst) + Math.sin(x * 0.031 + row) * 1.4;
			d += ` L${x} ${y.toFixed(1)}`;
		}
		return d;
	});

	// Knob geometry (real control state: the correction speed).
	const KNOB_TICKS = Array.from({ length: 28 }, (_, i) => -135 + (i * 270) / 27);
	function polar(angle: number, radius: number) {
		const rad = (angle * Math.PI) / 180;
		return { x: 80 + radius * Math.sin(rad), y: 80 - radius * Math.cos(rad) };
	}
	function arc(from: number, to: number, radius = 62) {
		if (to - from < 0.5) return '';
		const start = polar(from, radius);
		const end = polar(to, radius);
		const large = to - from > 180 ? 1 : 0;
		return `M${start.x.toFixed(2)} ${start.y.toFixed(2)} A${radius} ${radius} 0 ${large} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
	}
	const knobAngle = $derived(-135 + station.controls.speed * 2.7);

	// Deviation map: frequency bins × real solver passes, diverging colour scale ±9 dB.
	const MAP_BINS = 64;
	const MAP_ROWS = PROGRESS_BUDGETS.length + 2;
	function bins(row: readonly number[]) {
		const size = row.length / MAP_BINS;
		return Array.from({ length: MAP_BINS }, (_, i) => {
			const slice = row.slice(
				Math.floor(i * size),
				Math.max(Math.floor(i * size) + 1, Math.floor((i + 1) * size))
			);
			return slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
		});
	}
	function mix(from: readonly number[], to: readonly number[], t: number) {
		const channel = (i: number) => Math.round(from[i] + (to[i] - from[i]) * t);
		return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
	}
	function heat(value: number) {
		const t = Math.max(-1, Math.min(1, value / 9));
		const paper = [217, 211, 196];
		return t < 0 ? mix(paper, [70, 106, 196], -t) : mix(paper, [214, 74, 82], t);
	}
	const mapRows = $derived(rows.map(bins));

	function format(value: number, digits = 1) {
		return numberLabel(value, getLocale(), digits);
	}
	function send(event: StationEvent) {
		if (event.type !== 'start' && event.type !== 'result' && event.type !== 'error') {
			worker?.cancel();
			progress = null;
			rows = [];
			rowIterations = [];
		}
		station = stationTransition(station, event);
		used = false;
	}
	function requestIndex() {
		if (indexRequested) return;
		indexRequested = true;
		void loadIndex();
	}
	async function loadIndex() {
		indexRequested = true;
		const token = ++indexSequence;
		const retryMeasurement = missingPacks.measurement ? measurementId : '';
		const retryTarget = missingPacks.target ? targetId : '';
		dataLoading = true;
		dataMissing = false;
		try {
			const [client, helpers] = await Promise.all([getDataClient(), import('#lib/data/autoeq.ts')]);
			const index = await client.loadIndex();
			if (alive && token === indexSequence) {
				search = helpers.searchEntries;
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
	/**
	 * W4: the solver bundle is prefetched as soon as someone reaches for the search (shared
	 * FUX.2 helper: code only; the worker itself is created by RESOLVER, once).
	 */
	let solverWarmed = false;
	function searchFocus() {
		requestIndex();
		if (solverWarmed || worker) return;
		solverWarmed = true;
		fire(warmers.solver, 'solver');
	}
	onMount(() => {
		alive = true;
		const stopSocial = social.mount();
		// W4: gate worker bundle on idle after the first paint.
		const stopGate = onIdle(() => fire(warmers.gate, 'gate'));
		// W5: the AutoEq index loads on idle (or at once when a search field gets focus).
		const stopIdle = AUTOEQ_INDEX_ON_IDLE ? onIdle(requestIndex) : () => undefined;
		return () => {
			stopGate();
			stopIdle();
			stopSocial();
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
			const trace = await autoEqTrace(await getDataClient(), entry);
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
						? drawnTarget(points, m.soe_fux_draw())
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
		send({ type: 'target', trace: drawnTarget(next, m.soe_fux_draw()) });
	}
	function controls(patch: Partial<Controls>) {
		send({ type: 'controls', controls: { ...station.controls, ...patch } });
	}
	async function solve() {
		const measurement = station.measurement;
		const target = station.target;
		if (!measurement || !target || station.phase === 'solving') return;
		if (typeof Worker === 'undefined') {
			workerUnavailable = true;
			return;
		}
		workerUnavailable = false;
		let port: PageSolver;
		try {
			port = worker ??= solverFactory();
		} catch (cause) {
			console.warn('Soe como X worker unavailable', cause);
			workerUnavailable = true;
			return;
		}
		send({ type: 'start' });
		const revision = station.revision;
		// Row zero is the real starting point: the measurement with no EQ against the target.
		rows = [deviation(measurement.values, target.values).values];
		rowIterations = [0];
		progress = null;
		const isCurrent = () => alive && station.revision === revision && station.phase === 'solving';
		const event = await solveStationWithProgress(station, port, (next) => {
			if (!isCurrent()) return false;
			progress = next;
			rows = [...rows, next.row];
			rowIterations = [...rowIterations, next.iterations];
			return true;
		});
		if (!alive) return;
		if (event.type === 'result' && isCurrent()) {
			const final = progressFrom(event.result, measurement.values, target.values, MAX_ITERATIONS);
			progress = final;
			rows = [...rows, final.row];
			rowIterations = [...rowIterations, final.iterations];
		}
		send(event);
	}
	function cancel() {
		worker?.cancel();
		send({ type: 'controls', controls: { ...station.controls } });
	}
	function useCurve() {
		if (candidate) used = onuse(candidate);
	}
	const TARGET_GRID = [0.2, 0.4, 0.6, 0.8];
</script>

<div class="soe-page">
	<LazyArt load={() => import('#lib/components/art/SoeArt.svelte')} />
	<section class="hero" aria-labelledby="soe-title">
		<svg class="seismic" viewBox="0 0 1200 230" preserveAspectRatio="none" aria-hidden="true">
			{#each SEISMIC as d, i (i)}<path {d} />{/each}
		</svg>
		<div class="hero-title">
			<p class="eyebrow kicker">{m.soe_kicker()}</p>
			<h1 id="soe-title">{m.soe_title()} <em>X</em></h1>
		</div>
		<div class="hero-copy">
			<h2 class="lede">{m.soe_lede()}</h2>
			<p>{m.soe_intro()}</p>
		</div>
		<div class="stamp">
			<span class="engine"><i aria-hidden="true"></i>{m.soe_engine()}</span>
			<TourTrigger page="soe-como-x" />
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
			<span>{m.soe_fux_ribbon_empty()}</span>
		{/if}
	</div>
	<div class="chassis">
		<i class="screw tl" aria-hidden="true"></i>
		<i class="screw tr" aria-hidden="true"></i>
		<i class="screw bl" aria-hidden="true"></i>
		<i class="screw br" aria-hidden="true"></i>
		<div class="console-top">
			<span>{m.soe_console()}</span>
		</div>
		{#if dataMissing || missingPacks.measurement || missingPacks.target}
			<div class="missing" role="status">
				<p>{m.soe_missing()}</p>
				<Button size="sm" variant="plate" loading={dataLoading} onclick={loadIndex}>
					{m.soe_fux_retry()}
				</Button>
			</div>
		{/if}
		<div class="workstation" class:draw-mode={targetKind === 'drawn'} data-phase={station.phase}>
			<section
				class="station measurement"
				aria-labelledby="soe-measurement-heading"
				data-tour="soe-headphone"
			>
				<div class="station-head">
					<span class="station-number">1</span>
					<div>
						<h2 id="soe-measurement-heading">{m.soe_measurement()}</h2>
						<small>{m.soe_fux_sub_measurement()}</small>
					</div>
				</div>
				<label for="soe-search">{m.soe_search()}</label>
				<input id="soe-search" type="search" bind:value={query} onfocus={searchFocus} />
				{#if dataLoading}
					<div class="index-loading">
						<Skeleton width="100%" height="38px" label={m.soe_fux_index_loading()} />
						<p class="state">{m.soe_fux_index_loading()}</p>
					</div>
				{:else}
					<label for="soe-measurement">{m.soe_choose_measurement()}</label>
					<select
						id="soe-measurement"
						value={measurementId}
						onchange={(event) => chooseEntry(event.currentTarget.value, 'measurement')}
					>
						<option value="">{m.soe_choose()}</option>
						{#each measurements as entry (entry.id)}
							<option value={entry.id}>
								{entry.name} · {entry.source} · {m.soe_data_credit()}
							</option>
						{/each}
					</select>
				{/if}
				{#if loadingMeasurement}
					<p role="status">{m.soe_loading()}</p>
				{:else if !dataLoading && !dataMissing && measurements.length === 0}
					<p class="state no-result" role="status">{m.empty_soe_body()}</p>
				{:else if !dataLoading && !dataMissing && !query.trim()}
					<p class="state">{m.soe_fux_index_ready({ count: measurementEntries.length })}</p>
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
				data-tour="soe-target"
			>
				<div class="station-head">
					<span class="station-number">2</span>
					<div>
						<h2 id="soe-target-heading">{m.soe_target()}</h2>
						<small>{m.soe_fux_sub_target()}</small>
					</div>
				</div>
				<label for="soe-target-kind">{m.soe_target_kind()}</label>
				<select
					id="soe-target-kind"
					value={targetKind}
					onchange={(event) => {
						const value = event.currentTarget.value;
						if (
							value === 'autoeq' ||
							value === 'preset' ||
							value === 'drawn' ||
							value === 'csv' ||
							value === 'community'
						) {
							targetKind = value;
							chooseKind();
						}
					}}
				>
					<option value="autoeq">{m.soe_autoeq()}</option>
					<option value="preset">{m.soe_official()}</option>
					<option value="drawn">{m.soe_fux_draw()}</option>
					<option value="csv">{m.soe_csv()}</option>
					<option value="community">{m.curve_social_target()}</option>
				</select>
				{#if targetKind === 'autoeq'}
					<label for="soe-target-search">{m.soe_search()}</label>
					<input
						id="soe-target-search"
						type="search"
						bind:value={targetQuery}
						onfocus={searchFocus}
					/>
					{#if dataLoading}
						<Skeleton width="100%" height="38px" label={m.soe_fux_index_loading()} />
					{:else}
						<label for="soe-target">{m.soe_choose_target()}</label>
						<select
							id="soe-target"
							value={targetId}
							onchange={(event) => chooseEntry(event.currentTarget.value, 'target')}
						>
							<option value="">{m.soe_choose()}</option>
							{#each targets as entry (entry.id)}
								<option value={entry.id}>
									{entry.name} · {entry.source} · {m.soe_data_credit()}
								</option>
							{/each}
						</select>
					{/if}
					{#if loadingTarget}
						<p role="status">{m.soe_loading()}</p>
					{:else if !dataLoading && !dataMissing && !targets.length}
						<p class="state">{m.soe_no_matches()}</p>
					{/if}
				{:else if targetKind === 'community'}
					{#await import('../comparar/SocialSources.svelte') then { default: SocialSources }}
						<SocialSources
							{social}
							path="/soe-como-x"
							onload={(curve) => {
								targetSequence++;
								loadingTarget = false;
								send({ type: 'target', trace: socialTarget(curve) });
							}}
						/>
					{/await}
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
				{:else if targetKind === 'csv'}
					<CsvImport id="soe-target-import" label={m.soe_import_target()} onimport={importTarget} />
				{/if}
				<div class="target-chart">
					{#if targetKind === 'drawn'}
						<Deferred module={targetEditor} height="220px">
							{#snippet children(TargetEditor)}
								<TargetEditor {points} onchange={draw} />
							{/snippet}
						</Deferred>
					{:else if station.target}
						<TracePlot
							compact
							series={[{ values: station.target.values, label: m.soe_target(), color: '#ece7dd' }]}
							label={m.soe_target()}
							description={m.soe_shape()}
						/>
					{:else}
						<div class="chart-empty">
							<svg viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true">
								{#each TARGET_GRID as fraction (fraction)}
									<line x1={fraction * 100} x2={fraction * 100} y1="0" y2="60" />
									<line x1="0" x2="100" y1={fraction * 60} y2={fraction * 60} />
								{/each}
							</svg>
							<span>{m.soe_no_trace()}</span>
						</div>
					{/if}
				</div>
				{#if station.target}
					<h3 class="trace-name">{station.target.name}</h3>
				{/if}
				<Attribution trace={station.target} />
				<p>{m.soe_shape()}</p>
			</section>
			<section
				class="station correction"
				aria-labelledby="soe-correction-heading"
				data-tour="soe-solver"
			>
				<div class="station-head">
					<span class="station-number">3</span>
					<div>
						<h2 id="soe-correction-heading">{m.soe_correction()}</h2>
						<small>{m.soe_fux_sub_correction()}</small>
					</div>
				</div>
				<label for="soe-speed" class="knob-title">{m.soe_speed()}</label>
				<svg class="knob" viewBox="0 0 160 160" aria-hidden="true">
					{#each KNOB_TICKS as angle (angle)}
						{@const inner = polar(angle, 70)}
						{@const outer = polar(angle, 77)}
						<line
							class:lit={angle <= knobAngle}
							x1={inner.x}
							y1={inner.y}
							x2={outer.x}
							y2={outer.y}
						/>
					{/each}
					<path class="arc-track" d={arc(-135, 135)} />
					<path class="arc-value" d={arc(-135, knobAngle)} />
					<circle class="cap" cx="80" cy="80" r="44" />
					<line
						class="pointer"
						x1="80"
						y1="58"
						x2="80"
						y2="42"
						transform={`rotate(${knobAngle} 80 80)`}
					/>
				</svg>
				<div class="knob-scale" aria-hidden="true">
					<span>{m.soe_fux_soft()}</span><span>{m.soe_fux_tight()}</span>
				</div>
				<output for="soe-speed" class="speed-value readout">
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
						/>{m.soe_fux_iso()}
					</label>
					<label for="soe-d5">{m.soe_fux_d5()}</label>
					<output for="soe-d5" class="readout">{format(station.controls.d5Weight, 3)}</output>
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
				<Button
					class="solve"
					variant="primary"
					size="lg"
					disabledReason={solveReason}
					loading={station.phase === 'solving'}
					onclick={solve}>{m.soe_solve()}</Button
				>
				{#if station.phase === 'solving'}
					<Button size="sm" variant="ghost" onclick={cancel}>{m.soe_cancel()}</Button>
				{/if}
				<div class="fit-readout">
					<div>
						<strong class="readout">{rmsValue == null ? '∅' : format(rmsValue, 2)}</strong>
						<span>{m.soe_rms()}</span>
					</div>
					<div>
						<strong class="readout">{maxError == null ? '∅' : format(maxError, 2)}</strong>
						<span>{m.soe_fux_max_error()}</span>
					</div>
				</div>
			</section>
			<section class="station result" aria-labelledby="soe-result-heading">
				<div class="station-head">
					<span class="station-number">4</span>
					<div>
						<h2 id="soe-result-heading">{m.soe_result()}</h2>
						<small>{m.soe_fux_sub_result()}</small>
					</div>
				</div>
				{#if station.result && candidate}
					<div class="gate-line">
						<p class="gate-pass" role="status">{m.soe_gate_pass()}</p>
						<Explainer term="gate" />
					</div>
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
										<th scope="row">{String(i + 1).padStart(2, '0')}</th>
										<td>{band.kind}</td>
										<td>{band.kind === 'OFF' ? '·' : format(band.freqHz, 0)}</td>
										<td>{band.kind === 'OFF' ? '·' : format(band.gainDb ?? 0)}</td>
										<td>{band.kind === 'OFF' ? '·' : format(band.qFactor, 2)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<div class="explain-row">
						<span>Q</span>
						<Explainer term="q" />
					</div>
					<div class="gate-readout">
						<span class="explain-row">{m.soe_preamp()} <Explainer term="preamp" /></span>
						<strong class="readout">{format(station.result.preampDb)} dB</strong>
					</div>
					<p>
						{m.soe_iterations()}: {format(station.result.iterations, 0)} · {m.soe_stop()}:
						{stopLabels[station.result.stopReason]}
					</p>
					<div data-tour="soe-ab">
						<Preview {audio} {current} {candidate} {reference} />
					</div>
					<div class="use" data-tour="soe-editor">
						<Button
							class="use-button"
							variant="primary"
							disabledReason={current ? null : m.soe_fux_editor_loading()}
							onclick={useCurve}
						>
							{m.soe_use()}
						</Button>
						<p>{m.soe_use_note()}</p>
						{#if used}
							<p role="status">{m.soe_used()}</p>
							<a class="btn btn--plate btn--md editor-link" href="/?camada=ajustar"
								>{m.soe_editor()}</a
							>
						{/if}
					</div>
					{#await import('../comparar/SocialPublish.svelte') then { default: SocialPublish }}
						{#key station.result}<SocialPublish
								{social}
								curve={candidate}
								recipe={solverRecipe(station)}
								path="/soe-como-x"
							/>{/key}
					{/await}
				{:else}
					<EmptyState title={m.soe_empty_result()} why={m.soe_fux_empty_result_why()}>
						{#snippet illustration()}
							<svg viewBox="0 0 120 64" width="120" height="64" fill="none">
								{#each Array.from({ length: 10 }, (_, i) => i) as slot (slot)}
									<rect
										x={4 + slot * 11.5}
										y="12"
										width="8"
										height="40"
										rx="2"
										stroke="currentColor"
										stroke-dasharray="2 3"
									/>
								{/each}
							</svg>
						{/snippet}
						{#snippet explain()}<Explainer term="gate" />{/snippet}
					</EmptyState>
				{/if}
				<p class="gate-note">{m.soe_gate_note()}</p>
				<div class="vent" aria-hidden="true"></div>
			</section>
			<section class="panorama" aria-labelledby="soe-monitor-heading">
				<div class="monitor-head">
					<h2 id="soe-monitor-heading">
						<i class="lamp" data-on={station.phase === 'solving'} aria-hidden="true"></i>
						{m.soe_monitor()}
					</h2>
					{#if progress}
						<span class="iter readout" aria-hidden="true">
							{m.soe_fux_iter_short({
								n: format(progress.iterations, 0),
								total: format(progress.maxIterations, 0)
							})}
						</span>
						<span class="visually-hidden">
							{m.soe_fux_iter_label({
								n: format(progress.iterations, 0),
								total: format(progress.maxIterations, 0)
							})}
						</span>
					{/if}
				</div>
				<div class="screen">
					<h3>{m.soe_response()}</h3>
					{#if series.length}
						<TracePlot {series} label={m.soe_response()} description={m.soe_plot_description()} />
					{:else}
						<div class="no-trace">{m.soe_no_trace()}</div>
					{/if}
					<div class="map">
						<div class="map-head">
							<h3>{m.soe_fux_map_title()} · {m.soe_fux_map_axis()}</h3>
							<span class="legend" aria-hidden="true">−9 <i></i> +9 dB</span>
						</div>
						{#if mapRows.length}
							<div class="map-grid">
								<ol class="map-iterations" aria-hidden="true">
									{#each rowIterations as count, i (i)}<li>{format(count, 0)}</li>{/each}
								</ol>
								<svg
									viewBox={`0 0 ${MAP_BINS} ${MAP_ROWS}`}
									preserveAspectRatio="none"
									role="img"
									aria-label={m.soe_fux_map_label({
										rows: mapRows.length,
										max: format(progress?.maxErrorDb ?? 0, 2)
									})}
								>
									{#each mapRows as row, r (r)}
										{#each row as value, c (c)}
											<rect x={c} y={r} width="1.04" height="1" fill={heat(value)} />
										{/each}
									{/each}
								</svg>
							</div>
							<div class="map-axis" aria-hidden="true">
								<span>20</span><span>100</span><span>1k</span><span>10k</span><span>20k</span>
							</div>
						{:else}
							<p class="map-empty">{m.soe_fux_map_empty()}</p>
						{/if}
					</div>
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
		<details class="tech">
			<summary>{m.soe_fux_tech()}</summary>
			<ul>
				<li>{m.soe_engine()}</li>
				<li>Q27 / Q23 · 10 × BIQUAD</li>
				<li>GATE v2 · Q27 / Q23</li>
				<li>DSP / 96 kHz · 96 000 samples / s</li>
			</ul>
			<p>{m.soe_method()}</p>
		</details>
	</div>
	<div class="under-console">
		<section class="method">
			<div class="method-head">
				<span class="method-mark" aria-hidden="true">↳</span>
				<h2>{m.soe_method_title()}</h2>
				<Explainer term="gate" />
			</div>
			<p>{m.soe_fux_method()}</p>
		</section>
		<p>{m.soe_experimental()}</p>
	</div>
	<Tour page="soe-como-x" />
</div>

<style>
	.soe-page {
		--soe-panel: linear-gradient(120deg, #45483e, #363a30);
		/* Text on the olive station panels (#45483e to #363a30, the mock's material). The page's
		   --accent-hi #ff78af (3.80:1) and --muted-hi #a39d92 (3.47:1) are too dark there, so the
		   stations use lighter variants, as the mock does (#ff99c4, #c6c9b7). Asserted in
		   tests/unit/styles/contrast.test.ts. */
		--soe-panel-accent: #ffa3c8; /* 5.03:1 on #45483e, 6.28:1 on #363a30 */
		--soe-panel-muted: var(--text-2, #cfc9be); /* 5.67:1 on #45483e, 7.07:1 on #363a30 */
		position: relative;
		isolation: isolate;
		max-width: 1600px;
		padding: var(--space-7, 36px) var(--space-5, 24px) 0;
		margin: auto;
		color: var(--text, #ece7dd);
		background: radial-gradient(ellipse at 20% 0, #45473a55, transparent 65%), var(--ink, #0f0f0e);
		font: var(--fs-body, 15px) / 1.5 var(--face-body, 'Geist', system-ui, sans-serif);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.hero {
		position: relative;
		display: grid;
		grid-template-columns: 1.3fr 1fr 0.8fr;
		align-items: end;
		gap: var(--space-6, 32px);
		padding: var(--space-4, 16px) 0 var(--space-6, 28px);
		isolation: isolate;
	}
	.seismic {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		z-index: -1;
		fill: none;
		stroke: #2f2e2a;
		stroke-width: 1.1;
		vector-effect: non-scaling-stroke;
	}
	.kicker {
		margin: 0;
		color: var(--accent-text, #ff78af);
	}
	h1 {
		font: 400 var(--fs-display-xl, clamp(72px, 7.8vw, 124px)) / 0.9
			var(--face-display, 'Instrument Serif', Georgia, serif);
		letter-spacing: -0.045em;
		white-space: nowrap;
		margin: var(--space-3, 12px) 0 0;
	}
	h1 em {
		color: var(--accent-text, #ff78af);
	}
	.hero-copy {
		border-left: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		padding-left: var(--space-5, 22px);
		max-width: 380px;
	}
	.hero-copy h2 {
		margin: 0 0 var(--space-2, 10px);
	}
	.hero-copy p {
		color: var(--text-2, #cfc9be);
		font-size: var(--fs-small, 13px);
		line-height: 1.6;
		margin: 0;
	}
	.stamp {
		display: grid;
		justify-items: end;
		gap: var(--space-3, 12px);
	}
	.engine {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2, 8px);
		font: 500 var(--fs-eyebrow, 11px) / 1.6 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
	}
	.engine i {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent-hi, #ff78af);
	}
	.paper-ribbon {
		height: 55px;
		display: flex;
		gap: var(--space-5, 25px);
		align-items: center;
		justify-content: space-between;
		overflow: hidden;
		padding: 0 var(--space-5, 25px);
		margin: 0 9px -1px;
		transform: rotate(-0.25deg);
		background: #dedbce;
		color: #34372e;
		border: 1px solid #9a9b89;
		font: var(--label-min, 11px) var(--face-data, 'JetBrains Mono', monospace);
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
		padding: var(--space-5, 23px) var(--space-4, 20px) var(--space-4, 18px);
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
	.console-top {
		color: var(--text, #ece7dd);
		font: 500 var(--fs-eyebrow, 11px) / 1.5 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.1em;
		padding: 0 3px var(--space-3, 14px);
	}
	.workstation {
		display: grid;
		grid-template-columns: 0.94fr 0.94fr 1.05fr 1.35fr;
		gap: var(--space-3, 14px);
		align-items: stretch;
	}
	.station {
		/* Every accent and secondary text inside a station (CsvImport, Preview, primitives
		   included) inherits the panel-safe variants. */
		--accent-hi: var(--soe-panel-accent);
		--muted-hi: var(--soe-panel-muted);
		position: relative;
		min-width: 0;
		padding: var(--space-3, 13px) var(--space-3, 13px) var(--space-4, 15px);
		background: var(--soe-panel);
		border: 1px solid #151a11;
		border-radius: var(--rad-sm, 3px);
		box-shadow:
			inset 0 1px 0 #a6b38a22,
			1px 2px 3px #0005;
	}
	.station-head {
		display: flex;
		gap: var(--space-2, 9px);
		align-items: center;
		margin-bottom: var(--space-3, 12px);
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
		font: 500 var(--fs-readout, 14px) var(--face-data, 'JetBrains Mono', monospace);
		border-radius: 2px;
	}
	.station-head h2 {
		font: 500 var(--fs-eyebrow, 11px) / 1.3 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
		margin: 0;
	}
	.station-head small {
		font: var(--fs-caption, 12px) / 1.3 var(--face-body, 'Geist', system-ui, sans-serif);
		color: var(--muted-hi, #a39d92);
	}
	label {
		display: block;
		margin: var(--space-3, 11px) 0 var(--space-1, 5px);
		font-size: var(--fs-small, 13px);
		color: var(--text-2, #cfc9be);
	}
	input,
	select {
		box-sizing: border-box;
		min-width: 0;
		width: 100%;
		accent-color: var(--accent, #ff3d8b);
	}
	input[type='search'],
	select {
		min-height: var(--hit, 36px);
		background: var(--well, #101a16);
		color: var(--text, #ece7dd);
		border: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-sm, 3px);
		padding: var(--space-2, 8px);
		font: var(--fs-ui, 14px) var(--face-body, 'Geist', system-ui, sans-serif);
	}
	input:focus-visible,
	select:focus-visible,
	summary:focus-visible {
		outline: 2px solid var(--accent, #ff3d8b);
		outline-offset: 3px;
	}
	p {
		font-size: var(--fs-small, 13px);
		line-height: 1.6;
		color: var(--text-2, #cfc9be);
		overflow-wrap: anywhere;
	}
	.state {
		margin: var(--space-2, 8px) 0 0;
		font-size: var(--fs-caption, 12px);
		color: var(--muted-hi, #a39d92);
	}
	.no-result {
		color: var(--text, #ece7dd);
	}
	.index-loading {
		margin-top: var(--space-3, 11px);
	}
	.trace-name {
		margin: var(--space-3, 12px) 0 var(--space-1, 6px);
		font: 500 var(--fs-small, 13px) var(--face-body, 'Geist', system-ui, sans-serif);
		overflow-wrap: anywhere;
	}
	.target-chart {
		margin-top: var(--space-3, 12px);
	}
	.chart-empty {
		position: relative;
		display: grid;
		place-items: center;
		aspect-ratio: 500 / 245;
		border: 5px solid #20261c;
		border-radius: var(--rad-md, 8px);
		background: var(--well, #101a16);
	}
	.chart-empty svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		stroke: #405448;
		stroke-width: 0.4;
	}
	.chart-empty span {
		position: relative;
		font-size: var(--fs-caption, 12px);
		color: var(--muted-hi, #a39d92);
	}
	.knob-title {
		text-align: center;
		font: 500 var(--fs-eyebrow, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
	}
	.knob {
		display: block;
		width: 150px;
		height: 150px;
		margin: var(--space-2, 8px) auto 0;
	}
	.knob line {
		stroke: #6b6f60;
		stroke-width: 1.4;
	}
	.knob line.lit {
		stroke: var(--accent-hi, #ff78af);
	}
	.arc-track,
	.arc-value {
		fill: none;
		stroke-width: 5;
		stroke-linecap: round;
	}
	.arc-track {
		stroke: #20251c;
	}
	.arc-value {
		stroke: var(--accent-hi, #ff78af);
		filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent-hi, #ff78af) 55%, transparent));
	}
	.cap {
		fill: #2a2e26;
		stroke: #777e65;
		stroke-width: 2;
	}
	.knob .pointer {
		stroke: var(--accent-hi, #ff78af);
		stroke-width: 4;
		stroke-linecap: round;
	}
	.knob-scale {
		display: flex;
		justify-content: space-between;
		font: var(--label-min, 11px) var(--face-data, 'JetBrains Mono', monospace);
		color: var(--muted-hi, #a39d92);
	}
	.speed-value {
		display: block;
		text-align: center;
		color: var(--accent-hi, #ff78af);
		font: 400 var(--fs-readout-l, 26px) var(--face-data, 'JetBrains Mono', monospace);
	}
	.speed-value small {
		font-size: var(--label-min, 11px);
		color: var(--muted-hi, #a39d92);
	}
	.switches {
		margin-top: var(--space-4, 15px);
		padding-top: var(--space-1, 6px);
		border-top: 1px solid #777e65;
	}
	.switch {
		display: flex;
		gap: var(--space-2, 8px);
		align-items: flex-start;
		line-height: 1.6;
	}
	.switch input {
		width: auto;
		margin-top: 3px;
	}
	output {
		font: var(--fs-readout, 14px) var(--face-data, 'JetBrains Mono', monospace);
		color: var(--accent-hi, #ff78af);
	}
	.station :global(.solve) {
		width: 100%;
		margin: var(--space-3, 10px) 0;
	}
	.fit-readout {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3, 12px);
		margin-top: var(--space-4, 16px);
		padding-top: var(--space-3, 12px);
		border-top: 1px solid #777e65;
	}
	.fit-readout div {
		display: grid;
		gap: 2px;
	}
	.fit-readout strong {
		font: 400 clamp(28px, 2.6vw, 38px) / 1 var(--face-data, 'JetBrains Mono', monospace);
		color: var(--accent-hi, #ff78af);
	}
	.fit-readout div + div strong {
		color: var(--text, #ece7dd);
	}
	.fit-readout span {
		font: var(--label-min, 11px) var(--face-data, 'JetBrains Mono', monospace);
		color: var(--muted-hi, #a39d92);
	}
	.result {
		grid-column: 4;
		grid-row: 1 / 3;
		display: flex;
		flex-direction: column;
		background: linear-gradient(110deg, #3a3f33, #2c3227);
	}
	.gate-line,
	.explain-row {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
	}
	.gate-pass {
		margin: 0;
		color: var(--accent-hi, #ff78af);
		font: 500 var(--fs-small, 13px) var(--face-body, 'Geist', system-ui, sans-serif);
	}
	.table-well {
		margin-top: var(--space-2, 8px);
		padding: 6px 7px 8px;
		background: #11190f;
		border: 4px solid #1c2119;
		border-radius: 5px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		color: var(--text-2, #cfc9be);
		font: var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
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
	.explain-row {
		margin-top: var(--space-2, 8px);
		font: var(--label-min, 11px) var(--face-data, 'JetBrains Mono', monospace);
		color: var(--muted-hi, #a39d92);
	}
	.gate-readout {
		display: grid;
		gap: 6px;
		margin-top: var(--space-3, 14px);
		padding: var(--space-2, 10px) 0;
		border-top: 1px solid #606e4f;
	}
	.gate-readout strong {
		font: 400 var(--fs-readout-l, 24px) var(--face-data, 'JetBrains Mono', monospace);
		color: var(--accent-hi, #ff78af);
	}
	.use {
		display: grid;
		gap: var(--space-2, 8px);
		margin-top: var(--space-4, 16px);
	}
	.use p {
		margin: 0;
	}
	.editor-link {
		text-decoration: none;
	}
	.gate-note {
		margin-top: auto;
		padding-top: var(--space-4, 16px);
		color: var(--muted-hi, #a39d92);
	}
	.vent {
		height: 28px;
		background: repeating-linear-gradient(90deg, #141b10 0 3px, transparent 3px 7px);
		margin: var(--space-3, 14px) 0 0;
	}
	.panorama {
		grid-column: 1 / 4;
		grid-row: 2;
		min-width: 0;
		padding: var(--space-3, 12px) var(--space-3, 13px) var(--space-2, 10px);
		border: 1px solid #151d10;
		border-radius: 5px;
		background: linear-gradient(120deg, #343b2c, #2a3024);
	}
	.monitor-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3, 12px);
		flex-wrap: wrap;
		margin: 0 3px var(--space-2, 9px);
		font: 500 var(--fs-eyebrow, 11px) var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
	}
	.monitor-head h2 {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2, 8px);
		font: inherit;
		margin: 0;
	}
	.lamp {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--lamp-off, #3a3833);
	}
	.lamp[data-on='true'] {
		background: var(--accent-hi, #ff78af);
		box-shadow: 0 0 6px var(--accent-hi, #ff78af);
	}
	.iter {
		color: var(--accent-hi, #ff78af);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.screen {
		background: #0b120e;
		border: 8px solid #1b1f19;
		border-radius: 14px 14px 9px 9px;
		box-shadow: inset 0 0 18px #000;
		overflow: hidden;
	}
	.screen h3 {
		margin: var(--space-3, 12px) var(--space-4, 15px);
		font: 500 var(--fs-eyebrow, 11px) var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.06em;
		color: var(--text, #ece7dd);
	}
	.no-trace {
		min-height: 240px;
		display: grid;
		place-items: center;
		font-size: var(--fs-small, 13px);
		color: var(--text-2, #cfc9be);
	}
	.map {
		border-top: 1px solid #263024;
		padding: 0 var(--space-4, 15px) var(--space-3, 12px);
	}
	.map-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3, 12px);
		flex-wrap: wrap;
	}
	.map-head h3 {
		margin-inline: 0;
	}
	.legend {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font: var(--label-min, 11px) var(--face-data, 'JetBrains Mono', monospace);
		color: var(--text-2, #cfc9be);
	}
	.legend i {
		width: 64px;
		height: 4px;
		background: linear-gradient(90deg, rgb(70 106 196), rgb(217 211 196), rgb(214 74 82));
	}
	.map-grid {
		display: grid;
		grid-template-columns: 3.2em 1fr;
		gap: var(--space-2, 8px);
		height: 96px;
	}
	.map-grid svg {
		width: 100%;
		height: 100%;
		display: block;
	}
	.map-iterations {
		display: grid;
		grid-template-rows: repeat(var(--rows, 5), 1fr);
		margin: 0;
		padding: 0;
		list-style: none;
		height: 100%;
		font: var(--label-min, 11px) / 1 var(--face-data, 'JetBrains Mono', monospace);
		color: var(--text-2, #cfc9be);
		text-align: right;
		align-items: center;
	}
	.map-axis {
		display: flex;
		justify-content: space-between;
		margin-left: calc(3.2em + var(--space-2, 8px));
		font: var(--label-min, 11px) var(--face-data, 'JetBrains Mono', monospace);
		color: var(--text-2, #cfc9be);
	}
	.map-empty {
		margin: 0;
		min-height: 96px;
		display: grid;
		place-items: center;
		font-size: var(--fs-caption, 12px);
	}
	.monitor-bottom {
		margin-top: var(--space-3, 12px);
		font: var(--fs-caption, 12px) / 1.6 var(--face-data, 'JetBrains Mono', monospace);
		color: var(--text-2, #cfc9be);
	}
	.missing {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3, 12px);
		flex-wrap: wrap;
		padding: var(--space-3, 12px);
		background: #222a1d;
		border: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-sm, 3px);
		margin-bottom: var(--space-3, 14px);
	}
	.missing p {
		margin: 0;
		color: var(--text, #ece7dd);
	}
	.tech {
		margin-top: var(--space-4, 16px);
		padding: 0 3px;
		color: var(--text-2, #cfc9be);
	}
	.tech summary {
		cursor: pointer;
		min-height: var(--hit, 36px);
		display: flex;
		align-items: center;
		font: 500 var(--fs-small, 13px) var(--face-body, 'Geist', system-ui, sans-serif);
		color: var(--text, #ece7dd);
	}
	.tech ul {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2, 8px) var(--space-5, 24px);
		margin: var(--space-2, 8px) 0;
		padding: 0;
		list-style: none;
		font: var(--label-min, 11px) var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.06em;
	}
	.under-console {
		display: grid;
		grid-template-columns: 1fr 1.1fr;
		gap: var(--space-6, 30px);
		margin: var(--space-5, 24px) 7px var(--section-gap, 48px);
	}
	.method-head {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
	}
	.method-mark {
		color: var(--accent-text, #ff78af);
		font-size: var(--fs-title, 20px);
	}
	.method h2 {
		margin: 0;
		font: 500 var(--fs-ui, 14px) var(--face-body, 'Geist', system-ui, sans-serif);
		color: var(--text, #ece7dd);
	}
	.under-console p {
		color: var(--muted, #8f8a80);
	}
	.under-console .method p {
		color: var(--text-2, #cfc9be);
	}
	@media (max-width: 1080px) {
		.hero {
			grid-template-columns: 1.3fr 1fr;
		}
		.stamp {
			grid-column: 1 / -1;
			justify-items: start;
		}
		.workstation {
			grid-template-columns: repeat(3, 1fr);
		}
		.result {
			grid-column: 1 / 4;
			grid-row: 3;
		}
	}
	@media (max-width: 720px) {
		.soe-page {
			padding: var(--space-6, 27px) var(--space-4, 16px) 0;
		}
		.hero {
			display: block;
		}
		h1 {
			font-size: var(--fs-display-l, 80px);
		}
		.hero-copy {
			margin-top: var(--space-5, 22px);
			max-width: none;
			padding-left: var(--space-4, 15px);
		}
		.stamp {
			justify-items: start;
			margin-top: var(--space-4, 16px);
		}
		.paper-ribbon {
			padding-inline: var(--space-3, 12px);
			margin-inline: 5px;
			height: 43px;
			gap: var(--space-2, 10px);
		}
		.chassis {
			padding: var(--space-4, 18px) var(--space-2, 10px) var(--space-3, 13px);
		}
		/* One column: measurement, target, correction, result and monitor stack. */
		.workstation {
			grid-template-columns: 1fr;
			gap: var(--space-3, 10px);
		}
		.workstation > :global(*) {
			grid-column: 1 / -1;
			grid-row: auto;
		}
		.station {
			padding: var(--space-3, 12px);
		}
		.screen {
			border-width: 5px;
		}
		.under-console {
			grid-template-columns: 1fr;
			gap: var(--space-3, 10px);
		}
	}
</style>
