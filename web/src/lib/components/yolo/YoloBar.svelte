<!--
	Modo YOLO session bar: on every page of this tab while YOLO is on (the layout mounts it right
	under the top bar). One compact row with a hazard stripe: the YOLO tag, what is waived (a short
	form on phones), "Aviso" (the full warning, read-only, in the YOLO dialog) and a one-press
	"Desligar YOLO". Turning it off returns the editor to the standard gate profile at once; a YOLO
	checklist that is open can no longer write (its session item fails).

	Placement: sticky under the fixed top bar, with a fixed height. While it is mounted it adds its
	height to --bar-h on :root, so everything that clears the top bar through --bar-h (the
	document's scroll padding, the Curva sticky side rack, section scroll margins) clears this bar
	too: it never covers the content it scrolls over. Fits one row down to 320 px.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import Button from '#lib/components/primitives/Button.svelte';
	import type { YoloState } from '#lib/state/yolo.svelte.ts';
	import YoloDialog from './YoloDialog.svelte';
	import YoloGlyph from './YoloGlyph.svelte';

	interface Props {
		yolo: YoloState;
	}

	let { yolo }: Props = $props();
	let warningOpen = $state(false);

	function turnOff() {
		warningOpen = false;
		yolo.disable();
	}
</script>

{#if yolo.enabled}
	<section class="yb" aria-label={m.yolo_bar_label()} data-chrome="yolo" data-yolo-bar>
		<div class="yb-inner">
			<span class="yb-tag"><YoloGlyph />{m.yolo_tape()}</span>
			<p class="yb-sum" data-yolo-waived>
				<span class="yb-long">{yolo.freePreview ? m.yolo_bar_free_preview() : m.yolo_bar()}</span>
				<span class="yb-short">
					{yolo.freePreview ? m.yolo_bar_free_preview_short() : m.yolo_bar_short()}
				</span>
			</p>
			<button
				type="button"
				class="yb-link"
				aria-haspopup="dialog"
				onclick={() => (warningOpen = true)}
				data-yolo-warning
			>
				{m.yolo_bar_warning()}
			</button>
			<!-- Phones show only "Desligar"; the name always reads "Desligar YOLO". -->
			<button
				type="button"
				class="yb-off"
				aria-label="{m.yolo_off()} {m.yolo_tape()}"
				onclick={turnOff}
				data-yolo-off
			>
				<span>{m.yolo_off()}</span>
				<span class="yb-wide">{m.yolo_tape()}</span>
			</button>
		</div>
	</section>

	{#if warningOpen}
		<YoloDialog
			title={m.yolo_warning_title()}
			ondismiss={() => (warningOpen = false)}
			initialFocus="[data-yolo-warning-close]"
		>
			{#snippet actions()}
				<Button variant="plate" onclick={turnOff}>
					{m.yolo_off()}
					{m.yolo_tape()}
				</Button>
				<Button variant="primary" data-yolo-warning-close onclick={() => (warningOpen = false)}>
					{m.chrome_close()}
				</Button>
			{/snippet}
		</YoloDialog>
	{/if}
{/if}

<style>
	/*
	 * Height of this bar, and the top bar's own row under it (tokens --bar-h: 40 px, 52 px at
	 * 720 px and below, the same as CableBar's --bar-row). While the bar is mounted, --bar-h on
	 * :root grows by the bar's height. Unlayered, so it wins over the tokens' base layer.
	 */
	:global(:root:has([data-yolo-bar])) {
		--yolo-bar-h: 36px;
		--bar-h: calc(40px + var(--yolo-bar-h));
	}
	@media (max-width: 720px) {
		:global(:root:has([data-yolo-bar])) {
			--bar-h: calc(52px + var(--yolo-bar-h));
		}
	}
	@media (max-width: 640px) {
		:global(:root:has([data-yolo-bar])) {
			--yolo-bar-h: 44px;
		}
	}

	.yb {
		position: sticky;
		/* Right under the fixed top bar: --bar-h already includes this bar. */
		top: calc(var(--bar-h) - var(--yolo-bar-h));
		z-index: 55; /* over the page, under the top bar (60) and its menus */
		box-sizing: border-box;
		height: var(--yolo-bar-h);
		padding-bottom: 3px;
		/* Hazard stripe along the bottom edge, over a deep red face (white text >= 7:1). */
		background:
			repeating-linear-gradient(-45deg, #e5a23a 0 6px, #141210 6px 12px) left bottom / 100% 3px
				no-repeat,
			linear-gradient(180deg, #8c1d23, #6c1317);
		box-shadow:
			0 1px 0 rgb(0 0 0 / 0.6),
			0 10px 20px -16px rgb(0 0 0 / 0.9);
		color: #fff;
		font-family: var(--face-body);
	}
	.yb-inner {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		max-width: var(--frame-max);
		height: 100%;
		margin: auto;
		padding-inline: var(--gutter);
	}
	/* The tag reads like the rack's LCD: amber on black. */
	.yb-tag {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 5px;
		padding: 3px 8px;
		border-radius: var(--rad-xs);
		background: #0b0a09;
		box-shadow: var(--well);
		color: #f0b552;
		font: 600 var(--fs-caption) / 1 var(--face-body);
		letter-spacing: var(--tracking-caps);
		--yolo-glyph-ink: #0b0a09;
	}
	.yb-tag :global(.yolo-glyph) {
		font-size: 13px;
	}
	.yb-sum {
		flex: 1 1 auto;
		min-width: 0;
		margin: 0;
		font: 500 var(--fs-caption) / 1.3 var(--face-body);
	}
	.yb-long {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.yb-short {
		display: none;
	}
	.yb-link,
	.yb-off {
		position: relative;
		flex: none;
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		margin: 0;
		border-radius: var(--rad-sm);
		font: 600 var(--fs-caption) / 1 var(--face-body);
		white-space: nowrap;
		cursor: pointer;
	}
	/* Hit area up to the touch target without growing the bar. */
	.yb-link::after,
	.yb-off::after {
		content: '';
		position: absolute;
		inset: calc((28px - var(--hit)) / 2) 0;
	}
	.yb-link {
		padding: 0 var(--space-2);
		border: 0;
		background: none;
		color: #fff;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.yb-link:hover {
		background: rgb(255 255 255 / 0.12);
	}
	.yb-off {
		gap: 0.3em;
		padding: 0 var(--space-3);
		border: 1px solid #fff;
		background: #fff7f0;
		box-shadow: 0 1px 0 rgb(0 0 0 / 0.4);
		color: #6c1317;
	}
	.yb-off:hover {
		background: #fff;
	}
	.yb-link:focus-visible,
	.yb-off:focus-visible {
		outline: var(--focus-width) solid #ffd27a;
		outline-offset: 2px;
	}
	/* Phones: the short summary (two lines at most) and a shorter "Desligar". */
	@media (max-width: 640px) {
		.yb-inner {
			gap: var(--space-2);
		}
		.yb-tag {
			padding: 3px 6px;
		}
		.yb-long {
			display: none;
		}
		.yb-short {
			display: -webkit-box;
			overflow: hidden;
			-webkit-box-orient: vertical;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			font-size: var(--label-min);
			line-height: 1.25;
		}
		.yb-link,
		.yb-off {
			min-height: 34px;
		}
		.yb-link::after,
		.yb-off::after {
			inset: calc((34px - var(--hit)) / 2) 0;
		}
		.yb-link {
			padding: 0 6px;
		}
		.yb-off {
			padding: 0 10px;
		}
		/* The button's aria-label keeps "YOLO" in its name. */
		.yb-wide {
			display: none;
		}
	}
</style>
