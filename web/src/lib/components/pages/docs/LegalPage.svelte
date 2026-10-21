<script lang="ts">
	import {
		resolveLegalDocument,
		type LegalDocument,
		type PublicLegalValues
	} from '#lib/content/docs/legal.ts';
	import type { LegalUi } from './legal-ui.ts';
	import InlineText from './InlineText.svelte';
	import { keyboardScroll } from './keyboard-scroll.ts';
	let {
		document: template,
		values,
		ui
	}: { document: LegalDocument; values: PublicLegalValues; ui: LegalUi } = $props();
	const document = $derived(resolveLegalDocument(template, values));
	/** Numbered headings get a stable, language-independent anchor, e.g. /privacidade#secao-17. */
	const sectionId = (text: string) => /^(\d+)\.\s/.exec(text)?.[1] ?? null;
</script>

<main class="legal-paper" data-surface="paper" lang={document.locale} aria-labelledby="legal-title">
	<nav aria-label={ui.contents}>
		<a href="/docs">{ui.back}</a><a href="/privacidade">{ui.privacy}</a><a href="/termos"
			>{ui.terms}</a
		>
	</nav>
	<header>
		<p>open-auri · {ui.version} {values.PUBLIC_POLICY_EFFECTIVE_DATE}</p>
		<h1 id="legal-title">{document.title}</h1>
	</header>
	{#each document.blocks as block, index (index)}
		{#if block.kind === 'heading'}{@const n = sectionId(block.text)}
			<h2 id={n ? `secao-${n}` : undefined}><InlineText text={block.text} /></h2>
		{:else if block.kind === 'paragraph'}<p><InlineText text={block.text} /></p>
		{:else if block.kind === 'list'}<ul>
				{#each block.items as item (item)}<li><InlineText text={item} /></li>{/each}
			</ul>
		{:else}<div class="table-scroll" role="region" use:keyboardScroll aria-label={document.title}>
				<table>
					<thead
						><tr
							>{#each block.rows[0] ?? [] as cell (cell)}<th scope="col"
									><InlineText text={cell} /></th
								>{/each}</tr
						></thead
					><tbody
						>{#each block.rows.slice(1) as row (row[0])}<tr
								>{#each row as cell, column (block.rows[0]?.[column] ?? column)}<td
										><InlineText text={cell} /></td
									>{/each}</tr
							>{/each}</tbody
					>
				</table>
			</div>{/if}
	{/each}
	<p><a href="/docs#aviso-legal">{ui.back} · #aviso-legal</a></p>
</main>

<style>
	/* Typography from the tokens: display title, lede opening, body 15 at --lh-body, ~68ch. */
	.legal-paper {
		--legal-measure: 68ch;
		box-sizing: border-box;
		max-width: 100%;
		background: #efe6d2;
		color: #29251f;
		padding: var(--space-6, 32px) var(--space-5, 24px) var(--space-8, 64px);
		font: 400 var(--fs-body) / var(--lh-body) var(--face-body);
		font-kerning: normal;
		hyphens: auto;
		overflow-wrap: break-word;
	}
	.legal-paper > :global(*) {
		max-width: var(--legal-measure);
		margin-inline: auto;
	}
	.legal-paper > .table-scroll {
		max-width: min(100%, 960px);
	}
	nav {
		display: flex;
		flex-wrap: wrap;
		gap: 12px 24px;
		font: 500 var(--fs-small) / var(--lh-small) var(--face-body);
	}
	header {
		text-align: center;
		padding: var(--space-6, 32px) 0;
		border-bottom: 3px double #29251f;
		margin-bottom: var(--space-6, 32px);
	}
	header p {
		margin: 0;
		color: #6b5e4c;
		font: 400 var(--fs-eyebrow) / var(--lh-caps) var(--face-data);
		letter-spacing: var(--tracking-eyebrow, 0.18em);
		text-transform: uppercase;
		font-variant-numeric: tabular-nums slashed-zero;
	}
	h1 {
		font: 400 var(--fs-display-m) / var(--lh-display-m) var(--journal);
		letter-spacing: -0.015em;
		text-wrap: balance;
		margin: var(--space-4, 16px) 0 0;
	}
	/* The opening paragraph reads as the lede; the text itself is literal and unchanged. */
	header + p {
		font-size: var(--fs-lede);
		line-height: var(--lh-lede);
	}
	h2 {
		font: 400 var(--fs-title) / var(--lh-title) var(--journal);
		letter-spacing: -0.01em;
		text-wrap: balance;
		margin: var(--space-7, 48px) auto var(--space-3, 12px);
		border-top: 1px solid #ad9c81;
		padding-top: var(--space-5, 24px);
	}
	p,
	li {
		margin-block: 0 var(--space-3, 12px);
		text-wrap: pretty;
	}
	ul {
		padding-left: 1.25em;
	}
	li::marker {
		color: #8c2f2f;
	}
	a {
		color: #8c2f2f;
		text-decoration-line: underline;
		text-underline-offset: 3px;
	}
	.table-scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font: 400 var(--fs-small) / var(--lh-small) var(--face-body);
	}
	th,
	td {
		padding: 10px 12px;
		border-bottom: 1px solid #ad9c81;
		text-align: left;
		min-width: 120px;
	}
	a:focus-visible {
		outline: 2px solid #8c2f2f;
		outline-offset: 3px;
	}
</style>
