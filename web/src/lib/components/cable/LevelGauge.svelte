<!--
	Cream VU face for the checklist (FUX.P6, mock U3). DATA, never audio: the needle sits where
	the curve's predicted level (300 Hz to 3 kHz, preamp included) puts it. It is a static
	reading of a computed number, so it has no ballistics and no motion token (spec §3.6);
	with no level the needle is parked and the face says why.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { formatNumber } from './i18n.ts';

	interface Props {
		/** Predicted level in dB, or null when the curve cannot be evaluated. */
		levelDb: number | null;
		/** Visual size: the dialog uses the compact face. */
		compact?: boolean;
	}

	let { levelDb, compact = false }: Props = $props();
	const id = $props.id();

	const MIN_DB = -20;
	const MAX_DB = 3;
	const SWEEP = 96;
	const PIVOT = { x: 200, y: 262 };
	const amplitude = (db: number) => 10 ** (db / 20);
	/** VU-style (amplitude) placement of a dB value on the arc, 0..1. */
	function fraction(db: number): number {
		const clamped = Math.min(MAX_DB, Math.max(MIN_DB, db));
		return (amplitude(clamped) - amplitude(MIN_DB)) / (amplitude(MAX_DB) - amplitude(MIN_DB));
	}
	const angle = (db: number) => -SWEEP / 2 + fraction(db) * SWEEP;
	function polar(degrees: number, radius: number) {
		const radians = ((degrees - 90) * Math.PI) / 180;
		return { x: PIVOT.x + radius * Math.cos(radians), y: PIVOT.y + radius * Math.sin(radians) };
	}
	const TICKS = [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3];
	const ticks = TICKS.map((db) => {
		const a = angle(db);
		return {
			db,
			inner: polar(a, db % 5 === 0 || db >= -3 ? 176 : 184),
			outer: polar(a, 196),
			label: polar(a, 214),
			red: db > 0
		};
	});
	const redArc = (() => {
		const from = polar(angle(0), 192);
		const to = polar(angle(MAX_DB), 192);
		return `M ${from.x} ${from.y} A 192 192 0 0 1 ${to.x} ${to.y}`;
	})();
	const arc = (() => {
		const from = polar(angle(MIN_DB), 192);
		const to = polar(angle(MAX_DB), 192);
		return `M ${from.x} ${from.y} A 192 192 0 0 1 ${to.x} ${to.y}`;
	})();
	const needle = $derived(levelDb === null ? -SWEEP / 2 - 6 : angle(levelDb));
	const tip = $derived(polar(needle, 200));
	const spoken = $derived(
		levelDb === null
			? m.cable_fux_vu_none()
			: m.cable_fux_vu_aria({ level: formatNumber(levelDb, 1, true) })
	);
</script>

<figure class="gauge" class:compact>
	<div class="bezel">
		<span class="screw s1" aria-hidden="true"></span><span class="screw s2" aria-hidden="true"
		></span><span class="screw s3" aria-hidden="true"></span><span
			class="screw s4"
			aria-hidden="true"
		></span>
		<svg viewBox="0 0 400 230" role="img" aria-labelledby={`${id}-name`}>
			<title id={`${id}-name`}>{spoken}</title>
			<defs>
				<linearGradient id={`${id}-face`} x1="0" y1="0" x2="0.3" y2="1">
					<stop offset="0" stop-color="#f8eccb" />
					<stop offset="1" stop-color="#dccb9f" />
				</linearGradient>
			</defs>
			<rect width="400" height="230" fill={`url(#${id}-face)`} />
			<path d={arc} fill="none" stroke="#2a2822" stroke-width="1.6" />
			<path d={redArc} fill="none" stroke="#a3262c" stroke-width="6" />
			{#each ticks as tick (tick.db)}
				<line
					x1={tick.inner.x}
					y1={tick.inner.y}
					x2={tick.outer.x}
					y2={tick.outer.y}
					stroke={tick.red ? '#a3262c' : '#2a2822'}
					stroke-width="2"
				/>
				<text
					x={tick.label.x}
					y={tick.label.y}
					class:red={tick.red}
					text-anchor="middle"
					dominant-baseline="middle">{tick.db > 0 ? `+${tick.db}` : String(tick.db)}</text
				>
			{/each}
			<text class="vu" x="200" y="150" text-anchor="middle">VU</text>
			<text class="engrave" x="200" y="214" text-anchor="middle">{m.cable_fux_vu_face()}</text>
			<line
				class="needle"
				class:parked={levelDb === null}
				x1={PIVOT.x}
				y1={PIVOT.y}
				x2={tip.x}
				y2={tip.y}
			/>
		</svg>
	</div>
	<figcaption>
		<span class="mode">{m.cable_fux_vu_data()}</span>
		<span class="reading"
			>{levelDb === null
				? m.cable_fux_level_unknown()
				: `${formatNumber(levelDb, 1, true)} dB`}</span
		>
	</figcaption>
</figure>

<style>
	.gauge {
		margin: 0;
		min-width: 0;
	}
	.bezel {
		position: relative;
		padding: 13px;
		border-radius: 12px;
		background: linear-gradient(160deg, #2d3032, #0f1011);
		box-shadow:
			inset 0 1px 0 #ffffff26,
			0 9px 16px #000b,
			0 0 0 1px #000;
	}
	.compact .bezel {
		padding: 9px;
	}
	svg {
		display: block;
		width: 100%;
		height: auto;
		border-radius: 5px;
	}
	text {
		font: 500 15px var(--face-data, 'JetBrains Mono', monospace);
		fill: #2a2822;
	}
	text.red {
		fill: #a3262c;
	}
	.vu {
		font: 400 44px var(--face-display, 'Instrument Serif', Georgia, serif);
	}
	.engrave {
		font: 600 11px var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.16em;
		fill: #4a4436;
	}
	.needle {
		stroke: #1b1a17;
		stroke-width: 2.5;
		stroke-linecap: round;
	}
	.needle.parked {
		stroke: #6d6656;
		stroke-dasharray: 4 4;
	}
	.screw {
		position: absolute;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #e9ebe8, #5a5e5b);
	}
	.s1 {
		left: 3px;
		top: 3px;
	}
	.s2 {
		right: 3px;
		top: 3px;
	}
	.s3 {
		left: 3px;
		bottom: 3px;
	}
	.s4 {
		right: 3px;
		bottom: 3px;
	}
	figcaption {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 4px 12px;
		margin-top: 8px;
		font: 400 var(--fs-caption, 12px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.reading {
		font-weight: 500;
	}
</style>
