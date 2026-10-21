<script lang="ts">
	import type { DocSection } from '#lib/content/docs/types.ts';
	let {
		section,
		inApp,
		hydrated = false,
		part
	}: {
		section: DocSection;
		inApp: boolean;
		hydrated?: boolean;
		/** Paragraphs go inside the chapter's `.columns`; links in the chapter's links row. */
		part: 'paragraphs' | 'links';
	} = $props();
	const variants = $derived(
		[false, true].map((app) => {
			const extra = app ? section.appOnly : section.browserOnly;
			const paragraphs = part === 'paragraphs' ? (extra?.paragraphs ?? []) : [];
			const links = part === 'links' ? (extra?.links ?? []) : [];
			return {
				app,
				paragraphs,
				links,
				empty: paragraphs.length === 0 && links.length === 0,
				shown: hydrated && inApp === app
			};
		})
	);
	// Before hydration both variants size the slot, so revealing one cannot move the next section.
	// Once this environment's variant is known to be empty, the other one reserves nothing.
	const collapsed = $derived(
		variants.every((variant) => variant.empty) ||
			(hydrated && variants.some((variant) => variant.shown && variant.empty))
	);
</script>

<!-- Hidden sizing text is inert, never a link or a search entry. -->
{#if !collapsed}
	<div class="environment-extras" class:links={part === 'links'}>
		{#each variants as variant (variant.app)}
			{#if !variant.empty}
				<div
					class="variant"
					style:visibility={variant.shown ? 'visible' : 'hidden'}
					aria-hidden={!variant.shown}
					inert={!variant.shown}
				>
					{#each variant.paragraphs as paragraph (paragraph)}<p>{paragraph}</p>{/each}
					{#each variant.links as link (link.href)}
						{#if variant.shown}<a href={link.href}>{link.label} ↗</a>
						{:else}<span>{link.label} ↗</span>{/if}
					{/each}
				</div>
			{/if}
		{/each}
	</div>
{/if}

<style>
	/* The same metrics as DocsPage's `.columns p` and `.links`, which do not reach this component. */
	.environment-extras {
		display: grid;
	}
	.variant {
		grid-area: 1 / 1;
		min-width: 0;
	}
	p {
		margin: 0 0 13px;
	}
	.links {
		margin-top: 18px;
		font: 12px/1.5 var(--font-sans, sans-serif);
	}
	.links .variant {
		display: flex;
		flex-wrap: wrap;
		gap: 12px 24px;
	}
	a {
		color: inherit;
		text-underline-offset: 4px;
	}
	a:hover {
		color: #8c2f2f;
	}
</style>
