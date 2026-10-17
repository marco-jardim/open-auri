<!--
	Themed import area (spec §1.4b): the native file input stays in the page, focusable and
	labelled, but visually hidden; the styled label is the drop zone. "Colar texto" opens the
	paste panel. Nothing here touches the cable: the trace only feeds the solver.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { Button } from '#lib/components/primitives/index.ts';
	import { csvTrace, type Trace } from './model.ts';
	let { id, label, onimport }: { id: string; label: string; onimport: (trace: Trace) => void } =
		$props();
	let text = $state('');
	let error = $state(false);
	let loading = $state(false);
	let over = $state(false);
	let pasteOpen = $state(false);
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
	async function read(selected: File | undefined) {
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
		}
	}
	async function file(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		await read(input.files?.[0]);
		input.value = '';
	}
	function drop(event: DragEvent) {
		event.preventDefault();
		over = false;
		void read(event.dataTransfer?.files?.[0]);
	}
</script>

<div class="csv" aria-busy={loading ? 'true' : undefined}>
	<input
		class="visually-hidden"
		id={`${id}-file`}
		type="file"
		accept=".csv,.txt,text/plain,text/csv"
		onchange={file}
	/>
	<label
		class="zone"
		class:over
		for={`${id}-file`}
		ondragover={(event) => {
			event.preventDefault();
			over = true;
		}}
		ondragleave={() => (over = false)}
		ondrop={drop}
	>
		<svg class="glyph" viewBox="0 0 40 24" aria-hidden="true">
			<path d="M2 14 L8 14 L11 6 L15 20 L19 9 L23 16 L27 12 L31 14 L38 14" />
		</svg>
		<span class="zone-title">{label}</span>
		<span class="zone-hint">{m.soe_fux_drop()}</span>
		<span class="zone-formats">{m.soe_fux_formats()}</span>
	</label>
	<div class="actions">
		<Button
			size="sm"
			variant="ghost"
			aria-expanded={pasteOpen}
			aria-controls={pasteOpen ? `${id}-paste` : undefined}
			onclick={() => (pasteOpen = !pasteOpen)}>{m.soe_fux_paste()}</Button
		>
	</div>
	{#if pasteOpen}
		<div class="paste" id={`${id}-paste`}>
			<p class="hint">{m.soe_paste()}</p>
			<label class="field-label" for={`${id}-text`}>{label}</label>
			<textarea
				id={`${id}-text`}
				bind:value={text}
				rows="4"
				placeholder="frequency,raw&#10;20,0&#10;1000,0&#10;20000,0"></textarea>
			<Button
				size="sm"
				disabledReason={!text.trim() ? m.soe_paste() : null}
				{loading}
				onclick={() => {
					sequence++;
					apply(text);
				}}>{m.soe_import()}</Button
			>
		</div>
	{/if}
	{#if loading}
		<p role="status">{m.soe_loading()}</p>
	{/if}
	{#if error}
		<p role="alert">{m.soe_import_error()}</p>
	{/if}
</div>

<style>
	.csv {
		margin-top: var(--space-4, 16px);
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}
	.zone {
		display: grid;
		justify-items: center;
		gap: var(--space-1, 4px);
		padding: var(--space-4, 16px) var(--space-3, 12px);
		border: 1px dashed var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-md, 6px);
		background: var(--well, #11150f);
		color: var(--text, #ece7dd);
		text-align: center;
		cursor: pointer;
		transition:
			border-color var(--dur-fast, 0.12s) var(--ease-out, ease-out),
			background-color var(--dur-fast, 0.12s) var(--ease-out, ease-out);
	}
	.zone:hover,
	.zone.over {
		border-color: var(--accent-hi, #ff78af);
		border-style: solid;
	}
	.visually-hidden:focus-visible + .zone {
		outline: 2px solid var(--accent, #ff3d8b);
		outline-offset: 3px;
	}
	.glyph {
		width: 40px;
		height: 24px;
		fill: none;
		stroke: var(--accent-hi, #ff78af);
		stroke-width: 1.5;
		stroke-linejoin: round;
	}
	.zone-title {
		font: 500 var(--fs-ui, 14px) / 1.3 var(--face-body, 'Geist', system-ui, sans-serif);
		overflow-wrap: anywhere;
	}
	.zone-hint,
	.zone-formats {
		font: var(--fs-caption, 12px) / 1.4 var(--face-body, 'Geist', system-ui, sans-serif);
		color: var(--muted-hi, #a39d92);
	}
	.zone-formats {
		font-family: var(--face-data, 'JetBrains Mono', monospace);
		font-size: var(--label-min, 11px);
	}
	.actions {
		display: flex;
		justify-content: center;
		margin-top: var(--space-2, 8px);
	}
	.paste {
		display: grid;
		gap: var(--space-2, 8px);
		margin-top: var(--space-2, 8px);
	}
	.field-label {
		font: var(--fs-caption, 12px) / 1.4 var(--face-body, 'Geist', system-ui, sans-serif);
		color: var(--text-2, #cfc9be);
	}
	textarea {
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		padding: var(--space-2, 8px);
		background: var(--well, #11150f);
		color: var(--text, #ece7dd);
		border: 1px solid var(--rule-control, rgba(236, 231, 221, 0.4));
		border-radius: var(--rad-sm, 4px);
		font: var(--fs-caption, 12px) / 1.5 var(--face-data, 'JetBrains Mono', monospace);
		resize: vertical;
	}
	textarea:focus-visible {
		outline: 2px solid var(--accent, #ff3d8b);
		outline-offset: 3px;
	}
	p {
		margin: var(--space-2, 8px) 0 0;
		font: var(--fs-caption, 12px) / 1.5 var(--face-body, 'Geist', system-ui, sans-serif);
		color: var(--text-2, #cfc9be);
	}
	.hint {
		margin: 0;
	}
	[role='alert'] {
		color: #ffc3c5;
	}
	@media (prefers-reduced-motion: reduce) {
		.zone {
			transition: none;
		}
	}
</style>
