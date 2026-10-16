<script lang="ts">
	import { untrack } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
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
	let preview: ABPreview | null = null;
	let taps: MeterTap[] = [];
	let stops: (() => void)[] = [];
	let spectrumNode: AudioNode | null = null;
	let generation = 0;

	function dispose() {
		generation++;
		for (const stop of stops) stop();
		stops = [];
		for (const handle of taps) handle.disconnect();
		taps = [];
		if (analyser && spectrumNode) spectrumNode.disconnect(analyser);
		analyser?.disconnect();
		analyser = null;
		spectrumNode = null;
		preview?.dispose();
		preview = null;
		// The shared source belongs to the chrome. Cleanup only releases this page's graph.
		active = false;
		playing = false;
		pending = false;
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
			dispose();
			return;
		}
		error = false;
		pending = true;
		const engine = audio;
		const token = ++generation;
		try {
			preview = engine.createAB(current, candidate, { initial: selected, experimental: true });
			active = true;
			const aNode = engine.getChainOutput(preview.a.id);
			const bNode = engine.getChainOutput(preview.b.id);
			if (!aNode || !bNode) throw new Error('preview:missing-chain');
			exact = engine.state().exact;
			stops.push(
				engine.onChange((state) => {
					playing = state.playing && state.mode === 'chains';
					exact = state.exact;
				})
			);
			// Called before the first await, while the click still has user activation.
			await engine.start('chains');
			if (token !== generation) return;
			const first = await tap(aNode, { kinds: ['vu'], reference });
			if (token !== generation) {
				first.disconnect();
				return;
			}
			taps.push(first);
			const second = await tap(bNode, { kinds: ['vu'], reference });
			if (token !== generation) {
				second.disconnect();
				return;
			}
			taps.push(second);
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
	const modeA = $derived(playing ? a.mode : 'data');
	const modeB = $derived(playing ? b.mode : 'data');
	const mode = $derived(selected === 'A' ? modeA : modeB);
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
	<h3>{m.soe_preview()}</h3>
	<div class="buttons">
		<button
			type="button"
			disabled={!audio || !current || pending}
			onclick={listen}
			aria-pressed={playing}>{active ? m.soe_stop_preview() : m.soe_listen()}</button
		>
		<button
			type="button"
			aria-pressed={selected === 'A'}
			aria-label={m.soe_current()}
			onclick={() => select('A')}>A</button
		>
		<button
			type="button"
			aria-pressed={selected === 'B'}
			aria-label={m.soe_candidate()}
			onclick={() => select('B')}>B</button
		>
	</div>
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
		margin-top: 18px;
		padding-top: 12px;
		border-top: 1px solid #6d775e;
		background: #2c3227;
		color: #e1e8d5;
		--oa-meter-ink: #e1e8d5;
		--oa-meter-over: #ff9d9d;
		--oa-meter-data: #d4dec8;
		--oa-meter-live: #ff99c4;
		--oa-meter-spectrum: #ff99c4;
	}
	h3 {
		font: 12px var(--font-mono, monospace);
		margin: 0 0 10px;
	}
	.buttons {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	button {
		border: 1px solid #859175;
		border-radius: 3px;
		padding: 8px;
		background: #20281a;
		color: #e3e9d8;
		cursor: pointer;
	}
	button[aria-pressed='true'] {
		color: #ffb2d2;
		border-color: #ff99c4;
	}
	button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	button:focus-visible {
		outline: 2px solid #ff99c4;
		outline-offset: 3px;
	}
	.meters {
		display: grid;
		grid-template-columns: 1fr 1fr;
		margin-top: 12px;
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
		border: 1px solid #536248;
		border-radius: 8px;
		background: #192115;
		color: #b3bfa7;
		font: 11px var(--font-mono, monospace);
	}
	p {
		font-size: 11px;
		line-height: 1.6;
		color: #d4dec8;
	}
	[role='alert'] {
		color: #ffc3c5;
	}
</style>
