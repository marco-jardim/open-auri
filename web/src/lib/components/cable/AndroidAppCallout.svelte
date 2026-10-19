<script lang="ts">
	import { onMount } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	import { isNativeAndroid } from '#lib/cable/native/gate.ts';
	import {
		ANDROID_PLAY_LIVE,
		ANDROID_PLAY_URL,
		ANDROID_RELEASES_URL
	} from '#lib/cable/android-links.ts';

	interface AndroidNavigator {
		userAgent: string;
		userAgentData?: { platform: string };
	}
	let {
		inApp = isNativeAndroid(),
		playLive = ANDROID_PLAY_LIVE,
		clientNavigator
	}: {
		inApp?: boolean;
		playLive?: boolean;
		clientNavigator?: AndroidNavigator;
	} = $props();
	let android = $state(false);
	let dismissed = $state(true);

	onMount(() => {
		const agent: AndroidNavigator = clientNavigator ?? navigator;
		android = agent.userAgentData?.platform === 'Android' || /Android/.test(agent.userAgent);
		try {
			dismissed = localStorage.getItem('oa.androidCallout') === 'dismissed';
		} catch (error) {
			console.warn('Android app callout preference could not be read', error);
			dismissed = false;
		}
	});

	function dismiss(): void {
		dismissed = true;
		try {
			localStorage.setItem('oa.androidCallout', 'dismissed');
		} catch (error) {
			console.warn('Android app callout preference could not be saved', error);
		}
	}
</script>

{#if android && !inApp && !dismissed}
	<aside aria-label={m.android_app_callout_title()}>
		<h2>{m.android_app_callout_title()}</h2>
		<p>{m.android_app_callout_body()}</p>
		<p>{m.android_app_callout_untested()}</p>
		<div class="actions">
			{#if playLive}<a href={ANDROID_PLAY_URL}>{m.android_download_play()}</a>{/if}
			<a href={ANDROID_RELEASES_URL}>{m.android_download_github()}</a>
			<button type="button" onclick={dismiss}>{m.android_app_callout_dismiss()}</button>
		</div>
	</aside>
{/if}

<style>
	aside {
		max-width: 1340px;
		margin: 0 auto 24px;
		padding: 20px;
		border: 1px solid #8fe9df;
		border-radius: 6px;
		background: #112b29;
		color: #e4fffb;
	}
	h2,
	p {
		margin: 0 0 12px;
	}
	h2 {
		font-size: 20px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 24px;
	}
	a,
	button {
		display: inline-flex;
		align-items: center;
		min-height: 48px;
		color: inherit;
	}
	button {
		padding: 8px 16px;
		border: 1px solid currentColor;
		border-radius: 4px;
		background: transparent;
		font: inherit;
		cursor: pointer;
	}
</style>
