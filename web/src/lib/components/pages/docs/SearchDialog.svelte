<script lang="ts">
	import { searchModal } from './search-modal.ts';
	import type { DocsContent } from '#lib/content/docs/types.ts';
	import type { DocsUi } from './ui.ts';
	import { buildSearchIndex, searchSections } from './search.ts';
	let {
		content,
		ui,
		open = $bindable(false),
		returnFocus,
		onNavigate
	}: {
		content: DocsContent;
		ui: DocsUi;
		open?: boolean;
		returnFocus: () => HTMLElement | null;
		onNavigate: (id: string) => void;
	} = $props();
	let query = $state('');
	let selectingResult = $state(false);
	$effect(() => {
		if (open) selectingResult = false;
	});
	const id = $props.id();
	const index = $derived(buildSearchIndex(content));
	const results = $derived(searchSections(index, query));
	function navigate(section: string) {
		selectingResult = true;
		open = false;
		onNavigate(section);
	}
</script>

<dialog
	aria-labelledby="{id}-title"
	use:searchModal={{
		open,
		onDismiss: () => (open = false),
		initialFocus: 'input',
		returnFocus: () => (selectingResult ? null : returnFocus())
	}}
>
	<header>
		<h2 id="{id}-title">{ui.search}</h2>
		<button type="button" onclick={() => (open = false)}>{ui.close}</button>
	</header>
	<label for="{id}-query">{ui.searchInput}</label>
	<input
		id="{id}-query"
		type="search"
		bind:value={query}
		autocomplete="off"
		onkeydown={(event) => {
			// A non-empty search field consumes the first Escape to clear itself; close at once instead.
			if (event.key === 'Escape') {
				event.preventDefault();
				open = false;
			}
		}}
	/>
	<p class="hint">{ui.searchLocal}</p>
	<p role="status">{results.length} / {index.length}</p>
	<ul>
		{#each results as result (result.id)}
			<li>
				<a
					href="#{result.id}"
					onclick={(event) => {
						event.preventDefault();
						navigate(result.id);
					}}>{result.title}<small>{result.text.slice(0, 150)}…</small></a
				>
			</li>
		{:else}<li>{ui.noResults}</li>{/each}
	</ul>
</dialog>

<style>
	dialog {
		width: min(630px, calc(100vw - 32px));
		max-height: 80dvh;
		padding: 22px;
		background: #efe6d2;
		color: #29251f;
		border: 1px solid #29251f;
		font: 15px/1.5 var(--font-sans, sans-serif);
	}
	dialog::backdrop {
		background: #171715b8;
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 20px;
	}
	h2 {
		font:
			28px/1.2 'EB Garamond',
			Georgia,
			serif;
	}
	label {
		display: block;
		margin-top: 20px;
	}
	input {
		width: 100%;
		padding: 10px;
		margin: 8px 0;
		background: #fff5;
		border: 1px solid #6b5e4c;
		color: inherit;
	}
	button {
		border: 1px solid #6b5e4c;
		padding: 8px 12px;
		background: transparent;
		color: inherit;
	}
	ul {
		padding: 0;
		list-style: none;
	}
	li a {
		display: block;
		padding: 12px 4px;
		border-top: 1px solid #ad9c81;
		color: #8c2f2f;
	}
	small {
		display: block;
		color: #51452e;
		font-size: 12px;
	}
	.hint {
		font-size: 12px;
	}
	:focus-visible {
		outline: 2px solid #8c2f2f;
		outline-offset: 3px;
	}
</style>
