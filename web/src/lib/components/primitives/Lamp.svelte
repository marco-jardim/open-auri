<!--
	Lamp (spec §2.6): on/off, always bound to real state (a gate result, a confirmation, the
	cable link), never decorative blinking. With `label` it is announced as "<label>: on/off";
	without it, it is decorative and hidden (the caller's text carries the meaning).
-->
<script module lang="ts">
	export type LampTone = 'accent' | 'ok' | 'warn' | 'danger';
</script>

<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { m } from '#lib/paraglide/messages.js';

	interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
		on: boolean;
		tone?: LampTone;
		label?: string;
	}

	let { on, tone = 'accent', label, class: className, ...rest }: Props = $props();
	const spoken = $derived(label ? `${label}: ${on ? m.fux1_lamp_on() : m.fux1_lamp_off()}` : null);
</script>

<span
	{...rest}
	class={['lamp', tone !== 'accent' && `lamp--${tone}`, className]}
	data-on={on}
	role={spoken ? 'img' : undefined}
	aria-label={spoken ?? undefined}
	aria-hidden={spoken ? undefined : 'true'}
></span>
