<!-- Submit button styled as an illuminated console switch. -->
<script lang="ts">
	interface Props {
		label: string;
		busyLabel?: string;
		busy?: boolean;
		disabled?: boolean;
		/** Name/value pair when a form has several submit buttons. */
		name?: string;
		value?: string;
		formaction?: string;
	}

	let {
		label,
		busyLabel,
		busy = false,
		disabled = false,
		name,
		value,
		formaction
	}: Props = $props();
</script>

<button
	type="submit"
	class="switch"
	{name}
	{value}
	{formaction}
	disabled={disabled || busy}
	aria-busy={busy ? 'true' : undefined}
>
	<span class="lamp" aria-hidden="true"></span>
	{busy && busyLabel ? busyLabel : label}
</button>

<style>
	.switch {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		width: 100%;
		min-height: 46px;
		margin-top: 18px;
		padding: 10px 16px;
		border: 1px solid color-mix(in srgb, var(--accent) 70%, black);
		border-radius: var(--rad-sm, 3px);
		background: linear-gradient(
			180deg,
			var(--accent),
			color-mix(in srgb, var(--accent) 82%, black)
		);
		box-shadow:
			0 1px 0 rgb(255 255 255 / 25%) inset,
			0 2px 0 rgb(0 0 0 / 45%);
		color: var(--accent-ink, #0f0f0e);
		font: 700 14px/1 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.18em;
		text-transform: uppercase;
		cursor: pointer;
	}

	.switch:active:not(:disabled) {
		transform: translateY(1px);
		box-shadow: 0 1px 0 rgb(0 0 0 / 45%);
	}

	.switch:focus-visible {
		outline: 2px solid var(--strip-text, #e3e7ec);
		outline-offset: 3px;
	}

	.lamp {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #0f0f0e;
		box-shadow: 0 0 0 1px rgb(0 0 0 / 40%);
	}

	.switch[aria-busy='true'] .lamp {
		background: #fff6d6;
	}

	@media (prefers-reduced-motion: reduce) {
		.switch:active:not(:disabled) {
			transform: none;
		}
	}
</style>
