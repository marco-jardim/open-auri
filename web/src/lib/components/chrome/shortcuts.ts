import { m } from '#lib/paraglide/messages.js';
import type { Shortcut } from './HelpOverlay.svelte';
import { togglePreview, type PlaybackEngine, type PlaybackErrorHandler } from './playback.ts';

/** Unmodified k only: forms, editable content and modal dialogs keep their keystrokes. */
export function playbackShortcut(
	event: KeyboardEvent,
	engine?: PlaybackEngine,
	onError?: PlaybackErrorHandler
): boolean {
	if (
		event.defaultPrevented ||
		event.repeat ||
		event.isComposing ||
		event.key !== 'k' ||
		event.ctrlKey ||
		event.metaKey ||
		event.altKey ||
		event.shiftKey
	) {
		return false;
	}
	const target = event.target;
	if (
		target instanceof Element &&
		target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
	) {
		return false;
	}
	if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return false;
	if (!engine?.state().canToggle) return false;
	event.preventDefault();
	void togglePreview(engine, onError);
	return true;
}

/**
 * Global help list. Each entry mirrors a real handler:
 * - `?` / `Esc`: HelpOverlay and the shared modal helper;
 * - k: the root layout's existing-preview playback handler;
 * - Ctrl/⌘+Z and Ctrl/⌘+Shift+Z: the root layout's undo/redo handler;
 * - 1/2/3: Curva layer keys (`isLayerKeyEvent`/`layerFromKey` in pages/curva/layers.ts);
 * - Ctrl/⌘+K: Docs search (`isSearchShortcut` in pages/docs/search.ts);
 * - A / B / Space: the Comparar page's "Comparar no cabo" lever while it runs
 *   (`onKeydown` in pages/comparar/CableAB.svelte).
 */
export function appShortcuts(): Shortcut[] {
	return [
		{ keys: '?', description: m.layout_shortcut_help() },
		{ keys: 'Esc', description: m.layout_shortcut_close() },
		{ keys: 'k', description: m.seek3_shortcut_playback() },
		{ keys: 'Ctrl / ⌘ + Z', description: m.layout_shortcut_undo() },
		{ keys: 'Ctrl / ⌘ + Shift + Z', description: m.layout_shortcut_redo() },
		{ keys: '1 / 2 / 3', description: m.layout_shortcut_layers() },
		{ keys: 'Ctrl / ⌘ + K', description: m.layout_shortcut_search() },
		{ keys: m.cable_x2_shortcut_keys(), description: m.cable_x2_shortcut_lever() }
	];
}
