<script lang="ts" module>
	export const TURNSTILE_SCRIPT_URL =
		'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
	const SCRIPT_ID = 'cf-turnstile-api';
	/** Error-triggered resets before giving up (a persistent error must not loop). */
	const MAX_ERROR_RESETS = 2;

	export interface TurnstileRenderOptions {
		sitekey: string;
		action: string;
		theme?: 'auto' | 'light' | 'dark';
		language?: string;
		'response-field'?: boolean;
		callback?: (token: string) => void;
		'error-callback'?: (code: string) => boolean | void;
		'expired-callback'?: () => void;
		'timeout-callback'?: () => void;
	}

	export interface TurnstileApi {
		render(container: HTMLElement, options: TurnstileRenderOptions): string | null | undefined;
		reset(widgetId?: string): void;
		remove(widgetId?: string): void;
	}

	type WindowWithTurnstile = Window & { turnstile?: TurnstileApi };

	function globalApi(): TurnstileApi | undefined {
		return (window as WindowWithTurnstile).turnstile;
	}

	let loading: Promise<TurnstileApi> | null = null;

	/** Loads api.js once (explicit rendering), only when a widget is mounted. */
	export function loadTurnstile(): Promise<TurnstileApi> {
		const ready = globalApi();
		if (ready) return Promise.resolve(ready);
		if (loading) return loading;
		loading = new Promise<TurnstileApi>((resolve, reject) => {
			const existing = document.getElementById(SCRIPT_ID);
			const script =
				existing instanceof HTMLScriptElement ? existing : document.createElement('script');
			const done = () => {
				const api = globalApi();
				if (api) resolve(api);
				else reject(new Error('turnstile-missing'));
			};
			script.addEventListener('load', done, { once: true });
			script.addEventListener('error', () => reject(new Error('turnstile-load')), { once: true });
			if (!existing) {
				script.id = SCRIPT_ID;
				script.src = TURNSTILE_SCRIPT_URL;
				script.async = true;
				document.head.append(script);
			}
		}).catch((error: unknown) => {
			loading = null;
			throw error;
		});
		return loading;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';

	interface Props {
		/** PUBLIC_TURNSTILE_SITE_KEY (from `$app/env/public` in the page; passed in for tests). */
		siteKey: string;
		/** Widget action; the server checks it (TURNSTILE_ACTIONS). */
		action: string;
		/** Current token ('' while unsolved, expired or failed). */
		token?: string;
		/** Name of the hidden form field read by the server. */
		name?: string;
		label?: string;
		language?: string;
		theme?: 'auto' | 'light' | 'dark';
		onerror?: (code: string) => void;
	}

	let {
		siteKey,
		action,
		token = $bindable(''),
		name = 'cf-turnstile-response',
		label,
		language,
		theme = 'auto',
		onerror
	}: Props = $props();

	let container: HTMLDivElement;
	let failed = $state(false);

	onMount(() => {
		let api: TurnstileApi | null = null;
		let widgetId: string | null = null;
		let destroyed = false;
		let errorResets = 0;

		loadTurnstile()
			.then((loaded) => {
				if (destroyed) return;
				api = loaded;
				widgetId =
					loaded.render(container, {
						sitekey: siteKey,
						action,
						theme,
						language,
						// The hidden input below is the single source of the token.
						'response-field': false,
						callback: (value) => {
							token = value;
							failed = false;
							errorResets = 0;
						},
						'expired-callback': () => {
							token = '';
							api?.reset(widgetId ?? undefined);
						},
						'timeout-callback': () => {
							token = '';
							api?.reset(widgetId ?? undefined);
						},
						'error-callback': (code) => {
							token = '';
							onerror?.(String(code));
							if (errorResets < MAX_ERROR_RESETS) {
								errorResets += 1;
								api?.reset(widgetId ?? undefined);
							} else {
								failed = true;
							}
							return true;
						}
					}) ?? null;
			})
			.catch(() => {
				if (destroyed) return;
				token = '';
				failed = true;
				onerror?.('load');
			});

		return () => {
			destroyed = true;
			if (api && widgetId !== null) api.remove(widgetId);
		};
	});
</script>

<div class="turnstile" role="group" aria-label={label ?? m.security_turnstile_label()}>
	<div bind:this={container}></div>
	<input type="hidden" {name} value={token} />
	{#if failed}
		<p class="error" role="alert">{m.security_turnstile_error()}</p>
	{/if}
</div>

<style>
	.turnstile {
		min-height: 65px;
	}

	.error {
		margin: 6px 0 0;
		color: #e0a39a;
		font: 11px/1.5 var(--ui, 'Geist', system-ui, sans-serif);
	}
</style>
