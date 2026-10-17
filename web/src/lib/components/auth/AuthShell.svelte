<!--
	Page frame of the auth pages: one vertical console channel strip (painted blue-grey steel
	panel, scribble strip with the title, engraved stages, screw heads, a signal rule down the
	left). The fields are the stages of the channel, top to bottom (spec §3, Rupert Neve):
	  Entrada = the identity (e-mail, code)      Ganho = the secret (password, confirmation)
	  EQ      = the human check (Turnstile)      Saída = the submit switch
	Each stage lamp lights only from real validation state: the browser's constraint validation
	of the field, the confirmation matching, a Turnstile token present. The Saída lamp lights when
	every stage on the strip is lit. Nothing animates on a timer; no lamp pretends to measure.
	Homage to Rupert Neve lives in the footer text only; nothing imitates a maker's badge or logo.
-->
<script module lang="ts">
	import { getContext, setContext } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';

	export type StageId = 'input' | 'gain' | 'eq' | 'output';

	const CHANNEL = Symbol('auth-channel');
	let nextStage = 0;

	/** Lit state of every stage registered on the strip (real validation only). */
	export class AuthChannel {
		/** Lit state per registered stage; null once the stage left the strip. */
		#lit = $state<Record<string, boolean | null>>({});

		set(key: string, on: boolean): void {
			this.#lit[key] = on;
		}

		drop(key: string): void {
			this.#lit[key] = null;
		}

		/** True when at least one stage is registered and every one of them validates. */
		get ready(): boolean {
			const values = Object.values(this.#lit).filter((value) => value !== null);
			return values.length > 0 && values.every(Boolean);
		}
	}

	/** The strip's channel, or undefined when a form renders outside AuthShell (tests). */
	export function getChannel(): AuthChannel | undefined {
		return getContext<AuthChannel | undefined>(CHANNEL);
	}

	/**
	 * Registers a stage of the strip for the calling component. `on` returns the stage's real
	 * validation state, or null while the component is not a stage (it is then unregistered).
	 */
	export function trackStage(on: () => boolean | null): void {
		const channel = getChannel();
		if (!channel) return;
		const key = `stage-${nextStage++}`;
		$effect(() => {
			const state = on();
			if (state === null) channel.drop(key);
			else channel.set(key, state);
		});
		$effect(() => () => channel.drop(key));
	}

	/** Engraved name of a stage (Entrada, Ganho, EQ, Saída). */
	export function stageLabel(stage: StageId): string {
		switch (stage) {
			case 'input':
				return m.fuxp8_stage_input();
			case 'gain':
				return m.fuxp8_stage_gain();
			case 'eq':
				return m.fuxp8_stage_eq();
			case 'output':
				return m.fuxp8_stage_output();
		}
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

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
	setContext(CHANNEL, new AuthChannel());
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
		/* Engraving face of the auth and profile pages (spec §2.1). */
		--face-engrave: var(--cond, 'Barlow Condensed', sans-serif);
		/* Width of the stage column (knob, engraved name, lamp) left of the fields. */
		--stage-gutter: 52px;

		display: flex;
		justify-content: center;
		padding: var(--space-7, 48px) var(--gutter, 24px) var(--space-6, 32px);
	}

	.strip {
		box-sizing: border-box;
		width: min(480px, 100%);
		border: 1px solid var(--strip-edge);
		border-radius: var(--rad-lg, 6px);
		background:
			repeating-linear-gradient(180deg, transparent 0 3px, rgb(255 255 255 / 1.2%) 3px 4px),
			linear-gradient(90deg, rgb(255 255 255 / 3%), transparent 18% 82%, rgb(0 0 0 / 18%)),
			var(--strip-bg);
		box-shadow: var(--elev-2, 0 18px 40px rgb(0 0 0 / 35%)), var(--bevel, 0 0 0 transparent);
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
		font: 600 var(--fs-caption, 12px) / 1 var(--face-engrave);
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
		font-family: var(--face-display, var(--serif));
		font-size: var(--fs-display-m, 34px);
		font-weight: 400;
		line-height: var(--lh-title, 1.1);
		letter-spacing: var(--tracking-title, -0.01em);
		color: var(--strip-paper-ink);
	}

	.lede {
		margin: 8px 0 0;
		font-size: var(--fs-small, 13px);
		line-height: 1.5;
		color: #4a443a;
	}

	/* The channel: a signal rule runs down the stage column; each stage hangs on it. */
	.body {
		position: relative;
		padding: 8px 16px 18px calc(16px + var(--stage-gutter) + 8px);
	}

	.body::before {
		content: '';
		position: absolute;
		top: 18px;
		bottom: 26px;
		left: calc(16px + var(--stage-gutter) / 2);
		width: 1px;
		background: linear-gradient(180deg, transparent, var(--strip-rule) 8% 92%, transparent);
	}

	/* Stage mark (rendered by AuthField, HumanCheck and SubmitSwitch, aria-hidden). */
	.body :global(.stage-host) {
		position: relative;
	}

	.body :global(.stage) {
		position: absolute;
		top: 0;
		left: calc(-8px - var(--stage-gutter));
		display: grid;
		justify-items: center;
		gap: 4px;
		width: var(--stage-gutter);
		padding: 2px 0 4px;
		background: var(--strip-bg);
	}

	.body :global(.stage__knob) {
		display: block;
		width: 22px;
		height: 22px;
		color: var(--strip-muted);
	}

	.body :global(.stage__knob .pointer) {
		transform-box: view-box;
		transform-origin: 50% 50%;
		transform: rotate(-135deg);
		transition: transform var(--dur-slow, 0.36s) var(--ease-mech, ease-out);
	}

	/* The knob turns up when, and only when, its stage validates. */
	.body :global(.stage[data-on='true'] .stage__knob .pointer) {
		transform: rotate(45deg);
	}

	.body :global(.stage__name) {
		font: 600 var(--label-min, 11px) / 1 var(--face-engrave);
		letter-spacing: var(--tracking-caps, 0.14em);
		text-transform: uppercase;
		color: var(--strip-muted);
	}

	.body :global(.stage[data-on='true'] .stage__name) {
		color: var(--strip-text);
	}

	.foot {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 18px;
		padding: 12px 16px 14px;
		border-top: 1px solid var(--strip-rule);
		font-size: var(--fs-small, 13px);
		color: var(--strip-muted);
	}

	.foot :global(a) {
		color: var(--strip-text);
	}

	.foot :global(a:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}

	/* Narrow screens: the Turnstile widget needs 300 px, so the stage column folds into an
	   engraved row above each stage. */
	@media (max-width: 520px) {
		.auth-page {
			padding-block: var(--space-5, 24px);
		}

		.body {
			padding-left: 16px;
		}

		.body::before {
			display: none;
		}

		.body :global(.stage) {
			position: static;
			display: flex;
			align-items: center;
			justify-content: flex-end;
			gap: 6px;
			width: auto;
			margin-bottom: 6px;
			padding: 0;
			background: transparent;
		}

		/* On a field the row shares the label's line, at its right end. */
		.body :global(.auth-field > .stage) {
			margin-bottom: -16px;
		}

		.body :global(.stage__knob) {
			width: 16px;
			height: 16px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.body :global(.stage__knob .pointer) {
			transition: none;
		}
	}
</style>
