<script lang="ts">
	let { label, playing = false }: { label: string; playing?: boolean } = $props();
</script>

<svg viewBox="0 0 1200 250" role="img" aria-label={label} class:playing>
	<title>{label}</title>
	<defs>
		<radialGradient id="comparar-flange"
			><stop stop-color="#e8e9e4" /><stop offset=".75" stop-color="#a7aaa6" /><stop
				offset="1"
				stop-color="#555b57"
			/></radialGradient
		>
		<radialGradient id="comparar-hub" cx="35%" cy="30%"
			><stop stop-color="#fafbf7" /><stop offset=".45" stop-color="#aaaead" /><stop
				offset="1"
				stop-color="#303633"
			/></radialGradient
		>
		<linearGradient id="comparar-head"
			><stop stop-color="#676e68" /><stop offset=".35" stop-color="#e3e7e0" /><stop
				offset="1"
				stop-color="#4c534d"
			/></linearGradient
		>
	</defs>
	<rect x="8" y="8" width="1184" height="234" rx="10" fill="#1a1d1b" stroke="#454b46" />
	<path d="M280 175 L440 209 H761 L920 175" fill="none" stroke="#100d09" stroke-width="8" />
	<path d="M280 175 L440 209 H761 L920 175" fill="none" stroke="#775131" stroke-width="3" />
	{#each [270, 930] as cx, index (cx)}
		<g transform="translate({cx} 120)">
			<circle r="105" fill="#0b0b09" stroke="#565b54" stroke-width="3" />
			<circle r={index === 0 ? 89 : 70} fill="#3c281a" stroke="#6d4b2b" stroke-width="4" />
			{#each [40, 52, 64, 76, 88] as r (r)}<circle
					{r}
					fill="none"
					stroke="#93653a"
					opacity=".3"
				/>{/each}
			<g class="reel">
				<circle
					r="102"
					fill="url(#comparar-flange)"
					fill-opacity=".68"
					stroke="#c4c9c0"
					stroke-width="2"
				/>
				{#each [0, 120, 240] as angle (angle)}
					<path
						transform="rotate({angle})"
						d="M-16 -32 L-42 -80 Q-5 -104 34 -83 L15 -33 Z"
						fill="#161b16"
						stroke="#727a70"
					/>
				{/each}
				<circle r="25" fill="url(#comparar-hub)" stroke="#272f29" stroke-width="3" />
				<circle r="8" fill="#121713" /><path
					d="M-5 0 H5 M0 -5 V5"
					stroke="#a6aea3"
					stroke-width="2"
				/>
			</g>
		</g>
	{/each}
	<rect x="432" y="111" width="338" height="113" rx="10" fill="#121512" stroke="#666d62" />
	{#each [470, 550, 630, 710] as x, i (x)}
		<path
			d="M{x} 147 h36 v44 q0 14 -18 14 q-18 0 -18 -14z"
			fill="url(#comparar-head)"
			stroke={i === 0 ? '#f2b33d' : '#090d08'}
			stroke-width="2"
		/>
		<line x1={x + 18} x2={x + 18} y1="194" y2="206" stroke="#151b14" />
	{/each}
	<path d="M488 143 C488 95 647 95 647 143" fill="none" stroke="#f2b33d" stroke-dasharray="5 5" />
	<text x="570" y="99" fill="#f2b33d" text-anchor="middle" font-family="monospace" font-size="16"
		>+ k × Δ</text
	>
	<rect x="450" y="130" width="303" height="83" rx="10" fill="#ffffff09" stroke="#cbd2c04d" />
	<path d="M460 137 H590" stroke="#ffffff55" stroke-linecap="round" />
	<text
		x="600"
		y="48"
		fill="#c2c9b8"
		text-anchor="middle"
		font-family="monospace"
		font-size="12"
		letter-spacing="3">SOUND ON SOUND · 8 TRACKS</text
	>
</svg>

<style>
	svg {
		display: block;
		width: 100%;
		height: auto;
	}
	.playing .reel {
		animation: spin 14s linear infinite;
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
