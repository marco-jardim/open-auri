<!--
	S8 curve avatar: the response drawn around a circle (0 dB on the dashed ring), colored by a hue
	derived from the S1 bytes. Same S1, same picture. Data only, never animated.
-->
<script lang="ts">
	import { avatarHue, avatarPath, type DecodedCurve } from './model.ts';

	let {
		curve,
		s1,
		label,
		size = 56
	}: { curve: DecodedCurve | null; s1: string; label: string; size?: number } = $props();

	const hue = $derived(avatarHue(s1));
	const path = $derived(curve ? avatarPath(curve) : null);
</script>

<svg
	class="avatar"
	viewBox="-30 -30 60 60"
	width={size}
	height={size}
	role="img"
	aria-label={label}
	data-testid="curve-avatar"
>
	<circle r="28.5" class="bg" />
	<circle r="17" class="zero" />
	{#if path}
		<path
			d={path}
			fill="hsl({hue} 70% 60% / 0.22)"
			stroke="hsl({hue} 80% 72%)"
			stroke-width="1.3"
			stroke-linejoin="round"
		/>
	{/if}
	<line x1="0" y1="-29" x2="0" y2="-24" class="tick" />
</svg>

<style>
	.avatar {
		display: block;
		filter: drop-shadow(1px 2px 2px #000a);
	}
	.bg {
		fill: var(--avatar-bg, #111214);
		stroke: #000;
		stroke-width: 1;
	}
	.zero {
		fill: none;
		stroke: #ffffff22;
		stroke-dasharray: 1.5 2;
	}
	.tick {
		stroke: #ffffff55;
	}
</style>
