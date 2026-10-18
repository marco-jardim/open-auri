<!--
	Modo YOLO hazard glyph: a warning triangle drawn in SVG, so it looks the same on every
	platform (the ⚠ character turns into a colour emoji on some). Decorative: the caller's text
	carries the meaning. The triangle takes `currentColor`; the mark inside takes
	`--yolo-glyph-ink` (near black by default), so it reads on any face.
-->
<script lang="ts">
	interface Props {
		class?: string;
	}

	let { class: className }: Props = $props();
</script>

<svg
	class={['yolo-glyph', className]}
	viewBox="0 0 16 16"
	width="1em"
	height="1em"
	aria-hidden="true"
	focusable="false"
>
	<path
		d="M8 1.6 15.2 14.2H.8Z"
		fill="currentColor"
		stroke="currentColor"
		stroke-width="1.2"
		stroke-linejoin="round"
	/>
	<path
		d="M8 6v4.2"
		stroke="var(--yolo-glyph-ink, #141210)"
		stroke-width="1.8"
		stroke-linecap="round"
	/>
	<circle cx="8" cy="12.3" r="1" fill="var(--yolo-glyph-ink, #141210)" />
</svg>

<style>
	.yolo-glyph {
		display: inline-block;
		flex: none;
		vertical-align: -0.125em;
	}
</style>
