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
		max-width: 1480px;
		margin: 80px auto 0;
		padding: 32px 24px 36px;
		border-top: 1px solid #353530;
		background: rgb(15 15 14 / 90%);
		color: #aaa499;
		font: 11.5px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
	}

	.f-eyebrow {
		font-size: 10px;
		font-weight: 550;
		letter-spacing: 0.14em;
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
		color: #ece7dd;
		font: 400 30px/1.1 var(--serif, 'Instrument Serif', Georgia, serif);
	}

	.honoree span {
		font: 11px var(--mono, 'JetBrains Mono', monospace);
	}

	p {
		max-width: 600px;
		margin: 0;
	}

	.notice-title {
		margin: 0 0 9px;
		color: #ece7dd;
		font-size: 12px;
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
		color: inherit;
		text-underline-offset: 4px;
	}

	a:focus-visible {
		outline: 2px solid var(--accent, #ff7a2f);
		outline-offset: 3px;
	}

	@media (max-width: 1100px) {
		.site-footer {
			grid-template-columns: 1fr;
			gap: 30px;
		}
	}
</style>
