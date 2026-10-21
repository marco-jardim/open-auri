<!--
	Tour host (eager, tiny). Auto-open, Escape and dismiss-on-unmount live here; the panel with the
	step definitions of all pages is its own chunk (FUX.B), requested when the tour opens.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { TourPage } from '#lib/comprehension/steps.ts';
	import { tour, type TourController } from '#lib/comprehension/tour.svelte.ts';
	import { tourPanel } from './panels.ts';
	import { registerNativeBack } from '#lib/components/chrome/native-back.ts';

	let {
		page,
		controller = tour,
		autoOpen = true
	}: {
		page: TourPage;
		controller?: TourController;
		autoOpen?: boolean;
	} = $props();
	const visible = $derived(controller.activePage === page);
	$effect(() => {
		if (!visible) return;
		return registerNativeBack({ canDismiss: () => true, dismiss: () => controller.dismiss(page) });
	});

	onMount(() => {
		if (autoOpen && controller.shouldAutoOpen(page)) controller.open(page);
		return () => {
			if (controller.activePage === page) controller.dismiss(page);
		};
	});

	// Each opening requests the chunk; a failed import (offline, not cached) retries next time.
	$effect(() => {
		if (visible) tourPanel.request();
	});

	/** Native or ARIA modal dialogs (TrackSheet, PreWriteChecklist, ConfirmDialog, HelpOverlay). */
	const MODAL = 'dialog[open], [role="dialog"][aria-modal="true"]';

	/**
	 * Escape belongs to a modal dialog while one is open (or the key comes from inside one):
	 * preventing it here would cancel the dialog's own close request. The tour is non-modal and
	 * waits for the next Escape.
	 */
	function modalOwnsEscape(event: KeyboardEvent): boolean {
		const target = event.target;
		if (target instanceof Element && target.closest(MODAL)) return true;
		return document.querySelector(MODAL) !== null;
	}

	function keydown(event: KeyboardEvent) {
		if (visible && event.key === 'Escape' && !event.defaultPrevented && !modalOwnsEscape(event)) {
			event.preventDefault();
			controller.dismiss(page);
		}
	}
</script>

<svelte:window onkeydown={keydown} />

{#if visible && tourPanel.current}
	{@const Panel = tourPanel.current}
	<Panel {page} {controller} />
{/if}
