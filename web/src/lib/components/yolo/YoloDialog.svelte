<!--
	Modo YOLO dialog shell, shared by the consent dialog (YoloToggle) and the read-only warning
	(YoloBar). Built on the chrome's modal primitive (`modalDialog`): a native modal, Tab wraps
	inside it, Escape calls `ondismiss`, and focus goes back to the opener on close.

	Layout, top to bottom: a hazard tape (sticky), the eyebrow and title, a short lede (the
	dialog's accessible description), then four scannable sections:
	  01 What changes      (the policy limits YOLO waives)
	  02 What stays locked (the hardware locks it never waives)
	  03 Risks
	  04 How it ends       (session only)
	then the caller's `children` (the typed-phrase field) and its `actions`, in a footer that
	stays in view at the bottom while the sections scroll. The caller focuses the safe action
	first (`initialFocus`).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { m } from '#lib/paraglide/messages.js';
	import { modalDialog } from '#lib/components/chrome/modal.ts';
	import YoloGlyph from './YoloGlyph.svelte';

	interface Props {
		title: string;
		/** Escape and the caller's cancel or close button. */
		ondismiss: () => void;
		/** Selector of the element focused on open: the safe action (cancel or close). */
		initialFocus: string;
		/** When set, the body is a form and this handles its submit (the consent dialog). */
		onsubmit?: (event: SubmitEvent) => void;
		/** Between the sections and the actions (the typed-phrase field). */
		children?: Snippet;
		/** The action row (sticky footer). */
		actions: Snippet;
	}

	let { title, ondismiss, initialFocus, onsubmit, children, actions }: Props = $props();
	const id = $props.id();

	const changes = [
		{ key: 'gain-q', text: () => m.yolo_changes_gain_q() },
		{ key: 'hf', text: () => m.yolo_changes_hf() },
		{ key: 'preamp', text: () => m.yolo_changes_preamp() },
		{ key: 'sections', text: () => m.yolo_changes_sections() }
	] as const;
	const protectedLocks = [
		{ key: 'codec', text: () => m.yolo_protected_codec() },
		{ key: 'stability', text: () => m.yolo_protected_stability() },
		{ key: 'overflow', text: () => m.yolo_protected_overflow() },
		{ key: 'peak', text: () => m.yolo_protected_peak() }
	] as const;
	const risks = [
		{ key: 'distortion', text: () => m.yolo_risk_distortion() },
		{ key: 'level', text: () => m.yolo_risk_level() },
		{ key: 'damage', text: () => m.yolo_risk_damage() },
		{ key: 'responsibility', text: () => m.yolo_risk_responsibility() }
	] as const;
	const ends = [
		{ key: 'session', text: () => m.yolo_ends_session() },
		{ key: 'off', text: () => m.yolo_ends_off() },
		{ key: 'write', text: () => m.yolo_ends_write() }
	] as const;

	/** The warning is read from the top: undo any scroll the initial focus caused. */
	const startAtTop: Attachment<HTMLDialogElement> = (node) => {
		const frame = requestAnimationFrame(() => {
			node.scrollTop = 0;
		});
		return () => cancelAnimationFrame(frame);
	};
</script>

<dialog
	class="yd"
	aria-labelledby="{id}-title"
	aria-describedby="{id}-lede"
	use:modalDialog={{ open: true, onDismiss: ondismiss, initialFocus }}
	{@attach startAtTop}
	data-yolo-dialog
>
	<div class="yd-tape" aria-hidden="true"></div>
	{#if onsubmit}
		<form class="yd-body" {onsubmit} novalidate>{@render body()}</form>
	{:else}
		<div class="yd-body">{@render body()}</div>
	{/if}
</dialog>

{#snippet list(items: readonly { key: string; text: () => string }[], mark: string)}
	<ul>
		{#each items as item (item.key)}
			<li><span class="yd-mark" aria-hidden="true">{mark}</span><span>{item.text()}</span></li>
		{/each}
	</ul>
{/snippet}

{#snippet body()}
	<header class="yd-head">
		<p class="yd-eyebrow"><YoloGlyph />{m.yolo_dialog_eyebrow()}</p>
		<h2 id="{id}-title">{title}</h2>
		<p class="yd-lede" id="{id}-lede">{m.yolo_warning()}</p>
	</header>
	<div class="yd-grid">
		<section class="yd-sec" data-tone="changes" aria-labelledby="{id}-changes">
			<h3 id="{id}-changes">
				<span class="yd-num" aria-hidden="true">01</span>{m.yolo_section_changes()}
			</h3>
			<p>{m.yolo_changes_lede()}</p>
			{@render list(changes, '+')}
		</section>
		<section class="yd-sec" data-tone="protected" aria-labelledby="{id}-protected">
			<h3 id="{id}-protected">
				<span class="yd-num" aria-hidden="true">02</span>{m.yolo_section_protected()}
			</h3>
			<p>{m.yolo_protected_lede()}</p>
			{@render list(protectedLocks, '✓')}
		</section>
		<section class="yd-sec" data-tone="risks" aria-labelledby="{id}-risks">
			<h3 id="{id}-risks">
				<span class="yd-num" aria-hidden="true">03</span>{m.yolo_section_risks()}
			</h3>
			{@render list(risks, '!')}
		</section>
		<section class="yd-sec" data-tone="ends" aria-labelledby="{id}-ends">
			<h3 id="{id}-ends">
				<span class="yd-num" aria-hidden="true">04</span>{m.yolo_section_ends()}
			</h3>
			{@render list(ends, '○')}
		</section>
	</div>
	{#if children}
		<div class="yd-extra">{@render children()}</div>
	{/if}
	<div class="yd-actions">{@render actions()}</div>
{/snippet}

<style>
	.yd {
		box-sizing: border-box;
		width: 100%;
		max-width: min(780px, calc(100vw - 32px));
		max-height: calc(100dvh - 32px);
		padding: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		border: 1px solid color-mix(in srgb, var(--danger, #e5484d) 55%, var(--pop-rule, #34332f));
		border-radius: var(--rad-xl, 10px);
		/* Own dark face, like the chrome's dialogs: legible on any page (paper ones included). */
		background: var(--ink-2, #171715);
		color: var(--text, #ece7dd);
		font: 400 var(--fs-small, 13px) / var(--lh-body, 1.55)
			var(--face-body, 'Geist', system-ui, sans-serif);
		box-shadow: var(--elev-3, 0 24px 64px -16px rgb(0 0 0 / 0.8));
		color-scheme: dark;
	}
	.yd::backdrop {
		background: rgb(5 5 4 / 78%);
		backdrop-filter: blur(2px);
	}
	/* Hazard tape: amber and black, the one place the stripes run full width. */
	.yd-tape {
		position: sticky;
		top: 0;
		z-index: 1;
		height: 8px;
		background: repeating-linear-gradient(-45deg, #e5a23a 0 8px, #141210 8px 16px);
	}
	.yd-body {
		display: grid;
		gap: var(--space-4, 16px);
		padding: var(--panel-pad, 20px) var(--panel-pad, 20px) 0;
	}
	.yd-head {
		display: grid;
		gap: var(--space-2, 8px);
	}
	.yd-eyebrow {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
		margin: 0;
		color: var(--warn, #e5a23a);
		font: 500 var(--fs-eyebrow, 11px) / var(--lh-caps, 1.35) var(--face-data, monospace);
		letter-spacing: var(--tracking-eyebrow, 0.18em);
		text-transform: uppercase;
	}
	.yd-eyebrow :global(.yolo-glyph) {
		font-size: 15px;
	}
	h2 {
		margin: 0;
		font: italic 400 var(--fs-title, 24px) / var(--lh-title, 1.1)
			var(--face-display, Georgia, serif);
		letter-spacing: var(--tracking-title, -0.01em);
	}
	.yd-lede {
		max-width: 64ch;
		margin: 0;
		color: var(--text-2, #cfc9be);
		font-size: var(--fs-body, 15px);
	}
	.yd-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
		gap: var(--space-3, 12px);
	}
	.yd-sec {
		--tone: var(--text-2, #cfc9be);
		display: grid;
		align-content: start;
		gap: var(--space-2, 8px);
		padding: var(--space-3, 12px) var(--space-4, 16px) var(--space-3, 12px) 18px;
		border: 1px solid var(--rule, rgb(236 231 221 / 0.12));
		border-radius: var(--rad-md, 4px);
		background: var(--ink-3, #1d1c1a);
		box-shadow: inset 3px 0 0 var(--tone);
	}
	.yd-sec[data-tone='changes'] {
		--tone: var(--warn, #e5a23a);
	}
	.yd-sec[data-tone='protected'] {
		--tone: var(--ok, #4cc38a);
	}
	.yd-sec[data-tone='risks'] {
		/* Lightened like .chip--danger: >= 4.5:1 on the raised panel. */
		--tone: color-mix(in srgb, var(--danger, #e5484d) 70%, white);
	}
	h3 {
		display: flex;
		align-items: baseline;
		gap: var(--space-2, 8px);
		margin: 0;
		color: var(--text, #ece7dd);
		font: 600 var(--fs-small, 13px) / 1.2 var(--face-body, 'Geist', sans-serif);
		letter-spacing: var(--tracking-caps, 0.14em);
		text-transform: uppercase;
	}
	.yd-num {
		color: var(--tone);
		font: 500 var(--label-min, 11px) / 1 var(--face-data, monospace);
		letter-spacing: var(--tracking-data, 0.02em);
	}
	.yd-sec p {
		margin: 0;
		color: var(--text-2, #cfc9be);
	}
	.yd-sec ul {
		display: grid;
		gap: var(--space-1, 4px);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.yd-sec li {
		display: grid;
		grid-template-columns: 1.1em minmax(0, 1fr);
		gap: 6px;
	}
	.yd-mark {
		color: var(--tone);
		font: 600 var(--fs-small, 13px) / inherit var(--face-data, monospace);
		text-align: center;
	}
	.yd-extra {
		display: grid;
		gap: var(--space-2, 8px);
	}
	/* The actions stay in view while the sections scroll: cancel is always one key away. */
	.yd-actions {
		position: sticky;
		bottom: 0;
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-3, 12px);
		margin: 0 calc(-1 * var(--panel-pad, 20px));
		padding: var(--space-3, 12px) var(--panel-pad, 20px);
		border-top: 1px solid var(--rule, rgb(236 231 221 / 0.12));
		background: var(--ink-2, #171715);
		box-shadow: 0 -12px 18px -14px rgb(0 0 0 / 0.9);
	}
</style>
