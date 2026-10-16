<!--
	Password-strength meter drawn as a channel LED ladder. Real data only: the lamps show the
	local estimate of the typed password (password-strength.ts); with nothing typed they are dark.
	Advisory: it never blocks a submission beyond the length rule the server enforces.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import { estimateStrength, PASSWORD_MIN } from './password-strength.ts';
	import { strengthHint, strengthLabel } from './messages.ts';

	interface Props {
		/** Id of the meter's text (the password input points at it with aria-describedby). */
		id: string;
		password: string;
		/** Personal data the password should not contain (e.g. the e-mail). */
		context?: readonly string[];
	}

	let { id, password, context = [] }: Props = $props();
	const estimate = $derived(estimateStrength(password, context));
	const empty = $derived(password.length === 0);
	const lit = $derived(empty ? 0 : estimate.tooShort ? 1 : estimate.level + 1);
	const tone = $derived(lit <= 2 ? 'bad' : lit === 3 ? 'warn' : 'ok');
	const text = $derived(
		empty
			? m.auth_strength_empty({ min: PASSWORD_MIN })
			: estimate.tooShort
				? m.auth_strength_short({ min: PASSWORD_MIN })
				: strengthLabel(estimate.level)
	);
</script>

<div class="strength" data-level={empty ? 'empty' : estimate.level}>
	<div
		class="ladder"
		role="meter"
		aria-labelledby="{id}-label"
		aria-valuemin={0}
		aria-valuemax={4}
		aria-valuenow={empty || estimate.tooShort ? 0 : estimate.level}
		aria-valuetext={text}
	>
		{#each [1, 2, 3, 4, 5] as segment (segment)}
			<span class="led" class:on={segment <= lit} data-tone={tone}></span>
		{/each}
	</div>
	<p class="readout" {id}>
		<span id="{id}-label">{m.auth_strength_label()}</span>:
		<strong aria-live="polite">{text}</strong>
	</p>
	{#if !empty && estimate.hints.length > 0}
		<ul class="hints">
			{#each estimate.hints as hint (hint)}
				<li>{strengthHint(hint)}</li>
			{/each}
		</ul>
	{/if}
	<p class="note">{m.auth_strength_note()}</p>
</div>

<style>
	.strength {
		margin-top: 10px;
	}

	.ladder {
		display: grid;
		grid-template-columns: repeat(5, 1fr);
		gap: 4px;
		padding: 5px;
		border-radius: var(--rad-sm, 3px);
		background: #090b0e;
		box-shadow: inset 0 1px 3px rgb(0 0 0 / 70%);
	}

	.led {
		height: 8px;
		border-radius: 1px;
		background: #262c34;
	}

	.led.on[data-tone='bad'] {
		background: var(--lamp-bad, #ff6b5e);
	}

	.led.on[data-tone='warn'] {
		background: var(--lamp-warn, #f2b33d);
	}

	.led.on[data-tone='ok'] {
		background: var(--lamp-ok, #3ddc97);
	}

	.readout {
		margin: 6px 0 0;
		font-size: 12.5px;
		color: var(--strip-muted, #a9b2bd);
	}

	strong {
		color: var(--strip-text, #e3e7ec);
		font-weight: 600;
	}

	.hints {
		margin: 4px 0 0;
		padding-left: 18px;
		font-size: 12px;
		color: var(--strip-muted, #a9b2bd);
	}

	.note {
		margin: 4px 0 0;
		font-size: 11px;
		color: var(--strip-muted, #a9b2bd);
	}
</style>
