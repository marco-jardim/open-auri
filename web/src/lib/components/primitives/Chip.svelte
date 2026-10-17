<!--
	Chip (spec §2.6): tones ok, warn, danger, neutral, accent. A meter-mode chip passes `mode`
	and always reads AO VIVO / DADOS / APAGADO (LIVE / DATA / OFF, plan §3.6); its text comes
	from the mode, never from the caller, so a meter cannot claim a state it is not in.
-->
<script module lang="ts">
	export type ChipTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'accent';
	export type MeterMode = 'live' | 'data' | 'off';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { m } from '#lib/paraglide/messages.js';

	interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
		tone?: ChipTone;
		/** Meter mode chip: text and tone follow the mode. */
		mode?: MeterMode;
		/** Leading dot (status chips). */
		dot?: boolean;
		children?: Snippet;
	}

	let { tone, mode, dot = false, class: className, children, ...rest }: Props = $props();

	const modeTone: Record<MeterMode, ChipTone> = { live: 'ok', data: 'accent', off: 'neutral' };
	const resolvedTone = $derived(mode ? modeTone[mode] : (tone ?? 'neutral'));
	const modeText = $derived(
		mode === 'live' ? m.fux1_mode_live() : mode === 'data' ? m.fux1_mode_data() : m.fux1_mode_off()
	);
</script>

<span
	{...rest}
	class={['chip', `chip--${resolvedTone}`, mode && 'chip--mode', className]}
	data-mode={mode}
>
	{#if dot || mode}<span class="chip__dot" aria-hidden="true"></span>{/if}
	{#if mode}{modeText}{:else if children}{@render children()}{/if}
</span>
