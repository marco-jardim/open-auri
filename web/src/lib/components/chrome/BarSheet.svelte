<!--
	Mobile menu sheet (FUX.NAV). At 720 px and below the bar is one row (wordmark, cable lamp,
	Áudio, Gravar, this sheet's button); the sheet holds the rest: the account, every
	destination, the editor presets (Neutro, Padrão Auri), the language and the help. A native
	modal dialog: focus is trapped, Escape or the backdrop closes it, focus goes back to the
	button. Its own chunk, imported on the button's first hover, focus or press.
	Actions close the sheet first, then act, so the toast or the dialog they open is in view.
-->
<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { m } from '#lib/paraglide/messages.js';
	import Button from '#lib/components/primitives/Button.svelte';
	import IconButton from '#lib/components/primitives/IconButton.svelte';
	import LanguageToggle from './LanguageToggle.svelte';
	import { modalDialog } from './modal.ts';
	import { mainLinks, navPathname, warmLink } from './nav-links.ts';

	interface Props {
		currentPath: string;
		/** Custom navigation snippet of the bar (rendered here too). */
		navigation?: Snippet;
		/** The bar's account snippet (the layout renders AccountEntry). */
		account?: Snippet;
		/** Show Neutro and Padrão Auri (false when the bar got custom actions). */
		tools: boolean;
		onNeutro?: () => void;
		onPadraoAuri?: () => void;
		/** Why Neutro and Padrão Auri wait (the editor is still loading). */
		editorReason: string;
		/** Opens the help dialog (the layout's lazy HelpOverlay). */
		onHelp?: () => void;
		onclose: () => void;
	}

	let {
		currentPath,
		navigation,
		account,
		tools,
		onNeutro,
		onPadraoAuri,
		editorReason,
		onHelp,
		onclose
	}: Props = $props();
	const id = $props.id();
	const links = $derived(mainLinks());
	const pathname = $derived(navPathname(currentPath));

	async function closeThen(action: (() => void) | undefined): Promise<void> {
		onclose();
		await tick();
		action?.();
	}

	/**
	 * A press on the backdrop lands on the dialog element itself (its content fills it); the
	 * keyboard closes with Escape or the close button.
	 */
	const backdrop: Attachment<HTMLDialogElement> = (node) => {
		const press = (event: MouseEvent) => {
			if (event.target === node) onclose();
		};
		node.addEventListener('click', press);
		return () => node.removeEventListener('click', press);
	};
</script>

<dialog
	class="bar-sheet"
	aria-labelledby="{id}-title"
	use:modalDialog={{ open: true, onDismiss: onclose, initialFocus: '[data-sheet-close]' }}
	{@attach backdrop}
>
	<div class="sheet-inner">
		<div class="sheet-head">
			<h2 id="{id}-title" class="sheet-title">{m.fuxnav_sheet_title()}</h2>
			<IconButton
				size="sm"
				variant="ghost"
				class="btn--bar"
				label={m.fuxnav_menu_close()}
				data-sheet-close
				onclick={onclose}
			>
				<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
					<path
						d="M3.5 3.5l9 9m0-9-9 9"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
					/>
				</svg>
			</IconButton>
		</div>

		{#if account}
			<!-- First, so the user menu has room to open below its trigger. -->
			<div class="sheet-section sheet-account">{@render account()}</div>
		{/if}

		<div class="sheet-section">
			{#if navigation}
				{@render navigation()}
			{:else}
				<!-- Every destination, 48 px rows, with the bar links' preload and warm-up. -->
				<nav class="sheet-nav" aria-label={m.chrome_nav_label()}>
					<ul>
						{#each links as item, index (item.href)}
							<li>
								<a
									class="sheet-link"
									href={item.href}
									data-sveltekit-preload-code="hover"
									aria-current={pathname === item.href ? 'page' : undefined}
									onpointerenter={() => warmLink(item.href)}
									onfocus={() => warmLink(item.href)}
									onclick={onclose}
								>
									<span class="sheet-index" aria-hidden="true"
										>{String(index + 1).padStart(2, '0')}</span
									>
									<span>{item.label}</span>
								</a>
							</li>
						{/each}
					</ul>
				</nav>
			{/if}
		</div>

		{#if tools}
			<section class="sheet-section bar-tools" aria-labelledby="{id}-tools">
				<h3 id="{id}-tools" class="sheet-eyebrow">{m.fuxnav_tools()}</h3>
				<div class="sheet-row">
					<Button
						variant="plate"
						size="lg"
						disabledReason={onNeutro ? null : editorReason}
						onclick={() => void closeThen(onNeutro)}
					>
						{m.chrome_neutral()}
					</Button>
					<Button
						variant="plate"
						size="lg"
						disabledReason={onPadraoAuri ? null : editorReason}
						onclick={() => void closeThen(onPadraoAuri)}
					>
						{m.chrome_default_auri()}
					</Button>
				</div>
				<p class="sheet-hint">{m.fuxnav_tools_hint()}</p>
			</section>
		{/if}

		<div class="sheet-section sheet-prefs">
			<div class="sheet-pref">
				<span class="sheet-eyebrow" aria-hidden="true">{m.fuxnav_sheet_language()}</span>
				<LanguageToggle variant="full" />
			</div>
			{#if onHelp}
				<Button variant="ghost" size="lg" class="sheet-help" onclick={() => void closeThen(onHelp)}>
					<span class="help-glyph" aria-hidden="true">?</span>
					{m.chrome_help_open()}
				</Button>
			{/if}
		</div>
	</div>
</dialog>

<style>
	.bar-sheet {
		box-sizing: border-box;
		position: fixed;
		inset: 0 0 0 auto;
		width: min(100vw, 420px);
		max-width: none;
		height: 100dvh;
		max-height: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		border: 0;
		border-left: 1px solid var(--pop-rule);
		background: var(--ink-2);
		box-shadow: var(--elev-3);
		color: var(--text);
		font-family: var(--face-body);
	}

	.bar-sheet::backdrop {
		background: rgb(5 5 4 / 72%);
	}

	.sheet-inner {
		display: grid;
		align-content: start;
		gap: var(--space-4);
		box-sizing: border-box;
		min-height: 100%;
		padding: 0 var(--gutter) var(--space-6);
	}

	/* Same height as the bar row, so the close button sits where the menu button was. */
	.sheet-head {
		position: sticky;
		top: 0;
		z-index: 1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 52px;
		margin-inline: calc(-1 * var(--gutter));
		padding-inline: var(--gutter) calc(var(--gutter) - 4px);
		border-bottom: 1px solid var(--rule);
		background: var(--ink-2);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
	}

	.sheet-title {
		margin: 0;
		font: italic 400 var(--fs-title) / var(--lh-title) var(--face-display);
		letter-spacing: var(--tracking-title);
	}

	.sheet-section {
		display: grid;
		gap: var(--space-2);
	}

	.sheet-nav ul {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.sheet-link {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		box-sizing: border-box;
		min-height: 48px;
		padding: 0 var(--space-3);
		border-radius: var(--rad-md);
		color: var(--text-2);
		font: 500 var(--fs-body) / var(--lh-ui) var(--face-body);
		text-decoration: none;
	}

	.sheet-link:hover,
	.sheet-link[aria-current='page'] {
		background: var(--lamp-off);
		color: var(--text);
	}

	.sheet-link[aria-current='page'] {
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.sheet-link:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: -2px;
	}

	/* Index numerals are data (mono 400), like the pages' "01 / CURVA" eyebrows. */
	.sheet-index {
		min-width: 2ch;
		color: var(--muted);
		font: 400 var(--label-min) / 1 var(--face-data);
		letter-spacing: var(--tracking-data);
		font-variant-numeric: tabular-nums slashed-zero;
	}

	/* On the raised row the muted grey would drop under 4.5:1; the accent edge marks the page. */
	.sheet-link:hover .sheet-index,
	.sheet-link[aria-current='page'] .sheet-index {
		color: var(--text-2);
	}

	.sheet-section + .sheet-section {
		padding-top: var(--space-4);
		border-top: 1px solid var(--rule);
	}

	.sheet-inner .sheet-account :global(.account-trigger),
	.sheet-inner .sheet-account :global(.account) {
		justify-content: flex-start;
		width: 100%;
		max-width: none;
	}

	.sheet-eyebrow {
		margin: 0;
		color: var(--muted);
		font: 500 var(--fs-eyebrow) / var(--lh-caps) var(--face-data);
		letter-spacing: var(--tracking-eyebrow);
		text-transform: uppercase;
	}

	.sheet-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2);
	}

	.sheet-hint {
		margin: 0;
		color: var(--text-2);
		font-size: var(--fs-small);
		line-height: var(--lh-small);
	}

	.sheet-pref {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		min-height: 48px;
	}

	.sheet-prefs :global(.sheet-help) {
		justify-content: flex-start;
		width: 100%;
		padding-inline: var(--space-3);
	}

	.help-glyph {
		display: inline-grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border: 1px solid var(--rule-control);
		border-radius: 50%;
		font-weight: 600;
	}

	@media (prefers-reduced-motion: no-preference) {
		.bar-sheet[open] {
			animation: sheet-in var(--dur-slow) var(--ease-out);
		}

		.bar-sheet[open]::backdrop {
			animation: sheet-fade var(--dur-base) var(--ease-out);
		}
	}

	/* Slide only: the sheet's text keeps full contrast on every frame of its entrance (an opacity
	   fade put the open menu at ~36 % for 300 ms: 2.9:1, an axe failure while it is usable). The
	   backdrop still fades. */
	@keyframes sheet-in {
		from {
			translate: 24px 0;
		}
	}

	@keyframes sheet-fade {
		from {
			opacity: 0;
		}
	}
</style>
