<!--
	Menu button (spec §2.6, WAI-ARIA APG "menu button"). Used by the user menu in the bar.
	- Trigger: aria-haspopup="menu", aria-expanded, aria-controls. Click, Enter or Space opens
	  and focuses the first item; ArrowDown/ArrowUp open on the first/last item.
	- Menu: role="menu" with role="menuitem" links or buttons (roving focus, tabindex -1).
	  ArrowDown/ArrowUp move (wrapping), Home/End jump, Escape closes and returns focus to the
	  trigger, Tab closes and lets focus move on, a click outside closes.
	- An item may be unavailable with a reason (aria-disabled + aria-describedby, still
	  reachable with the arrows, never activates).
	- The popup is `position: fixed` below the trigger, computed from its rect and refreshed on
	  scroll (capture: the bar's own horizontal scroll too) and resize. The bar scrolls
	  horizontally and would clip an absolutely positioned popup (same fix as the audio panel).
-->
<script module lang="ts">
	export interface MenuItem {
		id: string;
		label: string;
		/** Link item; otherwise an action (onselect). */
		href?: string;
		onselect?: () => void;
		/** Marks the item for the current page (aria-current="page"). */
		current?: boolean;
		/** Non-empty: the item cannot act now and says why. */
		disabledReason?: string | null;
		tone?: 'default' | 'danger';
		/** Draw a separator before this item. */
		separated?: boolean;
	}
</script>

<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

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
		/** Content of the trigger button (its text is the menu's accessible name). */
		trigger: Snippet;
		open?: boolean;
		/** Align the popup with the trigger's start or end edge (default end). */
		align?: 'start' | 'end';
		/** Short visible status under the items (e.g. a failure); the caller announces it. */
		note?: string | null;
		triggerElement?: HTMLButtonElement;
	}

	const uid = $props.id();
	let {
		items,
		trigger,
		open = $bindable(false),
		align = 'end',
		note = null,
		triggerElement = $bindable(),
		id = `${uid}-trigger`,
		...rest
	}: Props = $props();

	const menuId = `${uid}-menu`;
	const GAP = 6;
	const MARGIN = 8;

	let popup: HTMLDivElement | undefined = $state();
	let pos = $state<{ top: number; left: number } | null>(null);

	const reasonOf = (item: MenuItem): string | null => item.disabledReason?.trim() || null;
	const reasonId = (item: MenuItem): string => `${menuId}-${item.id}-reason`;

	function menuItems(): HTMLElement[] {
		return popup ? [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
	}

	function focusAt(index: number): void {
		const list = menuItems();
		if (list.length === 0) return;
		list[((index % list.length) + list.length) % list.length]?.focus();
	}

	function place(): void {
		if (!triggerElement || !popup) return;
		const rect = triggerElement.getBoundingClientRect();
		const width = popup.offsetWidth;
		const wanted = align === 'end' ? rect.right - width : rect.left;
		const left = Math.max(MARGIN, Math.min(wanted, window.innerWidth - width - MARGIN));
		pos = { top: rect.bottom + GAP, left };
	}

	async function openMenu(focus: 'first' | 'last'): Promise<void> {
		open = true;
		await tick();
		place();
		await tick();
		focusAt(focus === 'first' ? 0 : -1);
	}

	function closeMenu(returnFocus: boolean): void {
		if (!open) return;
		open = false;
		if (returnFocus) triggerElement?.focus();
	}

	function onTriggerClick(): void {
		if (open) closeMenu(false);
		else void openMenu('first');
	}

	function onTriggerKeydown(event: KeyboardEvent): void {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		void openMenu(event.key === 'ArrowDown' ? 'first' : 'last');
	}

	function onMenuKeydown(event: KeyboardEvent): void {
		const list = menuItems();
		const index = list.findIndex((element) => element === document.activeElement);
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				focusAt(index + 1);
				break;
			case 'ArrowUp':
				event.preventDefault();
				focusAt(index < 0 ? -1 : index - 1);
				break;
			case 'Home':
				event.preventDefault();
				focusAt(0);
				break;
			case 'End':
				event.preventDefault();
				focusAt(-1);
				break;
			case 'Escape':
				event.preventDefault();
				event.stopPropagation();
				closeMenu(true);
				break;
			case 'Tab':
				// Let the browser move focus first, then close (focus is not pulled back).
				setTimeout(() => closeMenu(false), 0);
				break;
			case ' ': {
				// Space activates link items too (buttons do it natively).
				const target = event.target;
				if (target instanceof HTMLAnchorElement) {
					event.preventDefault();
					target.click();
				}
				break;
			}
		}
	}

	function onMenuFocusout(event: FocusEvent): void {
		const next = event.relatedTarget;
		if (!(next instanceof Node)) return;
		if (popup?.contains(next) || triggerElement?.contains(next)) return;
		closeMenu(false);
	}

	function activate(item: MenuItem, event: MouseEvent): void {
		if (reasonOf(item)) {
			event.preventDefault();
			return;
		}
		// Links navigate (focus follows the new page); actions give focus back to the trigger.
		closeMenu(!item.href);
		item.onselect?.();
	}

	$effect(() => {
		if (!open) {
			pos = null;
			return;
		}
		// Effects run after the DOM update: the popup is laid out, place it (covers a caller
		// opening it through bind:open as well as openMenu).
		place();
		const reposition = () => place();
		const outside = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) return;
			if (popup?.contains(target) || triggerElement?.contains(target)) return;
			closeMenu(false);
		};
		window.addEventListener('scroll', reposition, true);
		window.addEventListener('resize', reposition);
		document.addEventListener('pointerdown', outside, true);
		return () => {
			window.removeEventListener('scroll', reposition, true);
			window.removeEventListener('resize', reposition);
			document.removeEventListener('pointerdown', outside, true);
		};
	});
