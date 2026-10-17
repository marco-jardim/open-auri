<!--
	Tooltip (design system v2.1, spec §2.6). Opens after 400 ms of hover, at once on keyboard
	focus, closes on Escape, pointer leave or blur, and can be hovered itself (WCAG 1.4.13).
	It is never the only place of critical information: callers also wire `aria-describedby`.
	Rendered in the top layer (popover="manual") and placed with `position: fixed` from the
	trigger's rect, so the horizontally scrolling bar or a transformed parent never clips it.

	Two ways to attach it:
	- snippet: {#snippet children(tip)}<button {@attach tip.attach} aria-describedby={tip.id}>…{/snippet}
	- element: <Tooltip anchor={element} text="…" /> (the caller sets aria-describedby={id}).
-->
<script module lang="ts">
	import type { Attachment } from 'svelte/attachments';

	export interface TooltipTrigger {
		/** Id of the tooltip element: put it in the trigger's aria-describedby. */
		id: string;
		/** Attach to the trigger: {@attach tip.attach}. */
		attach: Attachment<HTMLElement>;
	}
</script>

<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';

	interface Props {
		text: string;
		/** Element id; generated when omitted. */
		id?: string;
		/** Trigger element when the caller renders it (instead of the snippet). */
		anchor?: HTMLElement | null;
		open?: boolean;
		/** Hover delay in ms (spec: 400). Keyboard focus opens at once. */
		delay?: number;
		placement?: 'top' | 'bottom';
		children?: Snippet<[TooltipTrigger]>;
	}

	const generatedId = $props.id();
	let {
		text,
		id = `${generatedId}-tip`,
		anchor = null,
		open = $bindable(false),
		delay = 400,
		placement = 'bottom',
		children
	}: Props = $props();

	const GAP = 8;
	const MARGIN = 8;
	const CLOSE_GRACE = 120;

	let tip: HTMLElement | undefined = $state();
	let trigger: HTMLElement | null = null;
	let pos = $state<{ top: number; left: number } | null>(null);
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;

	function clearTimers(): void {
		clearTimeout(openTimer);
		clearTimeout(closeTimer);
		openTimer = undefined;
		closeTimer = undefined;
	}

	function show(): void {
		clearTimers();
		open = true;
	}

	function hide(): void {
		clearTimers();
		open = false;
	}

	function scheduleOpen(): void {
		clearTimeout(closeTimer);
		closeTimer = undefined;
		if (open || openTimer !== undefined) return;
		openTimer = setTimeout(() => {
			openTimer = undefined;
			open = true;
		}, delay);
	}

	function scheduleClose(): void {
		clearTimeout(openTimer);
		openTimer = undefined;
		clearTimeout(closeTimer);
		closeTimer = setTimeout(() => {
			closeTimer = undefined;
			open = false;
		}, CLOSE_GRACE);
	}

	function place(): void {
		if (!trigger || !tip) return;
		const rect = trigger.getBoundingClientRect();
		const box = tip.getBoundingClientRect();
		const below = rect.bottom + GAP;
		const above = rect.top - GAP - box.height;
		const fitsBelow = below + box.height <= window.innerHeight - MARGIN;
		let top: number;
		if (placement === 'top') top = above >= MARGIN ? above : below;
		else top = fitsBelow ? below : Math.max(MARGIN, above);
		const centred = rect.left + rect.width / 2 - box.width / 2;
		const left = Math.max(MARGIN, Math.min(centred, window.innerWidth - box.width - MARGIN));
		pos = { top, left };
	}

	/** Wires hover, focus and Escape on a trigger; returns the cleanup. */
	function bind(node: HTMLElement): () => void {
		trigger = node;
		// Focus that follows a press on the trigger is a pointer focus (hover already handles
		// it); any other focus (Tab, a script returning focus) opens the tooltip at once. This
		// does not rely on :focus-visible, whose heuristics differ between browsers and frames.
		let pressed = false;
		const enter = (event: PointerEvent) => {
			if (event.pointerType !== 'touch') scheduleOpen();
		};
		const leave = (event: PointerEvent) => {
			if (event.pointerType !== 'touch') scheduleClose();
		};
		const press = () => {
			pressed = true;
		};
		const release = () => {
			pressed = false;
		};
		const focus = () => {
			if (!pressed) show();
		};
		const blur = () => {
			pressed = false;
			hide();
		};
		node.addEventListener('pointerenter', enter);
		node.addEventListener('pointerleave', leave);
		node.addEventListener('pointerdown', press);
		node.addEventListener('pointerup', release);
		node.addEventListener('pointercancel', release);
		node.addEventListener('focusin', focus);
		node.addEventListener('focusout', blur);
		return () => {
			node.removeEventListener('pointerenter', enter);
			node.removeEventListener('pointerleave', leave);
			node.removeEventListener('pointerdown', press);
			node.removeEventListener('pointerup', release);
			node.removeEventListener('pointercancel', release);
			node.removeEventListener('focusin', focus);
			node.removeEventListener('focusout', blur);
			if (trigger === node) trigger = null;
		};
	}

	const attach: Attachment<HTMLElement> = (node) => bind(node);

	$effect(() => {
		if (anchor) return bind(anchor);
	});

	// Open state → top layer, position, and dismissal while open.
	$effect(() => {
		const element = tip;
		if (!element) return;
		if (!open) {
			if (element.matches(':popover-open')) element.hidePopover();
			pos = null;
			return;
		}
		if (!element.matches(':popover-open')) element.showPopover();
		place();
		const onKeydown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			// Escape dismisses the tooltip first, without closing a surrounding dialog or menu.
			event.preventDefault();
			event.stopPropagation();
			hide();
		};
		const reposition = () => place();
		document.addEventListener('keydown', onKeydown, true);
		window.addEventListener('scroll', reposition, true);
		window.addEventListener('resize', reposition);
		return () => {
			document.removeEventListener('keydown', onKeydown, true);
			window.removeEventListener('scroll', reposition, true);
			window.removeEventListener('resize', reposition);
		};
	});

	onDestroy(clearTimers);
</script>

{#if children}{@render children({ id, attach })}{/if}
<div
	{id}
	bind:this={tip}
	class="tooltip"
	role="tooltip"
	popover="manual"
	style:top={pos ? `${pos.top}px` : null}
	style:left={pos ? `${pos.left}px` : null}
	style:visibility={pos ? null : 'hidden'}
	onpointerenter={() => {
		clearTimeout(closeTimer);
		closeTimer = undefined;
	}}
	onpointerleave={scheduleClose}
>
	{text}
</div>
