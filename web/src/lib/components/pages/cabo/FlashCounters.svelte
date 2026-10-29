<script lang="ts">
	import { DAILY_NOTICE_THRESHOLD } from 'open-auri/policy';
	import { m } from '#lib/paraglide/messages.js';
	import { counterDigits } from './model.ts';

	let {
		counters,
		previews = 0
	}: {
		counters: { session: number; day: number; total: number };
		/** Live previews this page applied (no flash write; `livePreviewCount`). */
		previews?: number;
	} = $props();
	const counts = $derived({
		session: counters.session,
		day: counters.day,
		total: counters.total
	});
	const keys = ['session', 'day', 'total'] as const;
	const labels = {
		session: () => m.cabo_session(),
		day: () => m.cabo_day(),
		total: () => m.cabo_total()
	};
</script>

<dl class="counters">
	{#each keys as kind (kind)}
		<div class="counter">
			<dt>{labels[kind]()}</dt>
			<dd>
				<span class="drums" role="img" aria-label={String(counts[kind])}>
					{#each counterDigits(counts[kind]) as digit, index (index)}<b aria-hidden="true"
							>{digit}</b
						>{/each}
				</span>
			</dd>
		</div>
	{/each}
</dl>
<p>{m.cabo_counter_note()}</p>
<p>{m.cabo_spacing()}</p>
<!-- Live previews never reach the cable's memory: their own counter, outside the flash ones. -->
<dl class="previews" data-testid="cabo-live-previews">
	<div class="counter">
		<dt>{m.cabo_live_previews()}</dt>
		<dd>
			<span class="live-drums" role="img" aria-label={String(previews)}>
				{#each counterDigits(previews) as digit, index (index)}<b aria-hidden="true">{digit}</b
					>{/each}
			</span>
		</dd>
	</div>
</dl>
<p>{m.cabo_live_previews_scope()}</p>
<p>{m.cabo_live_previews_note()}</p>
<div class="plate"><p>{m.cabo_flash_notice()}</p></div>
{#if counters.day >= DAILY_NOTICE_THRESHOLD}<p role="status" class="notice">
		{m.cabo_daily_notice()}
	</p>{/if}

<style>
	.counters,
	.previews {
		display: flex;
		flex-wrap: wrap;
		gap: 24px 32px;
		margin: 0 0 18px;
	}
	.previews {
		margin: 18px 0 0;
	}
	.counter {
		display: flex;
		flex-direction: column-reverse;
		align-items: center;
		gap: 9px;
		max-width: 100%;
	}
	dt {
		font:
			600 12px 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}
	dd {
		max-width: 100%;
		margin: 0;
	}
	.drums,
	.live-drums {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		padding: 6px;
		background: #0b0c0c;
		border-radius: 4px;
		box-shadow:
			inset 0 2px 5px #000,
			0 1px #ffffffaa;
	}
	b {
		width: 26px;
		height: 38px;
		border-radius: 2px;
		color: #f2f2ec;
		background: linear-gradient(#0009, transparent 30%, transparent 70%, #0009), #1b1d1e;
		font: 600 25px/38px var(--mono, monospace);
		text-align: center;
	}
	b:last-child {
		color: #1b1d1e;
		background-color: #e9e6dc;
	}
	p {
		font-size: 12.5px;
		line-height: 1.55;
	}
	.plate {
		margin-top: 16px;
		padding: 4px 12px;
		border-radius: 3px;
		color: #e8ece7;
		background: linear-gradient(#1f2122, #111213);
	}
	.notice {
		font-weight: 600;
	}
</style>
