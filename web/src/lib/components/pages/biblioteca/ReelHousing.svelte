<div class="deck" aria-hidden="true">
	<svg viewBox="0 0 220 220" focusable="false">
		<circle cx="110" cy="101" r="86" fill="#1b1b16" stroke="#a2a18d" stroke-width="3" />
		<circle cx="110" cy="101" r="70" fill="#584332" stroke="#6c5946" stroke-width="9" />
		{#each [0, 120, 240] as angle (angle)}
			<path
				d="M101 94 70 44Q105 23 136 44L118 94Z"
				fill="#c2c2ad"
				stroke="#494d40"
				stroke-width="3"
				transform="rotate({angle} 110 101)"
			/>
		{/each}
		<circle cx="110" cy="101" r="19" fill="#b2b29a" stroke="#33392f" stroke-width="4" />
		<circle cx="110" cy="101" r="6" fill="#242a22" />
		<path d="M35 155 75 188H154L185 155" stroke="#21180f" stroke-width="4" fill="none" />
		<rect x="86" y="175" width="49" height="21" rx="3" fill="#30372c" stroke="#9c9e84" />
	</svg>
	<span>ARCHIVE / 96 kHz</span>
</div>

<style>
	.deck {
		position: relative;
		width: 240px;
		height: 240px;
		border: 5px solid #262b24;
		background: linear-gradient(140deg, #9b9c8b, #606558 55%, #3a4136);
		box-shadow:
			inset 1px 2px 2px #e9e4c76b,
			7px 12px 22px #0009;
	}
	.deck:before,
	.deck:after {
		content: '';
		position: absolute;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: linear-gradient(135deg, #d9d8c0, #5a5e50);
		box-shadow: 0 1px 2px #000;
	}
	.deck:before {
		top: 8px;
		left: 8px;
	}
	.deck:after {
		bottom: 8px;
		right: 8px;
	}
	svg {
		width: 100%;
		height: 100%;
		filter: drop-shadow(2px 6px 4px #0009);
	}
	span {
		position: absolute;
		bottom: 6px;
		left: 0;
		right: 0;
		text-align: center;
		font:
			8px 'JetBrains Mono',
			monospace;
		color: #f1eed8;
	}
	@media (max-width: 1050px) {
		.deck {
			width: 195px;
			height: 205px;
		}
	}
	@media (max-width: 780px) {
		.deck {
			width: 96px;
			height: 102px;
			border-width: 3px;
		}
		span {
			font-size: 5px;
			bottom: 4px;
		}
	}
</style>
