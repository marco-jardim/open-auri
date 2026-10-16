<!-- Outcome lamp of a form: errors use role="alert", confirmations role="status". -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		tone?: 'error' | 'ok' | 'info';
		message: string;
		children?: Snippet;
	}

	let { tone = 'error', message, children }: Props = $props();
</script>

<div class="alert" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
	<span class="lamp" aria-hidden="true"></span>
	<div>
		<p>{message}</p>
		{#if children}{@render children()}{/if}
	</div>
</div>

<style>
	.alert {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		margin-top: 14px;
		padding: 10px 12px;
		border: 1px solid;
		border-radius: var(--rad-sm, 3px);
		font-size: 13px;
		line-height: 1.5;
	}

	.alert[data-tone='error'] {
		border-color: color-mix(in srgb, var(--lamp-bad, #ff6b5e) 60%, transparent);
		background: rgb(255 107 94 / 10%);
		color: #ffd1ca;
	}

	.alert[data-tone='ok'] {
		border-color: color-mix(in srgb, var(--lamp-ok, #3ddc97) 55%, transparent);
		background: rgb(61 220 151 / 9%);
		color: #d4f7e7;
	}

	.alert[data-tone='info'] {
		border-color: color-mix(in srgb, var(--accent) 55%, transparent);
		background: color-mix(in srgb, var(--accent) 9%, transparent);
		color: var(--strip-text, #e3e7ec);
	}

	.lamp {
		flex: none;
		width: 9px;
		height: 9px;
		margin-top: 5px;
		border-radius: 50%;
		background: currentColor;
		box-shadow: 0 0 6px currentColor;
	}

	p {
		margin: 0;
	}

	.alert :global(a) {
		color: inherit;
		font-weight: 600;
	}
</style>