</script>

<button
	{...rest}
	{id}
	bind:this={triggerElement}
	type="button"
	aria-haspopup="menu"
	aria-expanded={open}
	aria-controls={menuId}
	onclick={onTriggerClick}
	onkeydown={onTriggerKeydown}
>
	{@render trigger()}
</button>
<div
	class="menu-pop"
	bind:this={popup}
	hidden={!open}
	style:position="fixed"
	style:top={pos ? `${pos.top}px` : null}
	style:left={pos ? `${pos.left}px` : null}
	style:visibility={pos ? null : 'hidden'}
>
	<div
		class="menu"
		role="menu"
		id={menuId}
		tabindex="-1"
		aria-labelledby={id}
		onkeydown={onMenuKeydown}
		onfocusout={onMenuFocusout}
	>
		{#each items as item (item.id)}
			{@const reason = reasonOf(item)}
			{#if item.separated}<div class="menu__sep" role="separator"></div>{/if}
			{#if item.href && !reason}
				<a
					class={['menu__item', item.tone === 'danger' && 'menu__item--danger']}
					role="menuitem"
					tabindex="-1"
					href={item.href}
					aria-current={item.current ? 'page' : undefined}
					data-menu-item={item.id}
					onclick={(event) => activate(item, event)}>{item.label}</a
				>
			{:else}
				<button
					type="button"
					class={['menu__item', item.tone === 'danger' && 'menu__item--danger']}
					role="menuitem"
					tabindex="-1"
					aria-disabled={reason ? 'true' : undefined}
					aria-describedby={reason ? reasonId(item) : undefined}
					data-menu-item={item.id}
					onclick={(event) => activate(item, event)}
				>
					<span>{item.label}</span>
					{#if reason}<span class="menu__reason" aria-hidden="true">{reason}</span>{/if}
				</button>
			{/if}
		{/each}
	</div>
	<div hidden>
		{#each items as item (item.id)}
			{#if reasonOf(item)}<span id={reasonId(item)}>{reasonOf(item)}</span>{/if}
		{/each}
	</div>
	{#if note}<p class="menu__note">{note}</p>{/if}
</div>
