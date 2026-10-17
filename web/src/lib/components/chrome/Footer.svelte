<script module lang="ts">
	export interface Honoree {
		name: string;
		years: string;
		curiosity: string;
		sources: readonly { label: string; href: string }[];
	}

	export const DEFAULT_GITHUB_URL = 'https://github.com/marco-jardim/open-auri';
</script>

<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';

	interface Props {
		honoree: Honoree;
		/** Repository URL; the layout passes PUBLIC_GITHUB_URL from the build env. */
		githubUrl?: string;
	}

	let { honoree, githubUrl = DEFAULT_GITHUB_URL }: Props = $props();
	const id = $props.id();
</script>

<footer class="site-footer">
	<section aria-labelledby="{id}-honoree">
		<div class="f-eyebrow">{m.chrome_homage()}</div>
		<div class="honoree">
			<h2 id="{id}-honoree">{honoree.name}</h2>
			<span>{honoree.years}</span>
		</div>
		<p>{honoree.curiosity}</p>
		<ul class="sources" aria-label={m.chrome_sources()}>
			{#each honoree.sources as source (source.href)}
				<li><a href={source.href} target="_blank" rel="noreferrer">{source.label} ↗</a></li>
			{/each}
		</ul>
	</section>
	<section aria-labelledby="{id}-notice">
		<h2 class="notice-title" id="{id}-notice">{m.chrome_notice_title()}</h2>
		<p>{m.chrome_notice()}</p>
		<div class="footer-links">
			<a href="/docs#aviso-legal">{m.chrome_legal_link()}</a>
			<a href={githubUrl}>{m.chrome_github_link()}</a>
			<span>{m.chrome_license()}</span>
		</div>
	</section>
</footer>

<style>
	.site-footer {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 90px;
		max-width: var(--frame-max);
		margin: var(--space-8) auto 0;
		padding: var(--space-6) var(--gutter) 36px;
		border-top: 1px solid var(--rule);
		background: var(--footer-bg);
		color: var(--state-text);
		font: 400 var(--fs-small) / var(--lh-body) var(--face-body);
	}

	/* Eyebrow: data face, caps, at the label minimum (no 10 px labels, T5) */
	.f-eyebrow {
		font: 500 var(--fs-eyebrow) / var(--lh-caps) var(--face-data);
		letter-spacing: var(--tracking-eyebrow);
		text-transform: uppercase;
	}

	.honoree {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 14px;
		margin: 9px 0 10px;
	}

	.honoree h2 {
		margin: 0;
		color: var(--text);
		font: 400 var(--fs-honoree) / 1 var(--face-display);
		letter-spacing: var(--tracking-title);
	}

	.honoree span {
		font: 400 var(--fs-caption) / 1 var(--face-data);
		font-variant-numeric: tabular-nums;
	}

	p {
		max-width: 600px;
		margin: 0;
	}

	.notice-title {
		margin: 0 0 9px;
		color: var(--text);
		font-size: var(--fs-ui);
		font-weight: 500;
	}

	.sources {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 18px;
		margin: 10px 0 0;
		padding: 0;
		list-style: none;
	}

	.footer-links {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		margin-top: 16px;
	}

	a {
		color: var(--text-2);
		text-underline-offset: 4px;
		text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
	}

	a:hover {
		color: var(--text);
		text-decoration-color: var(--accent);
	}

	a:focus-visible {
		outline: var(--focus-width) solid var(--accent);
		outline-offset: var(--focus-offset);
	}

	@media (max-width: 1100px) {
		.site-footer {
			grid-template-columns: 1fr;
			gap: 30px;
		}
	}
</style>
