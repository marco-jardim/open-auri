<script lang="ts">
	// T4.16: the only social element of the Cabo. When signed in and the last REAL successful write
	// (journal status `ok`; simulated and interrupted entries never count) is the exact bytes of a
	// published community curve, it shows "instalada". Display only: no write, no gating, no request.
	import { encodeS1 } from 'open-auri/share';
	import { m } from '#lib/paraglide/messages.js';
	import type { JournalEntry } from '#lib/cable/types.ts';
	import { originOf, type OriginsOptions } from '#lib/social/origins.ts';

	let {
		entries = [],
		signedIn = false,
		origins
	}: {
		entries?: readonly JournalEntry[];
		signedIn?: boolean;
		/** Origin storage (tests); default localStorage. */
		origins?: OriginsOptions;
	} = $props();

	const lastOk = $derived([...entries].reverse().find((entry) => entry.status === 'ok') ?? null);
	let installed = $state(false);

	$effect(() => {
		const entry = lastOk;
		const options = origins;
		installed = false;
		if (!signedIn || entry === null) return;
		let s1: string;
		try {
			s1 = encodeS1({ bands: entry.bands, preampDb: entry.preampDb });
		} catch (error) {
			console.warn(JSON.stringify({ event: 'cabo.social.s1', error: (error as Error).name }));
			return;
		}
		let cancelled = false;
		void originOf(s1, options).then((origin) => {
			if (!cancelled) installed = origin !== null;
		});
		return () => {
			cancelled = true;
		};
	});
</script>

{#if signedIn && installed && lastOk}
	<p class="social-status" role="status">
		<span class="lamp" aria-hidden="true"></span>{m.cabosocial_installed({ name: lastOk.name })}
	</p>
{/if}

<style>
	.social-status {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 12px 0 0;
		font:
			600 12px/1.4 'Barlow Condensed',
			sans-serif;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		overflow-wrap: anywhere;
	}
	.lamp {
		display: inline-block;
		flex: none;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #f1fffd, #86e8de 25%, #4fd1c5 52%, #1b7f76);
		box-shadow: 0 0 10px #4fd1c5aa;
	}
</style>
