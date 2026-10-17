<!--
	Menu button whose menu (the Menu primitive) is its own chunk (FUX.NAV, route budgets). The
	trigger renders at once, with the caller's look and the menu-button semantics
	(aria-haspopup="menu", aria-expanded="false"); hover, focus or a press warms the chunk. The
	first activation (click or tap, Enter, Space, ArrowDown, ArrowUp) swaps in the real Menu and
	replays that activation on its trigger, so everyone gets exactly the primitive's behaviour:
	focus on the first or last item, roving arrows, Home/End, Escape back to the trigger, Tab
	closes, fixed placement from the trigger rect. Used by "Mais", "Carregar no editor" and the
	user menu.
-->
<script module lang="ts">
	import { LazyModule } from '#lib/app/lazy.svelte.ts';

	// One chunk for every lazy menu of the bar.
	const menuModule = new LazyModule(() => import('#lib/components/primitives/Menu.svelte'));
</script>

<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { MenuItem } from '#lib/components/primitives/Menu.svelte';

	type Activation = 'click' | 'ArrowDown' | 'ArrowUp';

	interface Props extends Omit<
		HTMLButtonAttributes,
		| 'children'
		| 'onclick'
		| 'onkeydown'
		| 'type'
		| 'aria-haspopup'
		| 'aria-expanded'
		| 'aria-controls'
	> {
		items: readonly MenuItem[];
		/** Content of the trigger (its text, or the aria-label, names the menu). */
		trigger: Snippet;
		open?: boolean;
		align?: 'start' | 'end';
		note?: string | null;
		triggerElement?: HTMLButtonElement;
		/** Runs before the first opening (e.g. to read the items from the DOM). */
		onintent?: () => void;
	}

	let {
		items,
		trigger,
		open = $bindable(false),
		align = 'end',
		note = null,
		triggerElement = $bindable(),
		onintent,
		...rest
	}: Props = $props();

	let active = $state(false);
	/** A second press while the chunk arrives must not replay twice (it would close the menu). */
	let activating = false;

	function warm(): void {
		menuModule.request();
	}

	async function activate(how: Activation): Promise<void> {
		if (activating) return;
		activating = true;
		onintent?.();
		try {
			await menuModule.load();
		} catch (error) {
			console.error('The menu could not load', error);
			return;
		} finally {
			activating = false;
		}
		active = true;
		await tick();
		const element = triggerElement;
		if (!element) return;
		element.focus();
		if (how === 'click') element.click();
		else element.dispatchEvent(new KeyboardEvent('keydown', { key: how, bubbles: true }));
	}

	function keydown(event: KeyboardEvent): void {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		void activate(event.key);
	}
</script>

{#if active && menuModule.current}
	{@const Menu = menuModule.current}
	<Menu {...rest} {items} {trigger} {align} {note} bind:open bind:triggerElement />
{:else}
	<button
		{...rest}
		bind:this={triggerElement}
		type="button"
		aria-haspopup="menu"
		aria-expanded="false"
		onpointerenter={warm}
		onpointerdown={warm}
		onfocus={warm}
		onclick={() => void activate('click')}
		onkeydown={keydown}
	>
		{@render trigger()}
	</button>
{/if}
