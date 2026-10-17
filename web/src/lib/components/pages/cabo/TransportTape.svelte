<!--
	U4 transport (FUX.P6, mock U4): two reels and a tape with the nine 31-byte reports R0 to R8,
	the 150 ms leader and the commit. The reels have no free-running loop: their angle is a
	function of how many reports went through (and of the commit), so they turn only while
	that number changes: during a rehearsal (labeled, nothing written), during a real write
	(live, when the service reports progress) and when the real result of a write is shown,
	which never lights a report the cable did not accept.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { m } from '#lib/paraglide/messages.js';
	import { hexBytes } from '#lib/charts/protocol.ts';
	import type { Curve } from '#lib/charts/response.ts';
	import type { WriteOutcome } from '#lib/cable/types.ts';
	import { formatNumber } from '#lib/components/cable/i18n.ts';
	import { Button } from '#lib/components/primitives/index.ts';
	import { reportsPassed, tapeTimeline, type TapeProgress } from './model.ts';

	interface Props {
		curve: Curve;
		outcome?: WriteOutcome | null;
		/** The service is writing right now (real state). */
		writing?: boolean;
		/** Live progress of that write, when the service reports it. */
		progress?: TapeProgress | null;
		/** Injectable clock and frame scheduler; defaults are the browser's (tests drive them). */
		now?: () => number;
		frame?: (callback: FrameRequestCallback) => number;
		cancel?: (handle: number) => void;
	}

	let {
		curve,
		outcome = null,
		writing = false,
		progress = null,
		now = () => performance.now(),
		frame: requestFrame = (callback) => requestAnimationFrame(callback),
		cancel: cancelFrame = (handle) => cancelAnimationFrame(handle)
	}: Props = $props();
	let snapshot = $state.raw<ReturnType<typeof tapeTimeline> | null>(null);
	const tape = $derived(snapshot ?? tapeTimeline(curve));
	let selected = $state(0);
	let slow = $state(false);
	let running = $state(false);
	let elapsed = $state(0);
	/** Live progress was seen during the current write: its result is shown, not replayed. */
	let liveSeen = false;
	let handle = 0;
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
	const LEFT = 214;
	const RIGHT = 944;
	const x = (ms: number) => LEFT + (Math.min(ms, axisEnd) / axisEnd) * (RIGHT - LEFT);
	const atMs = $derived(tape.reports.map((report) => report.atMs));
	const accepted = $derived(
		tape.reports.reduce((count, report) => (report.accepted === true ? count + 1 : count), 0)
	);

	/** Reports through the head right now: live progress, the nominal clock, or the real result. */
	const passed = $derived.by(() => {
		if (writing) return progress?.reportsSent ?? 0;
		const nominal = reportsPassed(atMs, elapsed);
		return tape.status === 'dry-run' ? nominal : Math.min(nominal, accepted);
	});
	const committed = $derived(
		writing ? progress?.committed === true : tape.committed && elapsed >= tape.durationMs
	);
	/** Reel turns follow the report index and the commit only (see the header comment). */
	const turns = $derived(passed + (committed ? 1 : 0));
	/**
	 * Reel angle: advances 40° per report (and for the commit) and never runs backwards, so a
	 * new rehearsal or write starting from report 0 does not rewind the reels.
	 */
	let angle = $state(0);
	let lastTurns = 0;
	$effect(() => {
		const next = turns;
		untrack(() => {
			if (next > lastTurns) angle += (next - lastTurns) * 40;
			lastTurns = next;
		});
	});
	const supplyPack = $derived(58 - passed * 2.4);
	const takePack = $derived(36 + passed * 2.4);
	const inspected = $derived(selected === 9 ? tape.commitBytes : tape.reports[selected].bytes);
	const ticks = $derived(
		Array.from({ length: Math.floor(axisEnd / 50) + 1 }, (_, index) => index * 50)
	);

	function stop() {
		cancelFrame(handle);
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
		const startedAt = now();
		const factor = slow ? 10 : 1;
		const duration = snapshot.durationMs;
		function advance(at: number) {
			elapsed = Math.min(duration, Math.max(0, at - startedAt) / factor);
			if (elapsed < duration) handle = requestFrame(advance);
			else running = false;
		}
		handle = requestFrame(advance);
	}

	// A real write stops any rehearsal and clears the previous result: the tape belongs to the
	// cable while it writes, and only this write's progress may light it.
	$effect(() => {
		if (!writing) return;
		untrack(() => {
			stop();
			liveSeen = false;
			snapshot = null;
			elapsed = 0;
		});
	});
	$effect(() => {
		if (writing && progress !== null) liveSeen = true;
	});

	// A completed service result is shown on the tape; this effect never performs I/O.
	$effect(() => {
		if (outcome !== null && outcome.status !== 'refused' && outcome.entry !== null) {
			const result = outcome;
			untrack(() => {
				if (liveSeen) {
					liveSeen = false;
					stop();
					snapshot = tapeTimeline(curve, result);
					elapsed = snapshot.durationMs;
				} else {
					play(result);
				}
			});
		}
	});
	$effect(() => () => cancelFrame(handle));
	$effect(() => {
		if (!prefersReducedMotion.current) return;
		untrack(() => {
			stop();
			if (snapshot) elapsed = snapshot.durationMs;
		});
	});

	const replayable = $derived(
		outcome !== null && outcome.status !== 'refused' && outcome.entry !== null
	);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (Named scroll regions must be focusable for keyboard scrolling.) -->
