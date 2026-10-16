<!--
	0 VU reference (−18, −20 or −14 dBFS) for every live VU meter. Native radios in a fieldset: the
	group is labelled by the legend, arrow keys move the choice and Tab enters/leaves the group.
	The store is passed by prop (no `$app/*` import), and the choice is applied through the module
	`setReference`, so existing and future taps follow it.
-->
<script lang="ts" module>
	import type { VuReference } from '#lib/audio/meters.ts';

	/** The part of `app.state.meterRef` this control needs. */
	export interface VuReferenceStore {
		readonly value: VuReference;
		set(next: VuReference): boolean;
	}
</script>

<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { VU_REFERENCES, setReference, isVuReference } from '#lib/audio/meters.ts';

	let { store }: { store: VuReferenceStore } = $props();

	const uid = $props.id();

	function label(reference: VuReference): string {
		return m.meters_vu_reference_option({ value: `−${Math.abs(reference)}` });
	}

	// Init, local changes and changes from other tabs: the module default follows the store.
	$effect(() => {
		setReference(store.value);
	});

	function choose(event: Event & { currentTarget: HTMLInputElement }): void {
		const next = Number(event.currentTarget.value);
		if (!isVuReference(next)) return;
		if (store.set(next)) setReference(next);
	}
</script>

<fieldset class="oa-vu-ref" aria-describedby={`${uid}-hint`}>
	<legend>{m.meters_vu_reference()}</legend>
	<div class="oa-vu-ref-options">
		{#each VU_REFERENCES as reference (reference)}
			<label>
				<input
					type="radio"
					name={`${uid}-ref`}
					value={String(reference)}
					checked={store.value === reference}
					onchange={choose}
				/>
				<span>{label(reference)}</span>
			</label>
		{/each}
	</div>
	<p id={`${uid}-hint`} class="oa-vu-ref-hint">{m.meters_vu_reference_hint()}</p>
</fieldset>

<style>
	.oa-vu-ref {
		margin: 12px 0 0;
		padding: 0;
		border: 0;
		min-width: 0;
		font-size: 11.5px;
		color: #cfc9be;
	}
	legend {
		padding: 0;
		margin-bottom: 6px;
	}
	.oa-vu-ref-options {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 24px;
		padding: 2px 8px 2px 4px;
		border: 1px solid var(--oa-rule, #34332f);
		border-radius: 3px;
		cursor: pointer;
		font-variant-numeric: tabular-nums;
	}
	label:has(input:checked) {
		border-color: var(--oa-accent, #ff7a2f);
		color: var(--oa-text, #f1ece2);
	}
	input {
		margin: 0;
		accent-color: var(--oa-accent, #ff7a2f);
	}
	input:focus-visible {
		outline: 2px solid var(--oa-accent, #ff7a2f);
		outline-offset: 2px;
	}
	.oa-vu-ref-hint {
		margin: 6px 0 0;
		font-size: 10.5px;
		color: var(--oa-muted, #9a958c);
	}
</style>
