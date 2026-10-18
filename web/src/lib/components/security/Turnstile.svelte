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

	/** Outcome stamped on the api.js tag ('loaded' | 'failed'). A tag never fires load/error twice. */
	const STATE_ATTR = 'data-turnstile-state';

	let loading: Promise<TurnstileApi> | null = null;

	/** Loads api.js once (explicit rendering), only when a widget is mounted. */
	export function loadTurnstile(): Promise<TurnstileApi> {
		// Also covers a reused tag that already loaded: the api is there, nothing to wait for.
		const ready = globalApi();
		if (ready) return Promise.resolve(ready);
		if (loading) return loading;
		const pending = new Promise<TurnstileApi>((resolve, reject) => {
			let existing = document.getElementById(SCRIPT_ID);
			// A tag that already settled (failed, or loaded without defining the api) will not fire
			// again: waiting on it would hang, so it is replaced by a fresh one.
			if (existing instanceof HTMLScriptElement && existing.hasAttribute(STATE_ATTR)) {
				existing.remove();
				existing = null;
			}
			const reused = existing instanceof HTMLScriptElement ? existing : null;
			const script = reused ?? document.createElement('script');
			const fail = (error: Error) => {
				script.setAttribute(STATE_ATTR, 'failed');
				// Out of <head> and out of the cache: the next mount injects a fresh tag.
				script.remove();
				if (loading === pending) loading = null;
				reject(error);
			};
			script.addEventListener(
				'load',
				() => {
					const api = globalApi();
					if (!api) {
						fail(new Error('turnstile-missing'));
						return;
					}
					script.setAttribute(STATE_ATTR, 'loaded');
					resolve(api);
				},
				{ once: true }
			);
			script.addEventListener('error', () => fail(new Error('turnstile-load')), { once: true });
			if (!reused) {
				script.id = SCRIPT_ID;
				script.src = TURNSTILE_SCRIPT_URL;
				script.async = true;
				document.head.append(script);
			}
		});
		loading = pending;
		return pending;
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { m } from '#lib/paraglide/messages.js';
	// Direct import: the widget is used on several routes; only the skeleton is needed here.
	import Skeleton from '#lib/components/primitives/Skeleton.svelte';

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
	let root: HTMLDivElement;
	let failed = $state(false);
	/** The widget is on the page (render returned an id): the skeleton steps aside. */
	let rendered = $state(false);
	/**
	 * The user has acted on the surrounding form (focus, typing, submit). Until then a failure
	 * is not announced: nobody should meet an error before doing anything. Outside a form the
	 * widget is the action, so failures are announced at once.
	 */
	let acted = $state(false);
	const showError = $derived(failed && acted);

	onMount(() => {
		let api: TurnstileApi | null = null;
		let widgetId: string | null = null;
		let destroyed = false;
		let errorResets = 0;

		const form = root.closest('form');
		const markActed = () => {
			acted = true;
		};
		const actEvents = ['focusin', 'input', 'submit', 'pointerdown'] as const;
		if (form) {
			for (const type of actEvents) form.addEventListener(type, markActed, { capture: true });
		} else {
			acted = true;
		}

		loadTurnstile()
			.then((loaded) => {
				if (destroyed) return;
				api = loaded;
				const id =
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
				widgetId = id;
				rendered = id !== null;
			})
			.catch(() => {
				if (destroyed) return;
				token = '';
				failed = true;
				onerror?.('load');
			});

		return () => {
			destroyed = true;
			if (form) {
				for (const type of actEvents) {
					form.removeEventListener(type, markActed, { capture: true });
				}
			}
			if (api && widgetId !== null) api.remove(widgetId);
		};
	});
</script>

<div
	class="turnstile"
	role="group"
	aria-label={label ?? m.security_turnstile_label()}
	bind:this={root}
>
	<div class="frame">
		<div bind:this={container}></div>
		{#if !rendered && !showError}
			<!-- Same 65 px box as the widget (CLS zero). After a silent failure it stays still and
			     says nothing until the user acts; then the error below replaces it. -->
			<div class="placeholder" data-state={failed ? 'stalled' : 'preparing'}>
				{#if failed}
					<span class="still" aria-hidden="true"></span>
				{:else}
					<Skeleton width="100%" height="65px" label={m.fuxp8_turnstile_preparing()} />
					<span class="preparing" aria-hidden="true">{m.fuxp8_turnstile_preparing()}</span>
				{/if}
			</div>
		{/if}
	</div>
	<input type="hidden" {name} value={token} />
	{#if showError}
		<p class="error" role="alert">{m.security_turnstile_error()}</p>
	{/if}
</div>

<style>
	.turnstile {
		min-height: 65px;
	}

	.frame {
		position: relative;
		min-height: 65px;
	}

	.placeholder {
		position: absolute;
		inset: 0 auto 0 0;
		width: min(300px, 100%);
		height: 65px;
		border-radius: var(--rad-md, 4px);
		overflow: hidden;
	}

	.placeholder :global(.skeleton-box),
	.still {
		display: block;
		width: 100%;
		height: 65px;
	}

	/* Silent failure before the user acts: a still, empty box (no shimmer, no text). */
	.still {
		border-radius: var(--rad-md, 4px);
		background: var(--lamp-off, rgba(236, 231, 221, 0.1));
	}

	.preparing {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		padding: 0 16px;
		color: var(--text-2, #cfc9be);
		font-family: var(--face-body, var(--ui, 'Geist', system-ui, sans-serif));
		font-size: var(--fs-caption, 12px);
		line-height: var(--lh-small, 1.4);
	}

	.error {
		margin: 6px 0 0;
		color: #e0a39a;
		font-family: var(--face-body, var(--ui, 'Geist', system-ui, sans-serif));
		font-size: var(--label-min, 11px);
		line-height: 1.5;
	}
</style>
