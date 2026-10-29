<script lang="ts">
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import CableCompare from '#lib/components/cable/CableCompare.svelte';
	import type { Track } from './comparison.ts';

	interface Props {
		app: ClientApp;
		a: Track | undefined;
		b: Track | undefined;
		matched: boolean;
		flat?: boolean;
	}

	let { app, a, b, matched, flat = false }: Props = $props();
	const side = (track: Track | undefined) =>
		track === undefined
			? undefined
			: { key: String(track.id), name: track.curve.name, curve: track.curve };
</script>

<CableCompare {app} a={side(a)} b={side(b)} match={matched} matchToggle {flat} />
