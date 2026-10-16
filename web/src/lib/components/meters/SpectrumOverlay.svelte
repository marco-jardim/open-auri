<!--
	Live spectrum drawn from an AnalyserNode (display only; level readings come from the worklet).
	It draws only in live mode with an analyser; otherwise the canvas is cleared and no frame loop
	runs. With reduced motion it redraws at 10 Hz instead of every animation frame.
-->
<script lang="ts">
	import { prefersReducedMotion } from 'svelte/motion';
	import { m } from '#lib/paraglide/messages.js';
	import type { MeterMode } from '#lib/audio/meters.ts';
	import { READOUT_INTERVAL_MS, clamp, linearPosition } from './format.ts';

	interface Props {
		mode: MeterMode;
		analyser?: AnalyserNode | null;
		width?: number;
		height?: number;
		/** Display range in dB (AnalyserNode units). */
		minDb?: number;
		maxDb?: number;
		minHz?: number;
		maxHz?: number;
		label?: string;
		reducedMotion?: boolean;
		class?: string;
	}

	let {
		mode,
		analyser = null,
		width = 480,
		height = 160,
		minDb = -100,
		maxDb = -20,
		minHz = 20,
		maxHz = 20000,
		label = m.meter_spectrum_label(),
		reducedMotion,
		class: className = ''
	}: Props = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	const reduced = $derived(reducedMotion ?? prefersReducedMotion.current);
	const live = $derived(mode === 'live' && analyser !== null);

	function draw(
		context: CanvasRenderingContext2D,
		node: AnalyserNode,
		bins: Float32Array<ArrayBuffer>
	): void {
		node.getFloatFrequencyData(bins);
		const binHz = node.context.sampleRate / node.fftSize;
		const span = Math.log(maxHz / minHz);
		context.clearRect(0, 0, width, height);
		context.beginPath();
		let started = false;
		for (let i = 1; i < bins.length; i++) {
			const hz = i * binHz;
			if (hz < minHz || hz > maxHz) continue;
			const x = (Math.log(hz / minHz) / span) * width;
			const y = (1 - linearPosition(clamp(bins[i], minDb, maxDb), minDb, maxDb)) * height;
			if (started) context.lineTo(x, y);
			else context.moveTo(x, y);
			started = true;
		}
		context.stroke();
	}

	$effect(() => {
		const node = analyser;
		const target = canvas;
		if (!live || node === null || target === undefined) return;
		const context = target.getContext('2d');
		if (context === null) return;
		context.strokeStyle = getComputedStyle(target).color;
		context.lineWidth = 1.5;
		const bins = new Float32Array(node.frequencyBinCount);
		let frame: number | undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		if (reduced) {
			draw(context, node, bins);
			timer = setInterval(() => draw(context, node, bins), READOUT_INTERVAL_MS);
		} else {
			const loop = () => {
				draw(context, node, bins);
				frame = requestAnimationFrame(loop);
			};
			frame = requestAnimationFrame(loop);
		}
		return () => {
			if (frame !== undefined) cancelAnimationFrame(frame);
			if (timer !== undefined) clearInterval(timer);
			context.clearRect(0, 0, width, height);
		};
	});
</script>

<div role="img" aria-label={live ? label : m.meter_spectrum_idle()}>
	<canvas
		bind:this={canvas}
		class="oa-spectrum {className}"
		data-mode={mode}
		{width}
		{height}
		aria-hidden="true"
	></canvas>
</div>

<style>
	.oa-spectrum {
		display: block;
		width: 100%;
		height: auto;
		color: var(--oa-meter-spectrum, currentColor);
	}
</style>
