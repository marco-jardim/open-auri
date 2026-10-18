<!--
	"NO AR / Publicar": publishes the current editor curve (S1 + validated S5 envelope) through
	`POST /api/v1/curves`. The server re-runs the gate: the ON AIR lamp lights ONLY after the server
	answered with the published lineage, never from a local check. A gate refusal lists the reasons
	with the same messages as the cable checklist. Sign-in and a verified e-mail are required; the
	page's single account card says so once, here the action only says why it is unavailable.

	Progressive disclosure (spec §4.1): the technical sheet (the S5 JSON the server validates) stays
	closed behind "Ver detalhes técnicos"; envelope problems that block publishing stay visible.
	Publication defaults to "Não listada"; the author can choose public or private visibility.
-->
<script lang="ts">
	import ResponseChart from '#lib/charts/ResponseChart.svelte';
	import { Explainer } from '#lib/components/comprehension/index.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { isSocialApiError, type PublishedInfo, type SocialApi } from '#lib/social/index.ts';
	import {
		S5_DESCRIPTION_MAX,
		S5_NAME_MAX,
		buildEnvelope,
		curveCodesOf,
		encodeCurve,
		envelopeIssueText,
		errorText,
		gateReasonText,
		gateReasonsOf,
		type DecodedCurve,
		type EnvelopeCheck,
		type Lang,
		type License,
		type SessionView,
		type Visibility
	} from './model.ts';

	let {
		api,
		session,
		editor,
		editorName = '',
		online,
		now = () => Date.now(),
		onpublished
	}: {
		api: SocialApi;
		session: SessionView;
		editor: DecodedCurve | null;
		editorName?: string;
		online: boolean;
		now?: () => number;
		onpublished?: (info: PublishedInfo, s1: string) => void;
	} = $props();

	const id = $props.id();
	let name = $state('');
	let description = $state('');
	let license = $state<License>('CC-BY-4.0');
	let visibility = $state<Visibility>('unlisted');
	let publishing = $state(false);
	let published = $state.raw<{ info: PublishedInfo; s1: string } | null>(null);
	let message = $state('');
	let reasons = $state.raw<string[]>([]);
	let codes = $state.raw<string[]>([]);
	let rejected = $state(false);
	let nameTouched = false;

	/** The input's setter: marks the name as the user's before the prefill effect can run. */
	function setName(value: string) {
		nameTouched = true;
		name = value;
	}

	$effect(() => {
		if (!nameTouched && name === '' && editorName)
			name = Array.from(editorName).slice(0, S5_NAME_MAX).join('');
	});

	const lang = $derived<Lang>(getLocale() === 'en-US' ? 'en-US' : 'pt-BR');
	const s1 = $derived(editor ? encodeCurve(editor) : null);
	const check = $derived.by<EnvelopeCheck | null>(() => {
		if (!s1) return null;
		if (Array.from(name).length > S5_NAME_MAX) return { ok: false, codes: ['env:length'] };
		return buildEnvelope({ name, description, license, lang, s1, now: now() });
	});
	/** Lit only for a server-approved publication of exactly the curve on screen. */
	const lit = $derived(published !== null && published.s1 === s1);
	/** Why "Publicar" cannot act right now; null when it can (T8). */
	const publishReason = $derived(
		!session.verified
			? session.signedIn
				? m.comunidade_verify_prompt()
				: m.comunidade_v2_reason_account()
			: !online
				? m.comunidade_offline()
				: !check
					? m.comunidade_v2_reason_no_curve()
					: null
	);

	async function publish() {
		if (!session.verified || publishing || !check) return;
		message = '';
		reasons = [];
		codes = [];
		rejected = false;
		if (!check.ok || !s1) {
			codes = check.ok ? [] : check.codes;
			message = m.comunidade_env_invalid();
			return;
		}
		publishing = true;
		const sentS1 = s1;
		try {
			const info = await api.publishCurve({ envelope: check.envelope, visibility });
			published = { info, s1: sentS1 };
			message = m.comunidade_onair_published();
			onpublished?.(info, sentS1);
		} catch (error) {
			published = null;
			if (isSocialApiError(error)) {
				if (error.code === 'GATE_REJECTED') {
					rejected = true;
					reasons = gateReasonsOf(error);
				} else if (error.code === 'INVALID_CURVE') {
					codes = curveCodesOf(error);
				}
			}
			message = errorText(error);
		} finally {
			publishing = false;
		}
	}
</script>

<section
	class="onair"
	id="publicar"
	tabindex="-1"
	aria-labelledby="{id}-title"
	data-tour="comunidade-publish"
