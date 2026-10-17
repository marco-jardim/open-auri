<!--
	Field (spec §2.6): label, optional hint, error with icon and aria-invalid, optional unit
	suffix. The control is the caller's (input, select, textarea): spread the snippet props on
	it so ids, aria-describedby, aria-invalid, required and the `.input` recipe line up.

	<Field label="Preamp" unit="dB" hint="−25,5 a −0,5" error={problem}>
		{#snippet children(control)}<input type="number" {...control} bind:value />{/snippet}
	</Field>
-->
<script module lang="ts">
	export interface FieldControl {
		id: string;
		class: string;
		'aria-describedby': string | undefined;
		'aria-invalid': 'true' | undefined;
		required: boolean | undefined;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		hint?: string;
		/** Validation message; non-empty marks the control invalid. */
		error?: string | null;
		required?: boolean;
		/** Unit suffix shown after the control (dB, Hz, %). */
		unit?: string;
		id?: string;
		class?: string;
		children: Snippet<[FieldControl]>;
	}

	const uid = $props.id();
	let {
		label,
		hint,
		error = null,
		required,
		unit,
		id = `${uid}-control`,
		class: className,
		children
	}: Props = $props();

	const hintId = $derived(`${id}-hint`);
	const errorId = $derived(`${id}-error`);
	const invalid = $derived(Boolean(error?.trim()));
	const control = $derived<FieldControl>({
		id,
		class: 'input',
		'aria-describedby':
			[hint ? hintId : null, invalid ? errorId : null].filter(Boolean).join(' ') || undefined,
		'aria-invalid': invalid ? 'true' : undefined,
		required
	});
</script>

<div class={['field', className]}>
	<!-- The unit is spoken with the label; the leading space is an expression because Svelte
	     trims whitespace at the start of an element. -->
	<label class="field__label" for={id}
		>{label}{#if unit}<span class="sr-only">{` (${unit})`}</span>{/if}</label
	>
	<div class="field__control">
		{@render children(control)}
		{#if unit}<span class="field__unit" aria-hidden="true">{unit}</span>{/if}
	</div>
	{#if hint}<p class="field__hint" id={hintId}>{hint}</p>{/if}
	{#if invalid}
		<p class="field__error" id={errorId}>
			<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
				<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5" />
				<path
					d="M8 4.2v4.6M8 10.9v.9"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
				/>
			</svg>
			<span>{error}</span>
		</p>
	{/if}
</div>
