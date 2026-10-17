<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { dbScale, logScale, linePath, numberLabel } from '#lib/charts/scales.ts';
	import { GRID } from 'open-auri/dsp';
	import { targetFromPoints } from 'open-auri/solver';
	import { Button } from '#lib/components/primitives/index.ts';
	import { INITIAL_POINTS, type TargetPoint } from './model.ts';
	let svg = $state<SVGSVGElement>();
	let {
		points,
		onchange
	}: {
		points: readonly TargetPoint[];
		onchange: (points: TargetPoint[]) => void;
	} = $props();
	const x = logScale(20, 20000, 30, 470);
	const y = dbScale(-18, 18, 210, 15);
	let width = $state(500);
	const labelSize = $derived((500 / Math.max(1, width - 10)) * 11);
	const path = $derived(
		linePath(targetFromPoints(points, GRID).map((value, i) => ({ x: x(GRID[i]), y: y(value) })))
	);
	let dragging: number | null = null;
	function pointValue(point: TargetPoint) {
		const hz = numberLabel(point.freqHz, getLocale());
		const db = numberLabel(point.gainDb, getLocale(), 1);
		return `${hz} Hz / ${db} dB`;
	}
	function change(index: number, freqHz: number, gainDb: number) {
		const low = index === 0 ? 20 : points[index - 1].freqHz * 1.01;
		const high = index === points.length - 1 ? 20000 : points[index + 1].freqHz / 1.01;
		onchange(
			points.map((point, i) =>
				i === index
					? {
							freqHz: Math.max(low, Math.min(high, freqHz)),
							gainDb: Math.max(-18, Math.min(18, Math.round(gainDb * 10) / 10))
						}
					: { ...point }
			)
		);
	}
	function move(event: PointerEvent, index: number) {
		if (dragging !== index) return;
		const circle = event.currentTarget as SVGCircleElement;
		const box = circle.ownerSVGElement?.getBoundingClientRect();
		if (!box) return;
		const px = ((event.clientX - box.left) / box.width) * 500;
		const py = ((event.clientY - box.top) / box.height) * 245;
		change(index, 20 * 1000 ** ((px - 30) / 440), 18 - ((py - 15) / 195) * 36);
	}
	function key(event: KeyboardEvent, index: number) {
		if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			return;
		}
		event.preventDefault();
		const point = points[index];
		const step = event.shiftKey ? 2 : 0.5;
		const freq =
			event.key === 'ArrowLeft'
				? point.freqHz / 2 ** (step / 12)
				: event.key === 'ArrowRight'
					? point.freqHz * 2 ** (step / 12)
					: point.freqHz;
		const gain =
			event.key === 'ArrowUp'
				? point.gainDb + step
				: event.key === 'ArrowDown'
					? point.gainDb - step
					: event.key === 'Home'
						? -18
						: event.key === 'End'
							? 18
							: point.gainDb;
		change(index, freq, gain);
	}
</script>

<div class="tools">
	<Button
		size="sm"
		variant="plate"
		onclick={() => svg?.querySelector<SVGCircleElement>('circle')?.focus()}
		><span aria-hidden="true">↗</span> {m.soe_fux_draw_start()}</Button
	>
	<Button
		size="sm"
		variant="plate"
		onclick={() => onchange(INITIAL_POINTS.map((point) => ({ ...point })))}
	>
		{m.soe_reset()}
	</Button>
</div>
<div bind:clientWidth={width} style={`--target-label-size:${labelSize}px`}>
	<svg bind:this={svg} viewBox="0 0 500 245" role="group" aria-label={m.soe_fux_draw()}>
		<title>{m.soe_fux_draw()}</title>
		{#each [20, 100, 1000, 10000, 20000] as hz (hz)}
			<line x1={x(hz)} x2={x(hz)} y1="15" y2="210" />
		{/each}
		{#each [-18, 0, 18] as db (db)}
			<line x1="30" x2="470" y1={y(db)} y2={y(db)} />
		{/each}
		<path d={path} fill="none" stroke="#ece7dd" stroke-width="2" />
		{#each points as point, i (i)}
			<circle
				cx={x(point.freqHz)}
				cy={y(point.gainDb)}
				r="9"
				role="slider"
				tabindex="0"
				vector-effect="non-scaling-stroke"
				aria-label={`${m.soe_point()} ${i + 1}`}
				aria-valuemin="-18"
				aria-valuemax="18"
				aria-valuenow={point.gainDb}
				aria-valuetext={pointValue(point)}
				onkeydown={(event) => key(event, i)}
				onpointerdown={(event) => {
					dragging = i;
					event.currentTarget.setPointerCapture(event.pointerId);
					event.currentTarget.focus();
				}}
				onpointermove={(event) => move(event, i)}
				onpointerup={() => (dragging = null)}
				onpointercancel={() => (dragging = null)}
			/>
		{/each}
		<text x="30" y="238">20 Hz</text>
		<text x="470" y="238" text-anchor="end">20 kHz</text>
	</svg>
</div>
<p>{m.soe_draw_hint()}</p>

<style>
	.tools {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2, 8px);
		margin-top: var(--space-3, 12px);
	}
	svg {
		box-sizing: border-box;
		width: 100%;
		display: block;
		margin-top: 12px;
		background: #101a16;
		border: 5px solid #20261c;
		border-radius: 8px;
		overflow: visible;
	}
	line {
		stroke: #405448;
	}
	circle {
		fill: #ff99c4;
		stroke: transparent;
		stroke-width: 24px;
		cursor: grab;
		touch-action: none;
	}
	circle:focus-visible {
		outline: 3px solid #ece7dd;
		outline-offset: 3px;
	}
	text {
		fill: #d4dec8;
		font: var(--target-label-size) var(--font-mono, monospace);
	}
	p {
		color: #d4dec8;
		font-size: 11px;
		line-height: 1.6;
	}
</style>