>
	<div class="onair-head">
		<div class="tally-col">
			<div class="tally" class:lit data-testid="onair-lamp" data-lit={lit}>
				<div class="tally-glass">{m.comunidade_onair_lamp()}</div>
			</div>
			<p class="tally-cap" role="status">
				{lit ? m.comunidade_onair_lit() : m.comunidade_onair_off()}
			</p>
		</div>
		<div class="onair-copy">
			<p class="eyebrow">{m.comunidade_v2_publish_eyebrow()}</p>
			<h2 id="{id}-title" class="onair-title">{m.comunidade_onair_title()}</h2>
			<p class="onair-lede">{m.comunidade_onair_lede()}</p>
			<p class="gate-line">
				<span>{m.comunidade_v2_gate_line()}</span>
				<Explainer term="gate" />
			</p>
		</div>
	</div>
	<div class="onair-grid">
		<div class="producer">
			<label>
				<span class="fld-lbl">{m.comunidade_onair_name()}</span>
				<input
					class="tape-input"
					maxlength={S5_NAME_MAX * 2}
					autocomplete="off"
					bind:value={() => name, setName}
					disabled={!session.verified}
				/>
			</label>
			<label>
				<span class="fld-lbl">{m.comunidade_onair_description()}</span>
				<textarea
					maxlength={S5_DESCRIPTION_MAX}
					bind:value={description}
					disabled={!session.verified}></textarea>
			</label>
			<fieldset>
				<legend class="fld-lbl">{m.comunidade_onair_license()}</legend>
				<label class="radio"
					><input type="radio" value="CC0-1.0" bind:group={license} /> CC0 1.0</label
				>
				<label class="radio"
					><input type="radio" value="CC-BY-4.0" bind:group={license} /> CC-BY 4.0</label
				>
			</fieldset>
			<fieldset>
				<legend class="fld-lbl">{m.comunidade_onair_visibility()}</legend>
				<label class="radio"
					><input type="radio" value="public" bind:group={visibility} />
					{m.comunidade_visibility_public()}</label
				>
				<label class="radio"
					><input type="radio" value="unlisted" bind:group={visibility} />
					{m.comunidade_visibility_unlisted()}</label
				>
				<label class="radio"
					><input type="radio" value="private" bind:group={visibility} />
					{m.comunidade_visibility_private()}</label
				>
			</fieldset>
			<Button
				variant="primary"
				size="lg"
				class="publish"
				disabledReason={publishReason}
				onclick={publish}
				>{publishing ? m.comunidade_onair_sending() : m.comunidade_onair_publish()}</Button
			>
			{#if session.verified && check && !check.ok}
				<ul class="issues" data-testid="envelope-issues">
					{#each check.codes as code (code)}<li>{envelopeIssueText(code)}</li>{/each}
				</ul>
			{/if}
			{#if message}
				<div class="result" class:refusal={rejected || codes.length > 0} role="alert">
					<p>{message}</p>
					{#if reasons.length > 0}
						<ul data-testid="gate-reasons">
							{#each reasons as code (code)}<li>{gateReasonText(code)}</li>{/each}
						</ul>
					{/if}
					{#if codes.length > 0}
						<ul>
							{#each codes as code (code)}<li>{envelopeIssueText(code)}</li>{/each}
						</ul>
					{/if}
					{#if published && lit}
						<a href="/c/{encodeURIComponent(published.info.lineageId)}"
							>{m.comunidade_onair_open()}</a
						>
					{/if}
				</div>
			{/if}
		</div>
		<div class="outputs">
			<div class="out">
				<div class="out-head"><span>{m.comunidade_onair_source()}</span></div>
				{#if editor}
					<div class="chart">
						<ResponseChart
							curve={editor}
							label={m.comunidade_onair_chart_label()}
							description={m.comunidade_onair_chart_desc()}
							locale={getLocale()}
							theme="scope"
						/>
					</div>
				{:else}
					<p class="code-box note">{m.comunidade_audio_unavailable()}</p>
				{/if}
			</div>
			<div class="out">
				<div class="out-head">
					<span>{m.comunidade_onair_s1()}</span>
					<Explainer term="s1" />
				</div>
				<div class="code-box">
					{#if s1}<p class="code" data-testid="onair-s1">{s1}</p>
					{:else}<p class="note">{m.comunidade_onair_no_s1()}</p>{/if}
				</div>
			</div>
			{#if check?.ok}
				<div class="ficha">
					<div class="ficha-head">
						<span class="fld-lbl">{m.comunidade_v2_tech_sheet()}</span>
						<Explainer term="s5" />
					</div>
					<details class="disclosure tech" data-testid="ficha-tecnica">
						<summary>{m.comunidade_v2_tech_details()}</summary>
						<div class="out">
							<div class="out-head"><span>{m.comunidade_onair_s5()}</span></div>
							<pre data-testid="onair-s5">{check.json}</pre>
						</div>
					</details>
				</div>
			{/if}
		</div>
	</div>
</section>

<style>
	.onair {
		margin-top: var(--space-5);
		padding: var(--panel-pad);
		border: 1px solid #000;
		border-radius: var(--rad-xl);
		background:
			radial-gradient(70% 50% at 8% 0, #ff9b2e14, transparent 60%),
			linear-gradient(180deg, #2a2622, #1b1916);
		box-shadow:
			0 30px 60px #000c,
			inset 0 1px 0 #ffffff1c;
	}
	.onair-head {
		display: flex;
		gap: var(--space-5);
		align-items: center;
		margin-bottom: var(--space-4);
		flex-wrap: wrap;
	}
	.onair-copy {
		display: grid;
		gap: var(--space-2);
		flex: 1;
		min-width: 260px;
	}
	.eyebrow {
		color: var(--muted-hi);
	}
	.onair-title {
		font: italic 400 var(--fs-display-m) / var(--lh-display-m) var(--face-display);
		letter-spacing: var(--tracking-display-m);
	}
	.onair-lede {
		max-width: 76ch;
		color: var(--text-2);
		font-size: var(--fs-small);
		line-height: var(--lh-body);
	}
	.gate-line {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text-2);
		font-size: var(--fs-caption);
	}
	.tally {
		width: 190px;
		height: 72px;
		padding: 7px;
		border-radius: 7px;
		background: linear-gradient(#2b241d, #15110d);
		border: 1px solid #000;
		box-shadow:
			0 8px 18px #000b,
			inset 0 1px 0 #ffffff1a;
	}
	.tally-glass {
		display: grid;
		place-items: center;
		height: 100%;
		border-radius: var(--rad-md);
		/* Lens lettering in the body face (Geist is variable: no synthetic bold). */
		font: 600 var(--fs-readout-l) / 1 var(--face-body);
		letter-spacing: 0.24em;
		/* Unlit but legible (>= 4.5:1 on the dark glass). */
		color: #a8916f;
		background: linear-gradient(#2a2017, #1b140e);
		box-shadow: inset 0 2px 6px #000;
		transition:
			background var(--dur-slow) var(--ease-out),
			color var(--dur-slow) var(--ease-out),
			box-shadow var(--dur-slow) var(--ease-out);
	}
	/* Lights only with the server's approval (state, not decoration). */
	.tally.lit .tally-glass {
		color: #fff6e0;
		background: radial-gradient(circle at 50% 45%, #ffe3a6, #ff9b2e 62%, #c25d12);
		box-shadow:
			0 0 50px #ff9b2e99,
			inset 0 0 12px #fff6;
	}
	.tally-cap {
		max-width: 190px;
		margin: 6px 0 0;
		color: #cfc5b5;
		font: var(--fs-caption) / var(--lh-small) var(--face-body);
		text-align: center;
	}
	.onair-grid {
		display: grid;
		grid-template-columns: 340px 1fr;
		gap: var(--space-5);
		margin-top: var(--space-3);
	}
	.producer {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		padding: var(--space-4);
		background: linear-gradient(160deg, #34302b, #24211d);
		border: 1px solid #000;
		border-radius: var(--rad-md);
	}
	.producer label:not(.radio) {
		display: flex;
		flex-direction: column;
	}
	fieldset {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
		margin: 0;
		padding: var(--space-2) 10px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-md);
	}
	.radio {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 24px;
		font-size: var(--fs-small);
	}
	.radio input {
		accent-color: var(--accent);
	}
	.producer :global(.publish) {
		width: 100%;
	}
	.issues {
		margin: 0;
		padding-left: 18px;
		color: #ffb3b5;
		font-size: var(--fs-caption);
		line-height: var(--lh-small);
	}
	.result {
		padding: var(--space-2) 10px;
		border-left: 3px solid var(--accent);
		background: #3ddc9714;
		font-size: var(--fs-caption);
	}
	.result.refusal {
		border-left-color: var(--danger);
		background: #e5484d14;
		color: #ffb3b5;
	}
	.result p,
	.result ul {
		margin: 0;
	}
	.result ul {
		padding-left: 18px;
		margin-top: 6px;
	}
	.result a {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		margin-top: var(--space-1);
		color: var(--accent-text);
	}
	.outputs {
		display: grid;
		gap: var(--space-3);
		align-content: start;
	}
	.chart {
		padding: var(--space-2);
	}
	.code {
		margin: 0;
		color: #ffdca6;
		font: 500 var(--fs-readout) / var(--lh-body) var(--face-data);
		word-break: break-all;
	}
	.ficha {
		display: grid;
		gap: var(--space-1);
	}
	.ficha-head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
	.ficha-head .fld-lbl {
		margin: 0;
	}
	.tech .out {
		margin-top: var(--space-2);
	}
	@media (max-width: 1000px) {
		.onair-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
