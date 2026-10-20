<script lang="ts">
	import type { DocSection } from '#lib/content/docs/types.ts';
	let { section, inApp, hydrated = false }: {
		section: DocSection;
		inApp: boolean;
		hydrated?: boolean;
	} = $props();
</script>

<!-- Both variants size the same grid slot, including before hydration. Hidden sizing text is
	 inert, never a link or a search entry. Revealing browser prose cannot move the next section. -->
<div class="environment-extras">
	{#each [false, true] as app (app)}
		{@const extra = app ? section.appOnly : section.browserOnly}
		{@const shown = hydrated && inApp === app}
		<div class="variant" style:visibility={shown ? 'visible' : 'hidden'} aria-hidden={!shown} inert={!shown}>
			{#each extra?.paragraphs ?? [] as paragraph (paragraph)}<p>{paragraph}</p>{/each}
			{#if extra?.links?.length}
				<div class="links">
					{#each extra.links as link (link.href)}
						{#if shown}<a href={link.href}>{link.label} ↗</a>
						{:else}<span>{link.label} ↗</span>{/if}
					{/each}
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.environment-extras { display: grid; }
	.variant { grid-area: 1 / 1; min-width: 0; }
	p { margin: 0 0 1em; }
	.links { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 18px; }
	a { color: inherit; text-underline-offset: 4px; }
</style>
