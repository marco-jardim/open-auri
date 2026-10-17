<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { numberLabel } from '#lib/charts/scales.ts';
	import type { AudioEngine, ABPreview, ABSide } from '#lib/audio/engine.ts';
	import {
		tap,
		createSpectrumAnalyser,
		type MeterTap,
		type MeterMode,
		type MeterUpdate,
		type VuReference
	} from '#lib/audio/meters.ts';
	import { VuMeter, MeterModeLabel, SpectrumOverlay } from '#lib/components/meters/index.ts';
	import { Button } from '#lib/components/primitives/index.ts';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import type { CurveData } from '#lib/state/model.ts';
	let {
		audio,
		current,
		candidate,
		reference = -18
	}: {
		audio: AudioEngine | null;
		current: CurveData | null;
		candidate: CurveData;
		reference?: VuReference;
	} = $props();
	let selected = $state<ABSide>('B');
	let playing = $state(false);
	let pending = $state(false);
	let active = $state(false);
	let error = $state(false);
	let exact = $state(true);
	let analyser = $state.raw<AnalyserNode | null>(null);
	let a = $state.raw<MeterUpdate>({ mode: 'data', frame: null });
	let b = $state.raw<MeterUpdate>({ mode: 'data', frame: null });
	/** Real trims the engine applied so A and B play at the same levelDb (null until created). */
	let trims = $state.raw<readonly [number, number] | null>(null);
	let preview: ABPreview | null = null;
	// Reactive so the reference effect also reaches taps attached after it last ran.
	let taps = $state.raw<MeterTap[]>([]);
	let stops: (() => void)[] = [];
	let spectrumNode: AudioNode | null = null;
	let generation = 0;
	/** The engine this preview put in chain mode; it stops it when the audition ends. */
	let startedBy: AudioEngine | null = null;

	function release() {
		const engine = startedBy;
		startedBy = null;
		if (engine && engine.state().mode === 'chains') engine.stop();
	}

	function dispose() {
		generation++;
		for (const stop of stops) stop();
		stops = [];
		// Whatever this preview made audible stops with it (page change, unmount, new snapshot).
		release();
		for (const handle of taps) handle.disconnect();
		taps = [];
		if (analyser && spectrumNode) spectrumNode.disconnect(analyser);
		analyser?.disconnect();
		analyser = null;
		spectrumNode = null;
		preview?.dispose();
		preview = null;
		// The shared source belongs to the chrome: it is stopped only if this preview started it.
		active = false;
		playing = false;
		pending = false;
		trims = null;
		a = { mode: 'data', frame: null };
		b = { mode: 'data', frame: null };
	}
	$effect(() => {
		// Editor/result changes invalidate the audition snapshot, without starting audio.
		void current;
		void candidate;
		void audio;
		untrack(dispose);
		return () => untrack(dispose);
	});
	$effect(() => {
		const ref = reference;
		for (const handle of taps) handle.setReference(ref);
	});
	function spectrum() {
		if (analyser && spectrumNode) spectrumNode.disconnect(analyser);
		analyser?.disconnect();
		spectrumNode = preview ? (selected === 'A' ? preview.a.output : preview.b.output) : null;
		analyser = spectrumNode ? createSpectrumAnalyser(spectrumNode) : null;
	}
	function select(side: ABSide) {
		selected = side;
		preview?.select(side);
		if (preview) spectrum();
	}
	async function listen() {
		if (!audio || !current || pending) return;
		if (preview) {
			if (audio.state().mode === 'chains') audio.stop();
			startedBy = null;
			dispose();
			return;
		}
		error = false;
		pending = true;
		const engine = audio;
		const token = ++generation;
		try {
			preview = engine.createAB(current, candidate, { initial: selected, experimental: true });
			trims = preview.trims;
			active = true;
			const aNode = engine.getChainOutput(preview.a.id);
			const bNode = engine.getChainOutput(preview.b.id);
			if (!aNode || !bNode) throw new Error('preview:missing-chain');
			exact = engine.state().exact;
			stops.push(
				engine.onChange((state) => {
					playing = state.playing && state.mode === 'chains';
					exact = state.exact;
					// Stopped or switched to raw elsewhere (chrome): no longer ours to stop.
					if (state.mode !== 'chains' && startedBy === engine) startedBy = null;
				})
			);
			// Called before the first await, while the click still has user activation.
			await engine.start('chains');
			if (token !== generation) {
				// Disposed (unmount, new snapshot) while starting: nothing of ours may keep playing.
				if (engine.state().mode === 'chains') engine.stop();
				return;
			}
			startedBy = engine;
			const first = await tap(aNode, { kinds: ['vu'], reference });
			if (token !== generation) {
				first.disconnect();
				return;
			}
			taps = [...taps, first];
			const second = await tap(bNode, { kinds: ['vu'], reference });
			if (token !== generation) {
				second.disconnect();
				return;
			}
			taps = [...taps, second];
			stops.push(first.subscribe((update) => (a = update)));
			stops.push(second.subscribe((update) => (b = update)));
			spectrum();
		} catch (cause) {
			if (token === generation) {
				console.warn('Soe como X preview unavailable', cause);
				dispose();
				error = true;
			}
		} finally {
			if (token === generation) pending = false;
		}
	}
	const listenReason = $derived(
		!audio ? m.soe_fux_audio_loading() : !current ? m.soe_fux_editor_loading() : null
	);
	const modeA = $derived(playing ? a.mode : 'data');
	const modeB = $derived(playing ? b.mode : 'data');
	const mode = $derived(selected === 'A' ? modeA : modeB);
	function db(value: number) {
		return numberLabel(value, getLocale(), 1);
	}
