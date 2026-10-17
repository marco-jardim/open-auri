<!--
	Tape transport (spec §1.4b Comparar, §3 Les Paul). Every moving or lit part follows real state:
	the reels turn and the amber lamp over the heads lights only while this page's own preview is
	playing (`playing`), and both stop under prefers-reduced-motion. No meter lives here.
-->
<script lang="ts">
	interface Props {
		label: string;
		/** This page's own audition is running (never another page's engine mode). */
		playing?: boolean;
		plate: string;
		/** Legends, in tape order: extra head, erase, record, playback. */
		heads: readonly [string, string, string, string];
		/** Spoken state of the lamp and reels. */
		status: string;
	}
	let { label, playing = false, plate, heads, status }: Props = $props();
	const uid = $props.id();
	const HEAD_X = [462, 552, 642, 732] as const;
	const PLAY_HEAD = 3;
</script>

<svg
	viewBox="0 0 1200 260"
	role="img"
	aria-labelledby="{uid}-title {uid}-desc"
	class="deck-svg"
	class:playing
	data-playing={playing}
>
	<title id="{uid}-title">{label}</title>
	<desc id="{uid}-desc">{status}</desc>
	<defs>
		<radialGradient id="{uid}-flange"
			><stop stop-color="#eceee8" /><stop offset=".72" stop-color="#a7aaa6" /><stop
				offset="1"
				stop-color="#4f5551"
			/></radialGradient
		>
		<radialGradient id="{uid}-hub" cx="35%" cy="30%"
			><stop stop-color="#fafbf7" /><stop offset=".45" stop-color="#aaaead" /><stop
				offset="1"
				stop-color="#303633"
			/></radialGradient
		>
		<radialGradient id="{uid}-pack"
			><stop offset=".3" stop-color="#2a1c11" /><stop offset=".85" stop-color="#4a3220" /><stop
				offset="1"
				stop-color="#6d4b2b"
			/></radialGradient
		>
		<linearGradient id="{uid}-head"
			><stop stop-color="#676e68" /><stop offset=".35" stop-color="#e3e7e0" /><stop
				offset="1"
				stop-color="#4c534d"
			/></linearGradient
		>
		<radialGradient id="{uid}-lamp-on" cx="38%" cy="32%"
			><stop stop-color="#fff2c8" /><stop offset=".45" stop-color="#f2b33d" /><stop
				offset="1"
				stop-color="#8a5a10"
			/></radialGradient
		>
		<radialGradient id="{uid}-lamp-off" cx="38%" cy="32%"
			><stop stop-color="#6a6560" /><stop offset="1" stop-color="#2a2724" /></radialGradient
		>
	</defs>
	<rect x="6" y="6" width="1188" height="248" rx="12" fill="#1a1d1b" stroke="#454b46" />
	<!-- Tape path: supply reel, guide roller, heads, guide roller, take-up reel. -->
	<path
		d="M175 248 L392 214 H808 L1025 248"
		fill="none"
		stroke="#100d09"
		stroke-width="8"
		stroke-linejoin="round"
	/>
	<path
		d="M175 248 L392 214 H808 L1025 248"
		fill="none"
		stroke="#775131"
		stroke-width="3"
		stroke-linejoin="round"
	/>
	{#each [392, 808] as x (x)}
		<circle cx={x} cy="214" r="11" fill="#2a2e2b" stroke="#8c938a" stroke-width="2" />
		<circle cx={x} cy="214" r="3" fill="#cfd4cb" />
	{/each}
	{#each [{ cx: 175, pack: 100, side: 'left' }, { cx: 1025, pack: 66, side: 'right' }] as reel (reel.side)}
		<g transform="translate({reel.cx} 130)">
			<circle r="120" fill="#0b0b09" stroke="#565b54" stroke-width="3" />
			<circle r={reel.pack} fill="url(#{uid}-pack)" stroke="#6d4b2b" stroke-width="3" />
			{#each [44, 58, 72, 86] as r (r)}
				{#if r < reel.pack}<circle {r} fill="none" stroke="#93653a" opacity=".28" />{/if}
			{/each}
			<g class="reel {reel.side}">
				<circle
					r="116"
					fill="url(#{uid}-flange)"
					fill-opacity=".62"
					stroke="#c4c9c0"
					stroke-width="2"
				/>
				{#each [0, 120, 240] as angle (angle)}
					<path
						transform="rotate({angle})"
						d="M-18 -36 L-48 -92 Q-6 -118 38 -95 L17 -37 Z"
						fill="#161b16"
						stroke="#727a70"
					/>
				{/each}
				<circle r="28" fill="url(#{uid}-hub)" stroke="#272f29" stroke-width="3" />
				<circle r="9" fill="#121713" />
				<path d="M-6 0 H6 M0 -6 V6" stroke="#a6aea3" stroke-width="2" />
			</g>
		</g>
	{/each}
	<text class="plate" x="600" y="40" text-anchor="middle">{plate}</text>
	<!-- Amber pilot lamp over the heads: lit only while the preview really plays. -->
	<g class="lamp" transform="translate(600 70)">
		<circle r="15" fill="#1a1918" stroke="#4b4d4c" stroke-width="2" />
		<circle r="10" fill="url(#{uid}-lamp-{playing ? 'on' : 'off'})" />
		{#if playing}<circle r="20" fill="#f2b33d" opacity=".18" />{/if}
	</g>
	<rect x="420" y="96" width="360" height="110" rx="10" fill="#121512" stroke="#666d62" />
	{#each HEAD_X as x, index (x)}
		<text class="legend" class:lit={playing && index === PLAY_HEAD} x={x + 20} y="116"
			>{heads[index]}</text
		>
		<path
			d="M{x} 126 h40 v46 q0 15 -20 15 q-20 0 -20 -15z"
			fill="url(#{uid}-head)"
			stroke={playing && index === PLAY_HEAD ? '#f2b33d' : '#090d08'}
			stroke-width="2"
		/>
		<line x1={x + 20} x2={x + 20} y1="190" y2="204" stroke="#151b14" />
	{/each}
	<!-- Clear cover over the head block. -->
	<rect x="432" y="104" width="336" height="96" rx="9" fill="#ffffff08" stroke="#cbd2c04d" />
	<path d="M444 110 H580" stroke="#ffffff44" stroke-linecap="round" />
</svg>

<style>
	svg {
		display: block;
		width: 100%;
		height: auto;
	}
	.plate {
		fill: #e9e4d6;
		font-family: var(--plate);
		font-size: 15px;
		letter-spacing: 0.24em;
	}
	.legend {
		fill: #cfc6b2;
		font-family: var(--plate);
		font-size: 12px;
		letter-spacing: 0.12em;
		text-anchor: middle;
	}
	.legend.lit {
		fill: #f2b33d;
	}
	.playing .reel {
		animation: spin 14s linear infinite;
	}
	.playing .reel.right {
		animation-duration: 9.3s;
	}
	@keyframes spin {
		to {
			transform: rotate(-360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.playing .reel {
			animation: none;
		}
	}
</style>
