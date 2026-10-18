<!--
	Modo YOLO bar: persistent and red while YOLO is on in this tab, on every page (top bar, Curva,
	Cabo), with "Desligar". Turning it off returns the editor to the standard gate profile at once;
	a YOLO checklist that is open can no longer write (its session item fails).
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { YoloState } from '#lib/state/yolo.svelte.ts';

	interface Props {
		yolo: YoloState;
	}

	let { yolo }: Props = $props();
</script>

{#if yolo.enabled}
	<div class="yolo-bar" role="status" data-yolo-bar>
		<strong class="tag">{m.yolo_tape()}</strong>
		<span class="text">
			{yolo.freePreview ? m.yolo_bar_free_preview() : m.yolo_bar()}
		</span>
		<button type="button" class="off" onclick={() => yolo.disable()} data-yolo-off>
			{m.yolo_off()}
		</button>
	</div>
{/if}

<style>
	.yolo-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 12px;
		padding: 6px 14px;
		background: #a3262c;
		color: #fff;
		font: 600 var(--fs-small, 13px) / 1.35 var(--face-body, 'Geist', sans-serif);
	}
	.tag {
		padding: 1px 6px;
		border: 1px solid #fff;
		border-radius: 2px;
		letter-spacing: 0.14em;
	}
	.text {
		flex: 1 1 18em;
		min-width: 0;
	}
	.off {
		margin-left: auto;
		padding: 4px 12px;
		border: 1px solid #fff;
		border-radius: 3px;
		background: #fff;
		color: #761115;
		font: inherit;
		cursor: pointer;
	}
	.off:focus-visible {
		outline: 2px solid #fff;
		outline-offset: 2px;
	}
</style>