<div
	class="tape-window"
	role="region"
	aria-label={m.cabo_tape()}
	tabindex="0"
	data-running={running || writing}
>
	<svg viewBox="0 0 1160 236" role="img" aria-labelledby={`${id}-title ${id}-description`}>
		<title id={`${id}-title`}>{m.cabo_tape()}</title>
		<desc id={`${id}-description`}
			>{m.cabo_nominal()}
			{m.cabo_fux_tape_count({ sent: String(passed) })}
			{status}</desc
		>
		<defs>
			<radialGradient id={`${id}-flange`} cx="40%" cy="35%" r="75%">
				<stop offset="0" stop-color="#3a3d3f" />
				<stop offset="1" stop-color="#121314" />
			</radialGradient>
		</defs>
		<path
			class="path"
			d={`M110 ${100 + supplyPack} L ${LEFT - 14} 168 H ${RIGHT + 14} L 1050 ${100 + takePack}`}
		/>
		{#each [{ cx: 110, pack: supplyPack }, { cx: 1050, pack: takePack }] as reel (reel.cx)}
			<g class="reel" data-turns={turns} data-angle={angle} style:--turn={`${angle}deg`}>
				<circle cx={reel.cx} cy="100" r="80" fill={`url(#${id}-flange)`} class="flange" />
				<circle cx={reel.cx} cy="100" r={reel.pack} class="pack" />
				<g class="spokes">
					{#each [0, 120, 240] as spoke (spoke)}
						<rect
							x={reel.cx - 5}
							y="64"
							width="10"
							height="26"
							rx="3"
							transform={`rotate(${spoke} ${reel.cx} 100)`}
						/>
					{/each}
				</g>
				<circle cx={reel.cx} cy="100" r="13" class="hub" />
			</g>
		{/each}
		{#each tape.reports as report (report.index)}
			<g
				class="seg"
				class:accepted={report.accepted === true && report.index < passed}
				class:passed={report.accepted === null && report.index < passed}
				class:live={writing && report.index < passed}
				class:selected={selected === report.index}
			>
				<rect
					x={x(report.atMs)}
					y="150"
					width={Math.max(8, x(report.endMs) - x(report.atMs) - 3)}
					height="36"
					rx="2"
				/>
				<text class="lbl" x={x(report.atMs) + (x(report.endMs) - x(report.atMs) - 3) / 2} y="140"
					>R{report.index}</text
				>
			</g>
		{/each}
		<rect
			class="leader"
			x={x(tape.settleAtMs)}
			y="150"
			width={Math.max(8, x(tape.commitAtMs) - x(tape.settleAtMs) - 4)}
			height="36"
		/>
		<text class="leader-label" x={(x(tape.settleAtMs) + x(tape.commitAtMs)) / 2} y="173"
			>{m.cabo_settle()} · 150 ms</text
		>
		<g class="seg commit" class:accepted={committed} class:selected={selected === 9}>
			<rect x={x(tape.commitAtMs)} y="150" width="40" height="36" rx="2" />
			<text class="lbl" x={x(tape.commitAtMs) + 20} y="140">{m.cabo_commit()}</text>
		</g>
		{#each ticks as tick (tick)}
			<line class="tick" x1={x(tick)} x2={x(tick)} y1="196" y2="202" />
			<text class="axis" x={x(tick)} y="218">{tick} ms</text>
		{/each}
		<line class="playhead" x1={x(elapsed)} x2={x(elapsed)} y1="126" y2="194" />
	</svg>
	<p class="stamp" data-status={writing ? 'writing' : tape.status} role="status">
		{writing ? m.cabo_fux_tape_writing() : status}
	</p>
</div>
<div class="controls">
	<Button
		variant="key"
		caps
		disabledReason={writing ? m.cabo_fux_busy_writing() : null}
		onclick={() => play(null)}>{m.cabo_rehearse()}</Button
	>
	<Button
		variant="plate"
		disabledReason={writing
			? m.cabo_fux_busy_writing()
			: replayable
				? null
				: m.cabo_fux_replay_none()}
		onclick={() => play(outcome)}>{m.cabo_replay()}</Button
	>
	<label class="slow">
		<!-- Locked while the tape runs (its speed is fixed at the start), but still focusable and
		     saying why (T8): aria-disabled, and a click or Space never toggles it. -->
		<input
			type="checkbox"
			bind:checked={
				() => slow,
				(next) => {
					if (!running) slow = next;
				}
			}
			aria-disabled={running ? 'true' : undefined}
			aria-describedby={running ? `${id}-slow-why` : undefined}
			onclick={(event) => {
				if (running) event.preventDefault();
			}}
		/>
		{m.cabo_slow()}
	</label>
	{#if running}
		<small class="slow-why" id="{id}-slow-why">{m.fuxq1_tape_slow_running()}</small>
	{/if}
	<Button variant="ghost" disabledReason={running ? null : m.cabo_fux_stop_idle()} onclick={stop}
		>{m.cabo_stop()}</Button
	>
	<span class="readout"
		>{m.cabo_fux_tape_count({ sent: String(passed) })}{committed
			? ` · ${m.cabo_fux_tape_committed()}`
			: ''}</span
	>
</div>
<p class="timing">
	{tape.measuredMs === null
		? m.cabo_nominal_duration({ ms: formatNumber(tape.durationMs, 0) })
		: m.cabo_measured({ ms: formatNumber(tape.measuredMs, 1) })}
</p>
<p class="note">{m.cabo_nominal()} {m.cabo_fux_reels()}</p>
<div class="inspector">
	<label class="pick">
		<span>{m.cabo_fux_inspect()}</span>
		<select bind:value={selected}>
			{#each tape.reports as report (report.index)}
				<option value={report.index}>{m.cabo_report({ index: String(report.index) })}</option>
			{/each}
			<option value={9}>{m.cabo_commit()}</option>
		</select>
	</label>
	<p class="note">{m.cabo_fux_inspect_why()}</p>
	<p class="note verdict">
		{tape.status === 'dry-run'
			? m.cabo_nominal_report()
			: (selected === 9 ? tape.committed : tape.reports[selected].accepted)
				? m.cabo_accepted()
				: m.cabo_not_sent()}
	</p>
	<pre aria-label={m.cabo_selected_bytes()}>{hexBytes(inspected)}</pre>
</div>

<style>
	.tape-window {
		position: relative;
		overflow-x: auto;
		border-radius: 6px;
		background: linear-gradient(180deg, #0d0f10, #151718);
		box-shadow:
			inset 0 2px 8px #000,
			0 1px 0 #ffffff14;
	}
	/* Keyboard users scroll the tape on narrow screens; the ring shows where they are. */
	.tape-window:focus-visible {
		outline: 2px solid #8fe9df;
		outline-offset: 3px;
	}
	svg {
		display: block;
		width: 100%;
		min-width: 760px;
		height: auto;
	}
	.path {
		fill: none;
		stroke: #3a2b1f;
		stroke-width: 3;
	}
	.reel {
		transform-box: fill-box;
		transform-origin: center;
		transform: rotate(var(--turn, 0deg));
		transition: transform var(--dur-base, 0.2s) var(--ease-out, ease-out);
	}
	.flange {
		stroke: #000;
		stroke-width: 2;
	}
	.pack {
		fill: #3a2b1f;
		stroke: #241a12;
		stroke-width: 1;
	}
	.spokes rect {
		fill: #0d0f10;
	}
	.hub {
		fill: #c9ccc7;
		stroke: #000;
	}
	.seg rect {
		fill: #3a2b1f;
		stroke: #000;
		stroke-width: 1;
	}
	.seg.passed rect {
		fill: #8f7860;
		stroke: #e6e1d3;
	}
	.seg.accepted rect,
	.seg.live rect {
		fill: #4fd1c5;
		stroke: #b9f5ee;
		stroke-width: 2;
	}
	.seg.selected rect {
		stroke: #fff;
		stroke-width: 2.5;
	}
	.commit rect {
		fill: #0f3d3a;
	}
	.lbl {
		font: 600 13px var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.1em;
		fill: #cfd4cf;
		text-anchor: middle;
		text-transform: uppercase;
	}
	.leader {
		fill: #e6e1d3;
		stroke: #000;
	}
	.leader-label {
		font: 600 13px var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.14em;
		fill: #2b2e2f;
		text-anchor: middle;
		text-transform: uppercase;
	}
	.tick {
		stroke: #5c625e;
	}
	.axis {
		font: 400 12px var(--face-data, 'JetBrains Mono', monospace);
		fill: #a7aea9;
		text-anchor: middle;
	}
	.playhead {
		stroke: #8ffff3;
		stroke-width: 2;
	}
	.stamp {
		width: fit-content;
		margin: 0 auto 14px;
		padding: 6px 14px;
		border: 3px double #cfd4cf;
		border-radius: 4px;
		color: #ece7dd;
		font: 600 var(--fs-ui, 14px) / 1.2 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.12em;
		text-align: center;
	}
	.stamp[data-status='interrupted'] {
		color: #ffb3b5;
		border-color: #ffb3b5;
	}
	.stamp[data-status='ok'],
	.stamp[data-status='writing'] {
		color: #8fe9df;
		border-color: #8fe9df;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 12px 18px;
		align-items: center;
		margin: 14px 0;
	}
	.slow {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: var(--hit, 36px);
		font-size: var(--fs-small, 13px);
	}
	.slow input {
		accent-color: #4fd1c5;
	}
	.slow input[aria-disabled='true'] {
		cursor: not-allowed;
		opacity: 0.6;
	}
	.slow-why {
		font-size: var(--fs-caption, 12px);
		color: #b6bdb7;
	}
	.readout {
		margin-left: auto;
		font: 400 var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
		color: #a6f6ed;
	}
	.timing {
		font: 400 var(--fs-caption, 12px) var(--face-data, 'JetBrains Mono', monospace);
		color: #a6f6ed;
	}
	.note {
		font-size: var(--fs-caption, 12px);
		color: #b6bdb7;
		line-height: 1.55;
	}
	.inspector {
		display: grid;
		gap: 6px;
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid #ffffff14;
	}
	.inspector .note {
		margin: 0;
	}
	.verdict {
		color: #d7dbd6;
	}
	.pick {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		font: 600 var(--fs-small, 13px) var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.pick select {
		min-height: var(--hit, 36px);
		padding: 6px 10px;
		border: 1px solid #6f7973;
		border-radius: 3px;
		background: #0d0f0f;
		color: #e8ece8;
		font: 400 var(--fs-small, 13px) var(--face-body, 'Geist', sans-serif);
		letter-spacing: 0;
		text-transform: none;
	}
	pre {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		padding: 10px;
		border-radius: 3px;
		background: #080b0b;
		color: #a6f6ed;
		font: 400 var(--fs-caption, 12px) / 1.7 var(--face-data, 'JetBrains Mono', monospace);
	}
	@media (prefers-reduced-motion: reduce) {
		.reel {
			transition: none;
		}
		.playhead {
			display: none;
		}
	}
</style>
