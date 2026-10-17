<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import SocialSources from './SocialSources.svelte';
	import { createCurveSocial, type CurveSocial } from './social.svelte.ts';
	import { SvelteMap } from 'svelte/reactivity';
	import { curveResponseDb } from 'open-auri/dsp';
	import { getPreset } from 'open-auri/catalog';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import type { MeterSource } from '#lib/audio/meters.ts';
	import { IDLE_STATE } from '#lib/audio/engine.ts';
	import { createGateWorker } from '#lib/workers/gate-client.ts';
	import { frequencyLabel, numberLabel } from '#lib/charts/scales.ts';
	import { Button } from '#lib/components/primitives/index.ts';
	import { Explainer, Tour, TourTrigger } from '#lib/components/comprehension/index.ts';
	import { copy } from './copy.ts';
	import {
		initialTracks,
		visibleTracks,
		compareCurves,
		patchBay,
		snapshotCurve,
		type NamedCurve
	} from './comparison.ts';
	import { createTrackChains } from './chains.ts';
	import { comparisonSvg, downloadComparison } from './export.ts';
	import { OUTPUT_LIMIT_DB, OVERLAY_RANGE_DB } from './plot.ts';
	import ComparisonPlot from './ComparisonPlot.svelte';
	import TrackLane from './TrackLane.svelte';
	import TapeDeck from './TapeDeck.svelte';
	import BlendPanel from './BlendPanel.svelte';
	import './comparar.css';

	let {
		app = null,
		locale = 'pt-BR',
		social = createCurveSocial()
	}: {
		app?: ClientApp | null;
		locale?: 'pt-BR' | 'en-US';
		social?: CurveSocial;
	} = $props();
	let socialTrack = $state(1);
	onMount(() => social.mount());
	const t = $derived(copy(locale));
	let tracks = $state.raw(initialTracks());
	let selected = $state(1);
	let pairA = $state(1);
	let pairB = $state(2);
	let matched = $state(true);
	let threshold = $state(1);
	let includeDelta = $state(true);
	let audioState = $state.raw({ ...IDLE_STATE });
	let active = $state(false);
	let error = $state('');
	let meters = $state.raw<Record<number, MeterSource | null>>({});
	let chains = $state.raw<ReturnType<typeof createTrackChains> | null>(null);
	let disposed = false;
	/** Play attempts; unmount bumps it so a start still in flight knows to stop. */
	let attempt = 0;
	/** The engine this page put in chain mode (only its own Play does that). */
	let startedBy: ClientApp['audio'] | null = null;

	/** Stops the engine only if this page started it and it is still in chain mode. */
	function release() {
		const engine = startedBy;
		startedBy = null;
		if (engine && engine.state().mode === 'chains') engine.stop();
	}
	const loadTokens = new SvelteMap<number, number>();
	const loadGates = new SvelteMap<number, ReturnType<typeof createGateWorker>>();
	const armed = $derived(tracks.filter((track) => track.armed));
	const a = $derived(armed.find((track) => track.id === pairA) ?? armed[0]);
	const b = $derived(armed.find((track) => track.id === pairB) ?? armed[1] ?? armed[0]);
	const comparison = $derived(a && b ? compareCurves(a.curve, b.curve, matched, threshold) : null);
	const matrix = $derived(patchBay(tracks, matched, threshold));
	const exportSvg = $derived(
		a && b ? comparisonSvg(a.curve, b.curve, matched, threshold, includeDelta, locale, t) : ''
	);
	// This page's own audition: chain mode left on by another page does not count.
	const playing = $derived(active && audioState.playing && audioState.mode === 'chains');
	const playReason = $derived(!app ? t.reasonEngine : armed.length === 0 ? t.reasonArm : null);
	/** Real writes counted by the cable service in this browser (never simulated ones). */
	const writes = $derived(app ? app.state.flash.state.total : null);
	const drums = $derived(
		writes === null ? ['·', '·', '·', '·'] : [...String(Math.min(9999, writes)).padStart(4, '0')]
	);
	const bayStep = $derived(armed.length > 1 ? 840 / (armed.length - 1) : 0);
	const bayX = (index: number) => 130 + index * bayStep;
	const cableA = $derived(a ? armed.findIndex((track) => track.id === a.id) : -1);
	const cableB = $derived(b ? armed.findIndex((track) => track.id === b.id) : -1);

	/** The trim the A/B really applies to a lane (graph, distances and audition share it). */
	function laneTrim(id: number): { tag: 'A' | 'B' | null; trim: number | null } {
		if (!comparison || !a || !b) return { tag: null, trim: null };
		if (id === a.id) return { tag: 'A', trim: comparison.trims[0] };
		if (id === b.id) return { tag: 'B', trim: comparison.trims[1] };
		return { tag: null, trim: null };
	}

	$effect(() => {
		if (!app) return;
		const engine = app.audio;
		const meterRef = app.state.meterRef;
		const manager = createTrackChains(
			engine,
			(id, meter) => {
				untrack(() => {
					meters = { ...meters, [id]: meter };
				});
			},
			undefined,
			() => meterRef.value
		);
		chains = manager;
		audioState = engine.state();
		const unsubscribe = engine.onChange((next) => {
			audioState = next;
		});
		return () => {
			unsubscribe();
			attempt++;
			manager.dispose();
			release();
			untrack(() => {
				active = false;
			});
		};
	});
	$effect(() => {
		const nextTracks = tracks;
		const manager = chains;
		// Only this page's own Play builds chains: the engine being left playing by another page
		// (audioState.playing) must never make this page audible.
		if (active && manager)
			untrack(() => {
				void manager.sync(nextTracks).catch((cause: unknown) => {
					console.error('Comparison chains failed', cause);
					if (!disposed) error = t.audioFailed;
				});
			});
	});
	$effect(() => {
		chains?.configure([a?.id ?? 1, b?.id ?? 2], matched);
		chains?.select(selected);
	});
	onDestroy(() => {
		disposed = true;
		attempt++;
		for (const gate of loadGates.values()) gate.dispose();
		release();
	});

	async function source(id: number, value: string) {
		const token = (loadTokens.get(id) ?? 0) + 1;
		loadTokens.set(id, token);
		let curve: NamedCurve | undefined;
		if (value === 'current' && app) curve = snapshotCurve(app.state.curve.current);
		else if (value.startsWith('library:')) {
			const item = app?.state.library.items.find((item) => item.id === value.slice(8));
			if (item) curve = snapshotCurve(item);
		} else if (value.startsWith('preset:')) {
			const preset = getPreset(value.slice(7));
			if (preset)
				curve = snapshotCurve({ name: preset.label, source: `preset:${preset.id}`, ...preset });
		}
		if (!curve) {
			error = t.failed;
			return;
		}
		const snapshot = curve;
		try {
			let gate = loadGates.get(id);
			if (!gate) {
				gate = createGateWorker();
				loadGates.set(id, gate);
			}
			const { verdict } = await gate.commit({ ...snapshot, experimental: true });
			if (disposed || loadTokens.get(id) !== token) return;
			if (!verdict.ok) {
				error = `${t.invalidCurve} ${verdict.reasons.map((reason) => reason.code).join(', ')}`;
				return;
			}
			error = '';
			tracks = tracks.map((track) =>
				track.id === id ? { ...track, curve: snapshotCurve(snapshot) } : track
			);
		} catch (cause) {
			if (!disposed && loadTokens.get(id) === token) {
				console.error('Comparison curve load failed', cause);
				error = t.failed;
			}
		}
	}

	function toggle(id: number, key: 'armed' | 'solo' | 'mute') {
		tracks = tracks.map((track) => (track.id === id ? { ...track, [key]: !track[key] } : track));
		const visible = visibleTracks(tracks);
		if (!visible.some((track) => track.id === selected)) {
			selected = visible[0]?.id ?? 0;
		}
	}

	async function play() {
		if (!app || !chains || !a || !b) return;
		const engine = app.audio;
		const manager = chains;
		const token = ++attempt;
		if (playing) {
			manager.setAudible(false);
			active = false;
			startedBy = null;
			engine.stop();
			return;
		}
		error = '';
		active = true;
		try {
			manager.configure([a.id, b.id], matched);
			if (!armed.some((track) => track.id === selected)) selected = a.id;
			manager.select(selected);
			// The page's own Play is the only path that makes a lane audible.
			manager.setAudible(true);
			// Both calls run in the click before yielding, preserving browser user activation.
			const ready = manager.sync(tracks);
			const started = engine.start('chains');
			startedBy = engine;
			await Promise.all([ready, started]);
			if (token !== attempt && (disposed || manager !== chains)) {
				// Unmounted (or the app changed) while starting: the engine only reached chain mode
				// after the cleanup ran, so stop it here; nothing of this page may keep playing.
				if (engine.state().mode === 'chains') engine.stop();
				if (startedBy === engine) startedBy = null;
			}
		} catch (cause) {
			if (token !== attempt) return;
			console.error('Comparison preview failed', cause);
			error = t.audioFailed;
			manager.setAudible(false);
			active = false;
			startedBy = null;
			engine.stop();
		}
	}

	function bounce(id: number, curve: NamedCurve) {
		loadTokens.set(id, (loadTokens.get(id) ?? 0) + 1);
		tracks = tracks.map((track) =>
			track.id === id ? { ...track, curve: snapshotCurve(curve), armed: true } : track
		);
	}

	async function exportFile(format: 'svg' | 'png') {
		try {
			await downloadComparison(exportSvg, format);
		} catch (cause) {
			console.error('Comparison export failed', cause);
			error = t.failed;
		}
	}
