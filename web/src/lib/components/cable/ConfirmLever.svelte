<!--
	A confirmation lever (FUX.P6, mock U3): a real native checkbox under a bat-handle toggle.
	The checkbox IS the confirmation (bound by the checklist to exactly one field of
	`Confirmations`); the lever art only shows its state. Its accessible name is the literal
	confirmation text. Motion: --ease-mech detent, none under reduced motion.
-->
<script lang="ts">
	interface Props {
		checked: boolean;
		/** Literal confirmation text (plan §3.4); also the checkbox's accessible name. */
		label: string;
		/** Which confirmation it is bound to (for styling hooks and tests). */
		confirmation: 'volume' | 'connection' | 'experimental' | 'yolo' | 'android-untested';
	}

	let { checked = $bindable(false), label, confirmation }: Props = $props();
</script>

<label class="lever-cell" data-confirmation={confirmation} data-on={checked}>
	<span class="guard">
		<input type="checkbox" class="lever-input" bind:checked />
		<span class="art" aria-hidden="true">
			<span class="pivot"></span>
			<span class="bat"></span>
		</span>
	</span>
	<span class="legend">{label}</span>
</label>

<style>
	.lever-cell {
		display: grid;
		justify-items: center;
		align-content: start;
		gap: 9px;
		min-width: 0;
		text-align: center;
		cursor: pointer;
	}
	.guard {
		position: relative;
		display: grid;
		place-items: center;
		width: 72px;
		height: 98px;
		border-radius: 8px;
		background: linear-gradient(180deg, #2a2d2f, #121314);
		box-shadow:
			inset 0 2px 5px #000,
			0 1px 0 #ffffffb0;
	}
	.lever-input {
		position: absolute;
		inset: 0;
		z-index: 1;
		width: 100%;
		height: 100%;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}
	.lever-input:disabled {
		cursor: not-allowed;
	}
	.art {
		position: relative;
		width: 34px;
		height: 58px;
		border-radius: 6px;
	}
	.lever-input:focus-visible + .art {
		outline: 2px solid var(--accent, #4fd1c5);
		outline-offset: 6px;
	}
	.pivot {
		position: absolute;
		left: 5px;
		top: 17px;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #fafbf9, #a3a7a3 50%, #555955);
		box-shadow:
			0 2px 3px #000a,
			inset 0 0 0 3px #00000022;
	}
	.bat {
		position: absolute;
		left: 13px;
		top: 29px;
		width: 8px;
		height: 26px;
		border-radius: 4px;
		background: linear-gradient(90deg, #7c807d, #f4f5f3 45%, #8b8f8c);
		box-shadow: 2px 2px 3px #0008;
		transform-origin: 4px 0;
		transition: transform var(--dur-base, 0.2s) var(--ease-mech, cubic-bezier(0.3, 1.4, 0.5, 1));
	}
	.bat::after {
		content: '';
		position: absolute;
		left: -2px;
		bottom: -4px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #fff, #9ea29f);
	}
	.lever-input:checked + .art .bat {
		transform: rotate(180deg);
	}
	.lever-input:disabled + .art {
		filter: saturate(0.4) brightness(0.8);
	}
	.legend {
		max-width: 150px;
		font: 600 var(--fs-caption, 12px) / 1.3 var(--cond, 'Barlow Condensed', sans-serif);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.lever-cell[data-on='true'] .legend {
		color: #0f3d3a;
	}
	@media (prefers-reduced-motion: reduce) {
		.bat {
			transition: none;
		}
	}
</style>
