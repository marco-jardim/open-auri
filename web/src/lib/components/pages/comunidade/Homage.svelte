<!--
	Homage block: Bob Clearmountain (1953–). Text verified in the F4 brief (Power Station chief
	engineer, "credited with establishing the role of mixing engineer", Live Aid on 13 July 1985 at
	JFK Stadium, Philadelphia). Name only in text, no branding.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';

	const id = $props.id();
</script>

<aside class="homage" aria-labelledby="{id}-title">
	<span class="eyebrow">{m.comunidade_homage_eyebrow()}</span>
	<p class="honoree"><strong id="{id}-title">Bob Clearmountain</strong><span>1953–</span></p>
	<p>{m.meta_comunidade_curiosity()}</p>
	<ul class="sources">
		<li>
			<a href="https://en.wikipedia.org/wiki/Bob_Clearmountain" target="_blank" rel="noreferrer"
				>{m.comunidade_homage_source_bob()}</a
			>
		</li>
		<li>
			<a href="https://en.wikipedia.org/wiki/Live_Aid" target="_blank" rel="noreferrer"
				>{m.comunidade_homage_source_live_aid()}</a
			>
		</li>
	</ul>
</aside>

<style>
	.homage {
		margin-top: 26px;
		padding: 22px;
		border-radius: 12px;
		border: 1px solid #000;
		background:
			radial-gradient(80% 120% at 0 0, #ffb54714, transparent 60%),
			linear-gradient(180deg, #1d2433, #10131a);
		color: #d4cec2;
		font-size: 13px;
		line-height: 1.7;
	}
	.eyebrow {
		font: 550 10px var(--sans);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: #b9b4a8;
	}
	.honoree {
		display: flex;
		align-items: baseline;
		gap: 14px;
		margin: 9px 0 10px;
	}
	.honoree strong {
		color: var(--text);
		font: 400 30px/1.1 var(--serif);
	}
	.honoree span {
		font: 11px var(--mono);
	}
	p {
		max-width: 720px;
		margin: 0;
	}
	.sources {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 18px;
		margin: 10px 0 0;
		padding: 0;
		list-style: none;
	}
	a {
		color: var(--accent);
		text-underline-offset: 4px;
	}
</style>
