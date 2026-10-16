<script lang="ts">
	import { onDestroy } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { csvTrace, type Trace } from './model.ts';
	let { id, label, onimport }: { id: string; label: string; onimport: (trace: Trace) => void } =
		$props();
	let text = $state('');
	let error = $state(false);
	let loading = $state(false);
	let sequence = 0;
	onDestroy(() => {
		sequence++;
	});
	function apply(source: string, name: string = m.soe_imported()) {
		try {
			onimport(csvTrace(source, name));
			error = false;
		} catch (cause) {
			console.warn('Soe como X CSV import rejected', cause);
			error = true;
		}
	}
	async function file(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const selected = input.files?.[0];
		if (!selected) return;
		const token = ++sequence;
		loading = true;
		try {
			if (selected.size > 5 * 1024 * 1024) throw new RangeError('csv:too-large');
			const contents = await selected.text();
			if (token === sequence) apply(contents, selected.name);
		} catch (cause) {
			console.warn('Soe como X file unavailable', cause);
			if (token === sequence) error = true;
		} finally {
			if (token === sequence) loading = false;
			input.value = '';
		}
	}
</script>

<div class="csv">
	<label for={`${id}-file`}>{label}</label>
	<input id={`${id}-file`} type="file" accept=".csv,.txt,text/plain,text/csv" onchange={file} />
	<details>
		<summary>{m.soe_paste()}</summary>
		<label for={`${id}-text`}>{label}</label>
		<textarea
			id={`${id}-text`}
			bind:value={text}
			rows="4"
			placeholder="frequency,raw&#10;20,0&#10;1000,0&#10;20000,0"></textarea>
		<button
			type="button"
			disabled={!text.trim() || loading}
			onclick={() => {
				sequence++;
				apply(text);
			}}>{m.soe_import()}</button
		>
	</details>
	{#if loading}
		<p role="status">{m.soe_loading()}</p>
	{/if}
	{#if error}
		<p role="alert">{m.soe_import_error()}</p>
	{/if}
</div>

<style>
	.csv {
		margin-top: 14px;
		padding: 12px 8px;
		border: 1px dashed #8a947b;
		background: #222a1d;
	}
	label {
		display: block;
		font-size: 11px;
		margin: 4px 0 7px;
		color: #e1e8d5;
	}
	input,
	textarea {
		width: 100%;
		min-width: 0;
		font-size: 11px;
		color: #e3e9d8;
	}
	input::file-selector-button,
	button {
		padding: 8px;
		color: #e3e9d8;
		background: #20281a;
		border: 1px solid #79826c;
		border-radius: 3px;
		cursor: pointer;
	}
	input::file-selector-button {
		max-width: 100%;
		margin-bottom: 6px;
	}
	textarea {
		box-sizing: border-box;
		padding: 8px;
		background: #101a16;
		border: 1px solid #79826c;
		resize: vertical;
	}
	summary {
		margin-top: 12px;
		cursor: pointer;
		font-size: 11px;
		color: #d4dec8;
	}
	button:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	input:focus-visible,
	textarea:focus-visible,
	button:focus-visible,
	summary:focus-visible {
		outline: 2px solid #ff99c4;
		outline-offset: 3px;
	}
	p {
		font-size: 11px;
		color: #d4dec8;
	}
	[role='alert'] {
		color: #ffc3c5;
	}
</style>
