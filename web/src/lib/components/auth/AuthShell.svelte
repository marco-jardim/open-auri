<!--
	Page frame of the auth pages: one console channel strip (painted steel panel, scribble strip
	with the title, engraved sections, screw heads). Homage to Rupert Neve lives in the footer text
	only; nothing here imitates a maker's badge or logo.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';

	interface Props {
		/** Two-digit channel number printed on the cap (decorative). */
		channel: string;
		title: string;
		lede?: string;
		children: Snippet;
		/** Links under the strip (other auth pages). */
		footer?: Snippet;
	}

	let { channel, title, lede, children, footer }: Props = $props();
	const uid = $props.id();
</script>

<main class="auth-page" aria-labelledby="{uid}-title">
	<section class="strip">
		<div class="cap" aria-hidden="true">
			<span class="screw"></span>
			<span class="channel">{m.auth_channel({ number: channel })}</span>
			<span class="screw"></span>
		</div>
		<header class="scribble">
			<h1 id="{uid}-title">{title}</h1>
			{#if lede}<p class="lede">{lede}</p>{/if}
		</header>
		<div class="body">
			{@render children()}
		</div>
		{#if footer}
			<footer class="foot">{@render footer()}</footer>
		{/if}
		<div class="cap bottom" aria-hidden="true">
			<span class="screw"></span>
			<span class="screw"></span>
		</div>
	</section>
</main>

<style>
	.auth-page {
		--strip-bg: #1b2028;
		--strip-edge: #36414e;
		--strip-text: #e3e7ec;
		--strip-muted: #a9b2bd;
		--strip-well: #0e1115;
		--strip-rule: rgba(169, 178, 189, 0.22);
		--strip-paper: #e9e3d4;
		--strip-paper-ink: #24211c;
		--lamp-ok: #3ddc97;
		--lamp-warn: #f2b33d;
		--lamp-bad: #ff6b5e;

		display: flex;
		justify-content: center;
		padding: var(--space-7, 48px) var(--gutter, 24px) var(--space-6, 32px);
	}

	.strip {
		box-sizing: border-box;
		width: min(440px, 100%);
		border: 1px solid var(--strip-edge);
		border-radius: var(--rad-lg, 6px);
		background:
			linear-gradient(90deg, rgb(255 255 255 / 3%), transparent 18% 82%, rgb(0 0 0 / 18%)),
			var(--strip-bg);
		box-shadow:
			0 1px 0 rgb(255 255 255 / 6%) inset,
			0 18px 40px rgb(0 0 0 / 35%);
		color: var(--strip-text);
	}

	.cap {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3, 12px);
		padding: 10px 12px;
		border-bottom: 1px solid var(--strip-rule);
		background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 30%, #1b2028), #1b2028);
		border-radius: var(--rad-lg, 6px) var(--rad-lg, 6px) 0 0;
	}

	.cap.bottom {
		border-top: 1px solid var(--strip-rule);
		border-bottom: 0;
		background: transparent;
		border-radius: 0 0 var(--rad-lg, 6px) var(--rad-lg, 6px);
	}

	.screw {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background:
			linear-gradient(135deg, transparent 44%, rgb(0 0 0 / 55%) 45% 55%, transparent 56%),
			radial-gradient(circle at 35% 35%, #c9ced4, #6b7480 70%);
		box-shadow: 0 0 0 1px rgb(0 0 0 / 45%);
	}

	.channel {
		font: 600 12px/1 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.22em;
		text-transform: uppercase;
		color: var(--strip-text);
	}

	.scribble {
		margin: 18px 16px 4px;
		padding: 12px 14px 14px;
		border-radius: var(--rad-xs, 2px);
		background: var(--strip-paper);
		color: var(--strip-paper-ink);
		box-shadow: 0 1px 0 rgb(0 0 0 / 30%);
	}

	h1 {
		margin: 0;
		font-size: 34px;
		color: var(--strip-paper-ink);
	}

	.lede {
		margin: 8px 0 0;
		font-size: var(--fs-ui, 13px);
		line-height: 1.5;
		color: #4a443a;
	}

	.body {
		padding: 8px 16px 18px;
	}

	.foot {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 18px;
		padding: 12px 16px 14px;
		border-top: 1px solid var(--strip-rule);
		font-size: var(--fs-ui, 13px);
		color: var(--strip-muted);
	}

	.foot :global(a) {
		color: var(--strip-text);
	}

	.foot :global(a:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}

	@media (max-width: 640px) {
		.auth-page {
			padding-block: var(--space-5, 24px);
		}

		h1 {
			font-size: 30px;
		}
	}
</style>
