<script lang="ts">
	import { onMount } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { ANDROID_PLAY_LIVE, isAndroidBrowser, playStoreHref } from '#lib/cable/android-links.ts';
	import { isNativeAndroid } from '#lib/cable/native/gate.ts';

	let { playLive = ANDROID_PLAY_LIVE }: { playLive?: boolean } = $props();
	let mounted = $state(false);
	let inApp = $state(false);
	let android = $state(false);
	const href = $derived(playStoreHref(android));

	onMount(() => {
		inApp = isNativeAndroid();
		android = isAndroidBrowser(navigator);
		mounted = true;
	});
</script>

{#if playLive && mounted && !inApp}
	<a
		class="btn btn--plate btn--sm btn--bar btn--icon"
		{href}
		target={android ? undefined : '_blank'}
		rel={android ? undefined : 'noopener noreferrer'}
		aria-label={m.chrome_get_android_app()}
	>
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			<path
				d="M8 2v8m-3-3 3 3 3-3M2.5 10.5v3h11v-3"
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	</a>
{/if}
