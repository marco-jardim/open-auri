<!--
	YOLO curve notice: marks a curve flagged YOLO wherever it travels after the editor, so whoever
	meets it knows it was made beyond the standard limits before writing it.

	Variants (the title and the first line change, the disclaimer does not):
	- 'editor'  the curve in the editor;
	- 'library' a curve saved in the library;
	- 'share'   a curve opened from a link or a file;
	- 'public'  a published curve (its page, a card or the feed).

	Full (default): badge, title, lede, the optional list of waived reasons, then the disclaimer in
	three labelled parts: writing it requires YOLO on in Engenharia plus a confirmation; the risks;
	the hardware locks that still apply. `compact` (cards, feed rows): badge, glyph and one line,
	no interactive content, so it can sit inside a card link.

	Reads on dark and light surfaces: its own face follows the inherited `color-scheme` (the
	paper surfaces already set `light`), with a dark fallback where light-dark() is missing.
-->
<script module lang="ts">
	export type YoloCurveVariant = 'editor' | 'library' | 'share' | 'public';
</script>

<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { m } from '#lib/paraglide/messages.js';
	import YoloGlyph from './YoloGlyph.svelte';

	interface Props extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'role'> {
		/** Where the curve is shown. */
		variant: YoloCurveVariant;
		/**
		 * What this curve waived, as display text already in the page's language (for example the
		 * checklist's lamp labels). Empty, blank or absent: no list. Duplicates are dropped.
		 */
		waived?: readonly string[];
		/** Card mode: badge, glyph and one line. */
		compact?: boolean;
		/** Level of the full notice's title (default 3). */
		headingLevel?: 2 | 3 | 4 | 5 | 6;
	}

	let {
		variant,
		waived = [],
		compact = false,
		headingLevel = 3,
		class: className,
		...rest
	}: Props = $props();
	const id = $props.id();

	const titles: Record<YoloCurveVariant, () => string> = {
		editor: () => m.yolo_curve_title_editor(),
		library: () => m.yolo_curve_title_library(),
		share: () => m.yolo_curve_title_share(),
		public: () => m.yolo_curve_title_public()
	};
	const ledes: Record<YoloCurveVariant, () => string> = {
		editor: () => m.yolo_curve_lede_editor(),
		library: () => m.yolo_curve_lede_library(),
		share: () => m.yolo_curve_lede_share(),
		public: () => m.yolo_curve_lede_public()
	};
	const reasons = $derived([
		...new Set(waived.map((reason) => reason.trim()).filter((reason) => reason !== ''))
	]);
</script>

