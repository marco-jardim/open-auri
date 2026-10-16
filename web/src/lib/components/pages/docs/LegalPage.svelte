<script lang="ts">
	import {
		resolveLegalDocument,
		type LegalDocument,
		type PublicLegalValues
	} from '#lib/content/docs/legal.ts';
	import type { DocsUi } from './ui.ts';
	import InlineText from './InlineText.svelte';
	import { keyboardScroll } from './keyboard-scroll.ts';
	let {
		document: template,
		values,
		ui
	}: { document: LegalDocument; values: PublicLegalValues; ui: DocsUi } = $props();
	const document = $derived(resolveLegalDocument(template, values));
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
		{#if block.kind === 'heading'}<h2><InlineText text={block.text} /></h2>
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
	.legal-paper {
		box-sizing: border-box;
		max-width: 100%;
		background: #efe6d2;
		color: #29251f;
		padding: 30px max(24px, calc((100% - 860px) / 2)) 60px;
		font:
			19px/1.6 'EB Garamond',
			Georgia,
			serif;
		overflow-wrap: anywhere;
	}
	nav {
		display: flex;
		flex-wrap: wrap;
		gap: 12px 24px;
		font: 12px/1.6 var(--font-sans, sans-serif);
	}
	header {
		text-align: center;
		padding: 30px 0;
		border-bottom: 3px double #29251f;
		margin-bottom: 30px;
	}
	header p {
		font: 11px/1.7 var(--font-mono, monospace);
	}
	h1 {
		font:
			400 clamp(36px, 5vw, 56px)/1.1 'EB Garamond',
			Georgia,
			serif;
		margin: 20px 0;
	}
	h2 {
		font-size: 27px;
		font-weight: 400;
		margin: 36px 0 16px;
		border-top: 1px solid #ad9c81;
		padding-top: 20px;
	}
	p,
	li {
		margin-bottom: 14px;
	}
	a {
		color: #8c2f2f;
		text-underline-offset: 3px;
	}
	.table-scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font: 13px/1.65 var(--font-sans, sans-serif);
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
