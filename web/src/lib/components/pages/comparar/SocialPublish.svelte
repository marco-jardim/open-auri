<script lang="ts">
	import { decodeS1, encodeS1, validateEnvelope } from 'open-auri/share';
	import { isSocialApiError, rememberOrigin, requireLoginHref } from '#lib/social/index.ts';
	import { m } from '#lib/paraglide/messages.js';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import type { CurveData } from '#lib/state/model.ts';
	import type { CurveSocial } from './social.svelte.ts';
	import { copy, reasonText } from './copy.ts';

	type Envelope = Extract<ReturnType<typeof validateEnvelope>, { ok: true }>['value'];
	let {
		social,
		curve,
		recipe,
		path
	}: {
		social: CurveSocial;
		curve: CurveData;
		recipe?: Envelope['recipe'];
		path: string;
	} = $props();
	let dialog = $state<HTMLDialogElement>();
	/** Reactive mirror of `dialog.open`: each message renders in exactly one place. */
	let opened = $state(false);
	let snapshot: {
		code: string;
		curve: ReturnType<typeof decodeS1>;
		recipe?: Envelope['recipe'];
	} | null = null;
	let name = $state('');
	let description = $state('');
	let license = $state<'CC0-1.0' | 'CC-BY-4.0'>('CC0-1.0');
	let visibility = $state<'private' | 'unlisted' | 'public'>('private');
	let busy = $state(false);
	let message = $state('');
	let reasons = $state<string[]>([]);

	function open(publish: boolean) {
		if (!dialog || social.unavailable || !social.session.verified) return;
		try {
			const code = encodeS1(curve);
			snapshot = {
				code,
				curve: decodeS1(code),
				...(recipe ? { recipe: structuredClone(recipe) } : {})
			};
			name = curve.name;
			description = '';
			visibility = publish ? 'unlisted' : 'private';
			message = '';
			reasons = [];
			dialog.showModal();
			opened = true;
		} catch (cause) {
			message = social.failure(cause);
		}
	}
	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!snapshot || busy || social.unavailable || !social.session.verified) return;
		const input = validateEnvelope({
			format: 'open-auri/preset@1',
			name,
			description,
			source: 'custom',
			license,
			code: snapshot.code,
			bands: snapshot.curve.bands,
			preampDb: snapshot.curve.preampDb,
			lang: getLocale(),
			createdAt: new Date().toISOString(),
			...(snapshot.recipe ? { recipe: snapshot.recipe } : {})
		});
		reasons = [];
		if (!input.ok) {
			message = m.curve_social_invalid();
			return;
		}
		// The visibility actually sent; the success message must describe it, not a later edit.
		const sent = visibility;
		busy = true;
		message = '';
		try {
			const result = await social.api.publishCurve({ envelope: input.value, visibility: sent });
			await rememberOrigin({
				s1: input.value.code,
				lineageId: result.lineageId,
				versionId: result.versionId
			});
			message = sent === 'private' ? m.curve_social_saved() : m.curve_social_published();
			close();
		} catch (cause) {
			if (isSocialApiError(cause) && cause.code === 'GATE_REJECTED') {
				message = m.curve_social_gate();
				const details = cause.details;
				if (
					details &&
					!Array.isArray(details) &&
					typeof details === 'object' &&
					Array.isArray(details.reasons)
				) {
					reasons = details.reasons.filter(
						(reason): reason is string => typeof reason === 'string'
					);
				}
			} else if (isSocialApiError(cause) && cause.code === 'INVALID_CURVE') {
				message = m.curve_social_invalid();
			} else message = social.failure(cause);
		} finally {
			busy = false;
		}
	}
	function close() {
		dialog?.close();
		opened = false;
	}
</script>

<div class="social-publish">
	{#if !social.session.signedIn}<a href={requireLoginHref(path)}>{m.curve_social_login()}</a>
	{:else if !social.session.verified}<p>{m.curve_social_verify()}</p>
	{:else}
		<button type="button" disabled={busy || social.unavailable} onclick={() => open(false)}
			>{m.curve_social_save()}</button
		>
		<button type="button" disabled={busy || social.unavailable} onclick={() => open(true)}
			>{m.curve_social_publish()}</button
		>
	{/if}
	{#if social.unavailable}<p role="status">{m.curve_social_offline()}</p>
		<button type="button" onclick={() => social.retry()}>{m.curve_social_retry()}</button>
	{:else if message && !opened}<p role="status">{message}</p>{/if}
</div>
<dialog
	bind:this={dialog}
	aria-label={m.curve_social_dialog()}
	oncancel={(event) => {
		if (busy) event.preventDefault();
	}}
	onclose={() => {
		opened = false;
	}}
>
	<form onsubmit={submit}>
		<h3>{m.curve_social_dialog()}</h3>
		<fieldset class="fields" disabled={busy}>
			<label>{m.curve_social_name()}<input required maxlength="48" bind:value={name} /></label>
			<label
				>{m.curve_social_description()}<textarea maxlength="280" bind:value={description}
				></textarea></label
			>
			<label
				>{m.curve_social_license()}<select bind:value={license}
					><option>CC0-1.0</option><option>CC-BY-4.0</option></select
				></label
			>
			<label
				>{m.curve_social_visibility()}<select bind:value={visibility}>
					<option value="private">{m.curve_social_private()}</option>
					<option value="unlisted">{m.curve_social_unlisted()}</option>
					<option value="public">{m.curve_social_public()}</option>
				</select></label
			>
		</fieldset>
		<p>{m.comparar_gate_note()}</p>
		{#if message && opened}<p role="status">{message}</p>{/if}
		{#if social.unavailable}<button type="button" onclick={() => social.retry()}
				>{m.curve_social_retry()}</button
			>{/if}
		{#if reasons.length}<ul>
				{#each reasons as reason, index (index)}<li>
						{reasonText(reason, copy(getLocale()))}
					</li>{/each}
			</ul>{/if}
		<button type="submit" disabled={busy || social.unavailable}
			>{busy ? m.curve_social_loading() : m.curve_social_submit()}</button
		>
		<button type="button" disabled={busy} onclick={close}>{m.curve_social_cancel()}</button>
	</form>
</dialog>

<style>
	.social-publish {
		display: grid;
		gap: 0.6rem;
		margin-block: 1rem;
	}
	dialog {
		max-width: min(32rem, 90vw);
		color: #ece7dd;
		background: #242b22;
		border: 1px solid #859175;
	}
	dialog::backdrop {
		background: #0009;
	}
	.fields {
		display: grid;
		gap: 1rem;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	form,
	label {
		display: grid;
		gap: 0.5rem;
	}
	form {
		gap: 1rem;
	}
	input,
	textarea,
	select,
	button {
		min-width: 0;
		padding: 0.5rem;
		color: inherit;
		background: #182019;
		border: 1px solid #859175;
	}
	a {
		color: inherit;
	}
	:focus-visible {
		outline: 2px solid #f2b33d;
		outline-offset: 3px;
	}
</style>