</script>

{#snippet vu(mode: MeterMode, reading: number | null, label: string)}
	<MeterModeLabel {mode} />
	{#if mode === 'live' && reading !== null}
		<VuMeter mode="live" live={reading} {label} />
	{:else}
		<div
			class="idle-vu"
			role="img"
			aria-label={`${label}: ${m.meter_no_data()}`}
			data-mode="data"
			data-dark="true"
		>
			<span>{label}</span>
			<span aria-hidden="true">∅</span>
			<span>{m.meter_no_data()}</span>
		</div>
	{/if}
{/snippet}

<section class="preview" aria-label={m.soe_preview()}>
	<div class="head">
		<h3>{m.soe_preview()}</h3>
		<Explainer term="ab-nivel" />
	</div>
	<div class="buttons">
		<Button
			size="sm"
			variant="primary"
			disabledReason={listenReason}
			loading={pending}
			onclick={listen}
			aria-pressed={playing}>{active ? m.soe_stop_preview() : m.soe_listen()}</Button
		>
		<Button
			size="sm"
			variant="key"
			lit={selected === 'A'}
			aria-pressed={selected === 'A'}
			aria-label={m.soe_current()}
			onclick={() => select('A')}>A</Button
		>
		<Button
			size="sm"
			variant="key"
			lit={selected === 'B'}
			aria-pressed={selected === 'B'}
			aria-label={m.soe_candidate()}
			onclick={() => select('B')}>B</Button
		>
	</div>
	{#if trims}
		<p class="level" role="status">{m.soe_fux_level({ a: db(trims[0]), b: db(trims[1]) })}</p>
	{/if}
	<div class="meters">
		<div>
			{@render vu(modeA, a.frame?.vuL ?? null, 'A / VU')}
		</div>
		<div>
			{@render vu(modeB, b.frame?.vuL ?? null, 'B / VU')}
		</div>
	</div>
	<MeterModeLabel {mode} />
	<SpectrumOverlay {mode} {analyser} label={m.soe_spectrum()} />
	<p>{m.soe_preview_note()}</p>
	{#if !exact}
		<p role="status">{m.soe_approximate()}</p>
	{/if}
	{#if error}
		<p role="alert">{m.soe_audio_error()}</p>
	{/if}
</section>

<style>
	.preview {
		/* Its own dark hardware surface, so the light token text keeps its contrast standalone
		   (muted-hi #a39d92 on #2c3227 is 4.9:1; text-2 #cfc9be is 8.0:1). */
		margin-top: var(--space-4, 16px);
		padding: var(--space-3, 12px);
		background: #2c3227;
		border: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-md, 6px);
		color: var(--text, #ece7dd);
		--oa-meter-ink: var(--text, #ece7dd);
		--oa-meter-over: #ff9d9d;
		--oa-meter-data: var(--muted-hi, #a39d92);
		--oa-meter-live: var(--accent-hi, #ff78af);
		--oa-meter-spectrum: var(--accent-hi, #ff78af);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2, 8px);
		margin-bottom: var(--space-2, 8px);
	}
	h3 {
		margin: 0;
		font: 500 var(--fs-eyebrow, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.buttons {
		display: flex;
		gap: var(--space-2, 8px);
		flex-wrap: wrap;
	}
	.level {
		font-family: var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
		color: var(--accent-hi, #ff78af);
	}
	.meters {
		display: grid;
		grid-template-columns: 1fr 1fr;
		margin-top: var(--space-3, 12px);
	}
	.meters > div {
		min-width: 0;
	}
	.idle-vu {
		box-sizing: border-box;
		aspect-ratio: 200 / 124;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		margin: 8px 3px;
		border: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-md, 8px);
		background: var(--well, #11150f);
		color: var(--muted-hi, #a39d92);
		font: var(--label-min, 11px) var(--face-data, 'JetBrains Mono', monospace);
	}
	p {
		font: var(--fs-caption, 12px) / 1.6 var(--face-body, 'Geist', system-ui, sans-serif);
		color: var(--text-2, #cfc9be);
	}
	[role='alert'] {
		color: #ffc3c5;
	}
</style>