{#if compact}
	<p
		{...rest}
		class={['ycn', 'ycn--compact', className]}
		role="note"
		aria-label={m.yolo_curve_aria()}
		data-yolo-curve-notice={variant}
		data-compact
	>
		<span class="ycn-badge"><YoloGlyph />{m.yolo_tape()}</span>
		<span class="ycn-line">
			{m.yolo_curve_compact()}
			{#if reasons.length > 0}
				<span class="ycn-inline">({reasons.join(', ')})</span>
			{/if}
		</span>
	</p>
{:else}
	<div
		{...rest}
		class={['ycn', className]}
		role="note"
		aria-labelledby="{id}-title"
		data-yolo-curve-notice={variant}
	>
		<div class="ycn-head">
			<span class="ycn-badge"><YoloGlyph />{m.yolo_tape()}</span>
			<svelte:element this={`h${headingLevel}`} id="{id}-title" class="ycn-title">
				{titles[variant]()}
			</svelte:element>
		</div>
		<p class="ycn-lede">{ledes[variant]()}</p>
		{#if reasons.length > 0}
			<div class="ycn-waived">
				<span class="ycn-k" id="{id}-waived">{m.yolo_curve_waived()}</span>
				<ul aria-labelledby="{id}-waived">
					{#each reasons as reason (reason)}
						<li>{reason}</li>
					{/each}
				</ul>
			</div>
		{/if}
		<dl class="ycn-facts">
			<div data-tone="write">
				<dt>{m.yolo_curve_label_write()}</dt>
				<dd>{m.yolo_curve_write()}</dd>
			</div>
			<div data-tone="risks">
				<dt>{m.yolo_section_risks()}</dt>
				<dd>{m.yolo_curve_risks()}</dd>
			</div>
			<div data-tone="locks">
				<dt>{m.yolo_curve_label_locks()}</dt>
				<dd>{m.yolo_curve_locks()}</dd>
			</div>
		</dl>
	</div>
{/if}

<style>
	.ycn {
		/* Light and dark faces: every text pair >= 4.5:1 on its own background. */
		--ycn-bg: light-dark(#fbf1df, #1c1512);
		--ycn-fg: light-dark(#2a1f16, #ece7dd);
		--ycn-fg-2: light-dark(#4f4033, #cfc9be);
		--ycn-rule: light-dark(rgb(66 47 28 / 0.3), rgb(236 231 221 / 0.16));
		--ycn-red: light-dark(#8f1d22, #ff8a85);
		--ycn-ok: light-dark(#1d6b45, #4cc38a);
		--ycn-stripe: repeating-linear-gradient(-45deg, #e5a23a 0 6px, #141210 6px 12px);
		box-sizing: border-box;
		margin: 0;
		border: 1px solid var(--ycn-rule);
		color: var(--ycn-fg);
		font: 400 var(--fs-small, 13px) / var(--lh-small, 1.4) var(--face-body, 'Geist', sans-serif);
	}
	@supports not (color: light-dark(#000, #fff)) {
		.ycn {
			--ycn-bg: #1c1512;
			--ycn-fg: #ece7dd;
			--ycn-fg-2: #cfc9be;
			--ycn-rule: rgb(236 231 221 / 0.16);
			--ycn-red: #ff8a85;
			--ycn-ok: #4cc38a;
		}
	}

	/* Full notice: a hazard edge down the left, then the text. */
	.ycn:not(.ycn--compact) {
		display: grid;
		gap: var(--space-3, 12px);
		padding: var(--space-4, 16px) var(--space-4, 16px) var(--space-4, 16px) 28px;
		border-radius: var(--rad-md, 4px);
		background:
			var(--ycn-stripe) left top / 10px 100% no-repeat,
			var(--ycn-bg);
	}
	.ycn-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 8px) var(--space-3, 12px);
	}
	.ycn-badge {
		--yolo-glyph-ink: #e5a23a;
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 4px;
		padding: 2px 7px;
		border-radius: var(--rad-xs, 2px);
		background: #e5a23a;
		color: #141210;
		font: 700 var(--label-min, 11px) / 1.25 var(--face-body, 'Geist', sans-serif);
		letter-spacing: var(--tracking-caps, 0.14em);
	}
	.ycn-badge :global(.yolo-glyph) {
		font-size: 12px;
	}
	.ycn-title {
		margin: 0;
		color: var(--ycn-fg);
		font: 600 var(--fs-ui, 14px) / var(--lh-ui, 1.3) var(--face-body, 'Geist', sans-serif);
	}
	.ycn-lede {
		max-width: 70ch;
		margin: 0;
	}
	.ycn-waived {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2, 8px);
	}
	.ycn-k,
	dt {
		color: var(--ycn-fg-2);
		font: 600 var(--label-min, 11px) / var(--lh-caps, 1.35) var(--face-body, 'Geist', sans-serif);
		letter-spacing: var(--tracking-caps, 0.14em);
		text-transform: uppercase;
	}
	.ycn-waived ul {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.ycn-waived li {
		padding: 1px 8px;
		border: 1px solid color-mix(in srgb, #e5a23a 65%, transparent);
		border-radius: var(--rad-pill, 999px);
		font: 500 var(--label-min, 11px) / 1.4 var(--face-data, monospace);
	}
	.ycn-facts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
		gap: var(--space-3, 12px);
		margin: 0;
		padding-top: var(--space-3, 12px);
		border-top: 1px solid var(--ycn-rule);
	}
	.ycn-facts > div {
		display: grid;
		align-content: start;
		gap: 2px;
	}
	.ycn-facts [data-tone='risks'] dt {
		color: var(--ycn-red);
	}
	.ycn-facts [data-tone='locks'] dt {
		color: var(--ycn-ok);
	}
	dd {
		margin: 0;
	}

	/* Compact (cards, feed rows): badge and one line, wraps instead of hiding words. */
	.ycn--compact {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2, 8px);
		max-width: 100%;
		padding: 3px 8px 3px 3px;
		border-radius: var(--rad-sm, 3px);
		background: var(--ycn-bg);
		font-size: var(--fs-caption, 12px);
		line-height: 1.35;
	}
	.ycn--compact .ycn-badge {
		margin-top: 1px;
	}
	.ycn-line {
		min-width: 0;
		padding-top: 1px;
	}
	.ycn-inline {
		color: var(--ycn-fg-2);
	}
</style>
