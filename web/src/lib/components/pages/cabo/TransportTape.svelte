<script lang="ts">
	import { untrack } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { m } from '#lib/paraglide/messages.js';
	import { hexBytes } from '#lib/charts/protocol.ts';
	import type { Curve } from '#lib/charts/response.ts';
	import type { WriteOutcome } from '#lib/cable/types.ts';
	import { formatNumber } from '#lib/components/cable/i18n.ts';
	import { tapeTimeline } from './model.ts';

	let { curve, outcome = null }: { curve: Curve; outcome?: WriteOutcome | null } = $props();
	let snapshot = $state.raw<ReturnType<typeof tapeTimeline> | null>(null);
	const tape = $derived(snapshot ?? tapeTimeline(curve));
	let selected = $state(0);
	let slow = $state(false);
	let running = $state(false);
	let elapsed = $state(0);
	let frame = 0;
	const id = $props.id();
	const status = $derived(
		tape.status === 'dry-run'
			? m.cabo_dry_run()
			: tape.status === 'ok'
				? m.cabo_status_ok()
				: tape.status === 'simulated'
					? m.cabo_status_simulated()
					: m.cabo_status_interrupted()
	);
	const axisEnd = $derived(Math.max(tape.commitAtMs + 16, tape.durationMs));
	const x = (ms: number) => 45 + (ms / axisEnd) * 1010;
	const inspected = $derived(selected === 9 ? tape.commitBytes : tape.reports[selected].bytes);

	function stop() {
		cancelAnimationFrame(frame);
		running = false;
	}

	function play(result: WriteOutcome | null) {
		stop();
		snapshot = tapeTimeline(curve, result);
		elapsed = 0;
		if (prefersReducedMotion.current) {
			elapsed = snapshot.durationMs;
			return;
		}
		running = true;
		const startedAt = performance.now();
		const factor = slow ? 10 : 1;
		const duration = snapshot.durationMs;
		function advance(now: number) {
			elapsed = Math.min(duration, (now - startedAt) / factor);
			if (elapsed < duration) frame = requestAnimationFrame(advance);
			else running = false;
		}
		frame = requestAnimationFrame(advance);
	}

	// A completed service result can replay, but this effect never performs I/O.
	$effect(() => {
		if (outcome !== null && outcome.status !== 'refused' && outcome.entry !== null) {
			const result = outcome;
			untrack(() => play(result));
		}
	});
	$effect(() => () => cancelAnimationFrame(frame));
	$effect(() => {
		if (!prefersReducedMotion.current) return;
		untrack(() => {
			stop();
			if (snapshot) elapsed = snapshot.durationMs;
		});
	});
</script>

