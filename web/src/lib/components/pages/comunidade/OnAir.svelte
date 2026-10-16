<!--
	"NO AR / Publicar": publishes the current editor curve (S1 + validated S5 envelope) through
	`POST /api/v1/curves`. The server re-runs the gate: the ON AIR lamp lights ONLY after the server
	answered with the published lineage, never from a local check. A gate refusal lists the reasons
	with the same messages as the cable checklist. Sign-in and a verified e-mail are required.
-->
<script lang="ts">
	import { ResponseChart } from '#lib/charts/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { isSocialApiError, type PublishedInfo, type SocialApi } from '#lib/social/index.ts';
	import LoginPrompt from './LoginPrompt.svelte';
	import {
		DESCRIPTION_MAX,
		NAME_MAX,
		buildEnvelope,
		curveCodesOf,
		encodeCurve,
		envelopeIssueText,
		errorText,
		gateReasonText,
		gateReasonsOf,
		type DecodedCurve,
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
	let visibility = $state<Visibility>('public');
	let publishing = $state(false);
	let published = $state.raw<{ info: PublishedInfo; s1: string } | null>(null);
	let message = $state('');
	let reasons = $state.raw<string[]>([]);
	let codes = $state.raw<string[]>([]);
	let rejected = $state(false);
	let nameTouched = false;

	$effect(() => {
		if (!nameTouched && name === '' && editorName) name = editorName.slice(0, NAME_MAX);
	});

	const lang = $derived<Lang>(getLocale() === 'en-US' ? 'en-US' : 'pt-BR');
	const s1 = $derived(editor ? encodeCurve(editor) : null);
	const check = $derived(
		s1 ? buildEnvelope({ name, description, license, lang, s1, now: now() }) : null
	);
	/** Lit only for a server-approved publication of exactly the curve on screen. */
	const lit = $derived(published !== null && published.s1 === s1);

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

<section class="onair panel" id="publicar" aria-labelledby="{id}-title">
	<div class="onair-head">
		<div>
			<div class="tally" class:lit data-testid="onair-lamp" data-lit={lit}>
				<div class="tally-glass">{m.comunidade_onair_lamp()}</div>
			</div>
			<p class="tally-cap" role="status">
				{lit ? m.comunidade_onair_lit() : m.comunidade_onair_off()}
			</p>
		</div>
		<div>
			<h2 id="{id}-title">{m.comunidade_onair_title()}</h2>
			<p>{m.comunidade_onair_lede()}</p>
		</div>
	</div>
	{#if !session.verified}
		<LoginPrompt signedIn={session.signedIn} />
	{/if}
	<div class="onair-grid">
		<div class="producer">
			<label>
				<span class="fld-lbl">{m.comunidade_onair_name()}</span>
				<input
					class="tape-input"
					maxlength={NAME_MAX}
					autocomplete="off"
					bind:value={name}
					oninput={() => (nameTouched = true)}
					disabled={!session.verified}
				/>
			</label>
			<label>
				<span class="fld-lbl">{m.comunidade_onair_description()}</span>
				<textarea maxlength={DESCRIPTION_MAX} bind:value={description} disabled={!session.verified}
				></textarea>
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
			<button
				type="button"
				class="btn primary big"
				disabled={!session.verified || !online || publishing || !check}
				onclick={publish}
				>{publishing ? m.comunidade_onair_sending() : m.comunidade_onair_publish()}</button
			>
			{#if !online}<p class="note">{m.comunidade_offline()}</p>{/if}
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
					<p class="code-box">{m.comunidade_audio_unavailable()}</p>
				{/if}
			</div>
			<div class="out">
				<div class="out-head"><span>{m.comunidade_onair_s1()}</span></div>
				<div class="code-box">
					{#if s1}<p class="code" data-testid="onair-s1">{s1}</p>
					{:else}<p class="note">{m.comunidade_onair_no_s1()}</p>{/if}
				</div>
			</div>
			<div class="out">
				<div class="out-head"><span>{m.comunidade_onair_s5()}</span></div>
				{#if check?.ok}
					<pre data-testid="onair-s5">{check.json}</pre>
				{:else if check}
					<ul class="code-box issues">
						{#each check.codes as code (code)}<li>{envelopeIssueText(code)}</li>{/each}
					</ul>
				{/if}
			</div>
		</div>
	</div>
</section>

<style>
	.onair {
		background: linear-gradient(180deg, #2a2622, #1b1916);
	}
	.onair-head {
		display: flex;
		gap: 22px;
		align-items: center;
		margin-bottom: 18px;
		flex-wrap: wrap;
	}
	.onair-head h2 {
		font: italic 40px/1 var(--serif);
		margin: 0;
	}
	.onair-head p {
		color: #cfc9bd;
		font-size: 13px;
		line-height: 1.7;
		max-width: 760px;
		margin: 6px 0 0;
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
		border-radius: 4px;
		font: 700 25px var(--sans);
		letter-spacing: 0.24em;
		color: #4a3826;
		background: linear-gradient(#2a2017, #1b140e);
		box-shadow: inset 0 2px 6px #000;
	}
	.tally.lit .tally-glass {
		color: #fff6e0;
		background: radial-gradient(circle at 50% 45%, #ffe3a6, #ff9b2e 62%, #c25d12);
		box-shadow:
			0 0 50px #ff9b2e99,
			inset 0 0 12px #fff6;
	}
	.tally-cap {
		font: 11px var(--mono);
		color: #cfc5b5;
		margin: 6px 0 0;
		text-align: center;
		max-width: 190px;
	}
	.onair-grid {
		display: grid;
		grid-template-columns: 330px 1fr;
		gap: 20px;
		margin-top: 14px;
	}
	.producer {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 14px;
		background: linear-gradient(160deg, #34302b, #24211d);
		border: 1px solid #000;
		border-radius: 4px;
	}
	.producer label:not(.radio) {
		display: flex;
		flex-direction: column;
	}
	fieldset {
		border: 1px solid #ffffff1c;
		border-radius: 4px;
		padding: 8px 10px;
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
	}
	.radio {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
	}
	.radio input {
		accent-color: var(--accent);
	}
	.big {
		min-height: 40px;
	}
	.result {
		padding: 8px 10px;
		border-left: 3px solid var(--accent);
		background: #3ddc9714;
		font-size: 12px;
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
		color: var(--accent);
	}
	.outputs {
		display: grid;
		gap: 12px;
		align-content: start;
	}
	.chart {
		padding: 8px;
	}
	.code {
		font: 500 14px/1.6 var(--mono);
		color: #ffdca6;
		word-break: break-all;
		margin: 0;
	}
	.issues {
		margin: 0;
		padding-left: 28px;
		color: #ffb3b5;
		font-size: 12px;
	}
	@media (max-width: 1000px) {
		.onair-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
