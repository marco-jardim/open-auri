<!--
	Inline badge of a listed curve (library tapes, account rows), phrasing content only so it can
	sit inside a button or a link:
	- 'yolo': the YOLO badge (glyph + YOLO), with the compact line as its accessible text;
	- 'warn': the curve no longer passes the checks (neither standard nor YOLO today);
	- 'none': nothing.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { CurveBadge } from './yolo-curve.ts';
	import YoloGlyph from './YoloGlyph.svelte';

	let { badge }: { badge: CurveBadge } = $props();
</script>

{#if badge === 'yolo'}
	<span class="yb yb--yolo" data-curve-badge="yolo" title={m.yolo_curve_compact()}
		><YoloGlyph />{m.yolo_tape()}<span class="visually-hidden">: {m.yolo_curve_compact()}</span
		></span
	>
{:else if badge === 'warn'}
	<span class="yb yb--warn" data-curve-badge="warn">{m.yolopub_badge_warn()}</span>
{/if}

<style>
	.yb {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		width: fit-content;
		padding: 1px 6px;
		border-radius: var(--rad-xs, 2px);
		font: 700 var(--label-min, 11px) / 1.25 var(--face-body, 'Geist', sans-serif);
		letter-spacing: var(--tracking-caps, 0.14em);
	}
	.yb--yolo {
		--yolo-glyph-ink: #141210;
		background: #e5a23a;
		color: #141210;
	}
	.yb--warn {
		border: 1px solid currentColor;
		color: light-dark(#8f1d22, #ff8a85);
		letter-spacing: normal;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
</style>