<div class="tape-window" role="region" aria-label={m.cabo_tape()}>
	<svg viewBox="0 0 1100 195" role="img" aria-labelledby={`${id}-title ${id}-description`}>
		<title id={`${id}-title`}>{m.cabo_tape()}</title>
		<desc id={`${id}-description`}>{m.cabo_nominal()} {status}</desc>
		<path d="M24 65 H1076 V135 H24 Z" fill="#6d5741" stroke="#0a0a09" stroke-width="5" />
		{#each Array.from({ length: 70 }, (_, i) => i) as hole (hole)}
			<rect class="perforation" x={30 + hole * 15} y="69" width="6" height="7" rx="1" />
			<rect class="perforation" x={30 + hole * 15} y="124" width="6" height="7" rx="1" />
		{/each}
		{#each tape.reports as report (report.index)}
			<g class:accepted={report.accepted === true && elapsed >= report.atMs}>
				<rect
					x={x(report.atMs)}
					y="79"
					width={x(report.endMs) - x(report.atMs) - 3}
					height="42"
					rx="2"
				/>
				<text x={x(report.atMs) + 17} y="105">{report.index}</text>
				<text class="axis" x={x(report.atMs)} y="157">{report.atMs}</text>
			</g>
		{/each}
		<rect
			class="leader"
			x={x(tape.settleAtMs)}
			y="79"
			width={x(tape.commitAtMs) - x(tape.settleAtMs) - 4}
			height="42"
		/>
		<text class="leader-label" x={x(tape.settleAtMs) + 14} y="105">{m.cabo_settle()} · 150 ms</text>
		<g class:accepted={tape.committed && elapsed >= tape.durationMs}>
			<rect x={x(tape.commitAtMs)} y="79" width="38" height="42" rx="2" />
			<text x={x(tape.commitAtMs) + 19} y="105">C</text>
		</g>
		<text class="axis" x={x(tape.commitAtMs)} y="157">{tape.commitAtMs} ms</text>
		<line class="playhead" x1={x(elapsed)} x2={x(elapsed)} y1="35" y2="140" />
	</svg>
	<div class="reports" role="group" aria-label={m.cabo_tape()}>
		{#each tape.reports as report (report.index)}
			<button
				type="button"
				aria-pressed={selected === report.index}
				onclick={() => (selected = report.index)}
			>
				{m.cabo_report({ index: String(report.index) })}
			</button>
		{/each}
		<button type="button" aria-pressed={selected === 9} onclick={() => (selected = 9)}
			>{m.cabo_commit()}</button
		>
	</div>
	<p class="stamp" data-status={tape.status} role="status">{status}</p>
</div>
<div class="controls">
	<button type="button" onclick={() => play(null)}>{m.cabo_rehearse()}</button>
	<button
		type="button"
		disabled={outcome === null || outcome.status === 'refused' || outcome.entry === null}
		onclick={() => play(outcome)}>{m.cabo_replay()}</button
	>
	<label><input type="checkbox" bind:checked={slow} disabled={running} /> {m.cabo_slow()}</label>
	<button type="button" disabled={!running} onclick={stop}>{m.cabo_stop()}</button>
</div>
<p class="timing">
	{tape.measuredMs === null
		? m.cabo_nominal_duration({ ms: formatNumber(tape.durationMs, 0) })
		: m.cabo_measured({ ms: formatNumber(tape.measuredMs, 1) })}
</p>
<p class="note">{m.cabo_nominal()}</p>
<p class="note">
	{tape.status === 'dry-run'
		? m.cabo_nominal_report()
		: (selected === 9 ? tape.committed : tape.reports[selected].accepted)
			? m.cabo_accepted()
			: m.cabo_not_sent()}
</p>
<pre aria-label={m.cabo_selected_bytes()}>{hexBytes(inspected)}</pre>

<style>
	.tape-window {
		content-visibility: auto;
		contain-intrinsic-size: auto 260px;
		overflow-x: auto;
		background: #0d0f10;
		border-radius: 6px;
		box-shadow: inset 0 2px 8px #000;
	}
	svg {
		display: block;
		width: 100%;
		min-width: 780px;
	}
	svg rect {
		fill: #30291f;
		stroke: #080909;
	}
	svg .perforation {
		fill: #121415;
		stroke: none;
	}
	svg text {
		fill: #ece7dd;
		text-anchor: middle;
		font: 12px var(--mono, monospace);
	}
	svg .axis {
		fill: #b6bdb7;
		font-size: 10px;
		text-anchor: start;
	}
	svg .leader {
		fill: #e6e1d3;
	}
	svg .leader-label {
		fill: #2b2e2f;
		text-anchor: start;
	}
	.accepted rect {
		fill: #4fd1c5;
	}
	.accepted text {
		fill: #062321;
	}
	.accepted .axis {
		fill: #b6bdb7;
	}
	.playhead {
		stroke: #8ffff3;
		stroke-width: 2;
	}
	.stamp {
		width: fit-content;
		margin: 0 auto 16px;
		padding: 7px 12px;
		border: 3px double #cfd4cf;
		color: #ece7dd;
		font:
			600 16px/1.2 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.1em;
		text-align: center;
	}
	.stamp[data-status='interrupted'] {
		color: #ffb3b5;
		border-color: #ffb3b5;
	}
	.stamp[data-status='ok'] {
		color: #8fe9df;
		border-color: #8fe9df;
	}
	.controls,
	.reports {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin: 14px 0;
	}
	button {
		min-height: 36px;
		padding: 6px 10px;
		border: 1px solid #8c9690;
		border-radius: 3px;
		color: #ece7dd;
		background: linear-gradient(#3b3e40, #1c1e1f);
		font:
			600 12px 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.08em;
	}
	button[aria-pressed='true'] {
		border-color: #8fe9df;
		color: #8fe9df;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
	}
	input {
		accent-color: #4fd1c5;
	}
	.timing {
		font: 12px var(--mono, monospace);
		color: #a6f6ed;
	}
	.note {
		font-size: 12px;
		color: #b6bdb7;
		line-height: 1.55;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		padding: 10px;
		background: #080b0b;
		color: #a6f6ed;
		font: 12px/1.7 var(--mono, monospace);
	}
	:focus-visible {
		outline: 2px solid #8fe9df;
		outline-offset: 3px;
	}
	@media (prefers-reduced-motion: reduce) {
		.playhead {
			display: none;
		}
	}
</style>