</script>

<svelte:head>
	<title>{t.title} · open-auri</title>
	<meta name="description" content={t.lede} />
</svelte:head>

<div class="comparar">
	<div class="cabinet">
		{#each ['tl', 'tr', 'bl', 'br'] as corner (corner)}
			<span class="screw {corner}" aria-hidden="true"></span>
		{/each}
		<header class="intro">
			<p class="kicker">{t.kicker}</p>
			<h1>{t.titleOne} <em>{t.titleTwo}</em></h1>
			<p class="lede">{t.lede}</p>
			<div class="intro-help"><TourTrigger page="comparar" /></div>
		</header>
		<Tour page="comparar" />
		<div class="deck">
			<TapeDeck
				label={t.deck}
				{playing}
				plate={t.deckPlate}
				heads={[t.headExtra, t.headErase, t.headRec, t.headPlay]}
				status={playing ? t.deckPlaying : t.deckIdle}
			/>
			<div class="transport" role="group" aria-label={t.transport}>
				<Button
					variant="key"
					size="lg"
					class="tkey-play"
					lit={playing}
					aria-pressed={playing}
					disabledReason={playReason}
					onclick={play}
				>
					<span aria-hidden="true">{playing ? '■' : '▶'}</span>
					{playing ? t.stop : t.play}
				</Button>
				<a class="tkey rec" href="#comparar-blend">
					<span aria-hidden="true">●</span>{t.rec}
				</a>
				<p>{t.sourceNote}</p>
				<span class="counter">
					<span class="drums" aria-hidden="true">
						{#each drums as digit, index (index)}<span class="drum">{digit}</span>{/each}
					</span>
					{#if writes !== null}<span class="sr-only">{writes}</span>{/if}
					<span>{t.counter}</span>
				</span>
			</div>
		</div>
		{#if !audioState.exact}<p class="notice">{t.rateNote}</p>{/if}
		{#if error}<p class="notice error" role="alert">{error}</p>{/if}
		<section class="panel" aria-labelledby="comparar-tracks-title" data-tour="comparar-tracks">
			<h2 class="plate" id="comparar-tracks-title">{t.tracks}</h2>
			<p class="note">{t.tracksNote}</p>
			<p class="note level-note">{t.levelTrimNote} <Explainer term="ab-nivel" /></p>
			<label class="field"
				>{m.curve_social_track()}<select bind:value={socialTrack}>
					{#each tracks as track (track.id)}<option value={track.id}>{t.track} {track.id}</option
						>{/each}
				</select></label
			>
			<SocialSources {social} path="/comparar" onload={(curve) => bounce(socialTrack, curve)} />
			<div class="lanes">
				{#each tracks as track (track.id)}
					{@const level = laneTrim(track.id)}
					<TrackLane
						{track}
						{t}
						{locale}
						{playing}
						{matched}
						pairTag={level.tag}
						trimDb={level.trim}
						tourArm={track.id === 1}
						selected={selected === track.id}
						meter={meters[track.id]}
						library={app?.state.library.items ?? []}
						onSource={(value) => {
							void source(track.id, value);
						}}
						onToggle={(key) => toggle(track.id, key)}
						onSelect={() => {
							selected = track.id;
						}}
					/>
				{/each}
			</div>
			<div class="main-plot">
				<ComparisonPlot
					label={t.overlay}
					description={t.responseNote}
					{locale}
					fixedRange={OVERLAY_RANGE_DB}
					limit={{ db: OUTPUT_LIMIT_DB, label: t.outputLimit }}
					peakLabel={t.peak}
					lines={visibleTracks(tracks).map((track) => ({
						name: `${track.id} · ${track.curve.name}`,
						values: curveResponseDb(track.curve),
						color: track.color
					}))}
				/>
				<p class="note scale-note">{t.scaleNote}</p>
			</div>
		</section>
		<section class="panel difference-panel" aria-labelledby="comparar-difference-title">
			<h2 class="plate" id="comparar-difference-title">{t.where}</h2>
			{#if a && b && comparison}
				<div class="difference-controls" data-tour="comparar-level">
					<label class="field">
						{t.before}
						<select
							value={a.id}
							onchange={(event) => {
								pairA = Number(event.currentTarget.value);
							}}
						>
							{#each armed as track (track.id)}
								<option value={track.id}>{track.id} · {track.curve.name}</option>
							{/each}
						</select>
					</label>
					<button
						type="button"
						class="chip-btn swap"
						onclick={() => {
							const oldA = a.id;
							pairA = b.id;
							pairB = oldA;
						}}>{t.swap} ⇅</button
					>
					<label class="field">
						{t.after}
						<select
							value={b.id}
							onchange={(event) => {
								pairB = Number(event.currentTarget.value);
							}}
						>
							{#each armed as track (track.id)}
								<option value={track.id}>{track.id} · {track.curve.name}</option>
							{/each}
						</select>
					</label>
					<span class="match-row">
						<label class="check">
							<input type="checkbox" bind:checked={matched} />{t.match}
						</label>
						<Explainer term="ab-nivel" />
					</span>
					<label class="field threshold">
						{t.threshold} · {numberLabel(threshold, locale, 1)} dB
						<input type="range" min="0" max="12" step="0.1" bind:value={threshold} />
					</label>
				</div>
				<p class="note match-note">{t.matchNote}</p>
				<div class="difference-data">
					<ComparisonPlot
						label={t.where}
						description={t.delta}
						{locale}
						lines={[{ name: 'Δ = B − A', values: comparison.delta, color: '#f2b33d' }]}
						regions={comparison.regions}
					/>
					<div class="difference-summary">
						<div class="stats">
							<div class="stat">
								<small>RMS</small><output>{numberLabel(comparison.rmsDb, locale, 2)} dB</output>
							</div>
							<div class="stat">
								<small>{t.max}</small><output>{numberLabel(comparison.maxDb, locale, 2)} dB</output>
								<span class="sub">{frequencyLabel(comparison.maxFreqHz, locale)} Hz</span>
							</div>
							<div class="stat">
								<small>{t.regions}</small><output>{comparison.regions.length}</output>
							</div>
						</div>
						<ul class="regions">
							{#each comparison.regions as region (region.fromHz)}
								<li>
									{frequencyLabel(region.fromHz, locale)}–{frequencyLabel(region.toHz, locale)} Hz
									<span class="mono">{t.peak} {numberLabel(region.peakDiffDb, locale, 2)} dB</span>
								</li>
							{:else}<li>{t.noRegions}</li>{/each}
						</ul>
						<div class="ab-box" role="group" aria-label={t.play}>
							<button
								type="button"
								class="chip-btn"
								aria-pressed={selected === a.id}
								onclick={() => {
									selected = a.id;
								}}>A · {a.curve.name}</button
							>
							<button
								type="button"
								class="chip-btn"
								aria-pressed={selected === b.id}
								onclick={() => {
									selected = b.id;
								}}>B · {b.curve.name}</button
							>
						</div>
					</div>
				</div>
			{:else}<p class="note">{t.empty}</p>{/if}
		</section>
		<section class="panel patch-bay-panel" aria-labelledby="comparar-bay-title">
			<h2 class="plate" id="comparar-bay-title">{t.bay}</h2>
			<p class="note">{t.bayNote}</p>
			{#if armed.length > 1}
				<svg class="bay-cables" viewBox="0 0 1000 132" role="img" aria-label={t.bayCables}>
					<title>{t.bayCables}</title>
					<rect x="2" y="2" width="996" height="128" rx="8" fill="#141311" stroke="#3a3833" />
					<text class="bay-row" x="16" y="34">{t.bayOut}</text>
					<text class="bay-row" x="16" y="104">{t.bayIn}</text>
					{#each armed as track, index (track.id)}
						{#each [30, 100] as cy (cy)}
							<circle
								cx={bayX(index)}
								{cy}
								r="11"
								fill="#0a0a09"
								stroke="#8c938a"
								stroke-width="2"
							/>
							<circle cx={bayX(index)} {cy} r="4" fill="#000" />
						{/each}
						<text class="bay-id" x={bayX(index)} y="70" fill={track.color}>{track.id}</text>
					{/each}
					{#if cableA >= 0 && cableB >= 0 && cableA !== cableB}
						{@const xa = bayX(cableA)}
						{@const xb = bayX(cableB)}
						<path
							class="cable"
							d="M{xa} 30 C{xa} {96 + Math.abs(xb - xa) / 6}, {xb} {34 +
								Math.abs(xb - xa) / 6}, {xb} 100"
							fill="none"
							stroke={a?.color ?? '#f2b33d'}
							stroke-width="6"
							stroke-linecap="round"
						/>
						{#each [{ x: xa, y: 30 }, { x: xb, y: 100 }] as plug (plug.y)}
							<circle
								cx={plug.x}
								cy={plug.y}
								r="8"
								fill="#d9d4c8"
								stroke="#2a2724"
								stroke-width="2"
							/>
						{/each}
					{/if}
				</svg>
				<div class="bay">
					<table>
						<caption class="sr-only">{t.bay}</caption>
						<thead>
							<tr>
								<th scope="col">{t.track}</th>
								{#each armed as track (track.id)}
									<th scope="col">
										<span class="jack hdr" aria-hidden="true"></span>
										<span class="bay-label">{track.id}</span><small>{track.curve.name}</small>
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each armed as row, rowIndex (row.id)}
								<tr>
									<th scope="row">
										<span class="jack hdr" aria-hidden="true"></span>{row.id}
										<small>{row.curve.name}</small>
									</th>
									{#each armed as column, columnIndex (column.id)}
										<td>
											{#if row.id === column.id}<span class="diagonal">·</span>
											{:else}
												<button
													type="button"
													class="bay-cell"
													class:on={a?.id === row.id && b?.id === column.id}
													aria-label="{t.pair} {row.id} / {column.id} · {numberLabel(
														matrix[rowIndex][columnIndex],
														locale,
														2
													)} dB RMS"
													onclick={() => {
														pairA = row.id;
														pairB = column.id;
													}}
												>
													<span class="jack" aria-hidden="true"></span>
													<span>{numberLabel(matrix[rowIndex][columnIndex], locale, 2)}</span>
												</button>
											{/if}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}<p class="note">{t.empty}</p>{/if}
		</section>
		<BlendPanel {tracks} {t} {locale} {app} {social} onBounce={bounce} />
		<section class="panel" aria-labelledby="comparar-export-title">
			<h2 class="plate" id="comparar-export-title">{t.export}</h2>
			<div class="grid-ex">
				<div>
					<p class="note">{t.exportNote}</p>
					<label class="check">
						<input type="checkbox" bind:checked={includeDelta} />{t.exportDelta}
					</label>
					<div class="actions">
						<Button
							variant="plate"
							disabledReason={exportSvg ? null : t.empty}
							onclick={() => exportFile('svg')}
						>
							{t.exportSvg}
						</Button>
						<Button
							variant="plate"
							disabledReason={exportSvg ? null : t.empty}
							onclick={() => exportFile('png')}
						>
							{t.exportPng}
						</Button>
					</div>
				</div>
				{#if exportSvg}
					<div class="preview">
						<img
							src="data:image/svg+xml;charset=utf-8,{encodeURIComponent(exportSvg)}"
							alt={t.exportPreview}
							width="1000"
							height="540"
						/>
					</div>
				{/if}
			</div>
		</section>
	</div>
</div>

<style>
	.intro {
		position: relative;
	}
	.intro-help {
		position: absolute;
		top: 0;
		right: 0;
	}
	.counter {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		margin-left: auto;
		color: #cfc6b2;
		font-size: var(--fs-caption, 12px);
	}
	.drums {
		display: inline-flex;
		gap: 2px;
		padding: 3px;
		border-radius: 3px;
		background: #0a0a09;
		box-shadow:
			inset 0 1px 3px #000,
			0 1px 0 #ffffff26;
	}
	.drum {
		display: inline-block;
		width: 16px;
		padding: 2px 0;
		border-radius: 2px;
		color: #f4efe2;
		background: linear-gradient(#111 0, #2b2a27 45%, #2b2a27 55%, #111 100%);
		font-family: var(--face-data);
		font-size: var(--fs-ui, 14px);
		font-variant-numeric: tabular-nums slashed-zero;
		text-align: center;
	}
	.match-row {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.level-note,
	.scale-note {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.bay-cables {
		display: block;
		width: 100%;
		height: auto;
		margin-bottom: 10px;
	}
	.bay-row {
		fill: #cfc6b2;
		font-family: var(--plate);
		font-size: 12px;
		letter-spacing: 0.1em;
	}
	.bay-id {
		font-family: var(--face-data);
		font-size: 13px;
		text-anchor: middle;
	}
	.cable {
		filter: drop-shadow(0 3px 2px #000a);
		transition: d var(--dur-slow, 0.36s) var(--ease-out, ease-out);
	}
	@media (prefers-reduced-motion: reduce) {
		.cable {
			transition: none;
		}
	}
</style>
