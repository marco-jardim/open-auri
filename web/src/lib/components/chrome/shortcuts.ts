import { m } from '#lib/paraglide/messages.js';
import type { Shortcut } from './HelpOverlay.svelte';

/**
 * Global help list. Each entry mirrors a real handler:
 * - `?` / `Esc`: HelpOverlay and the shared modal helper;
 * - Ctrl/⌘+Z and Ctrl/⌘+Shift+Z: the root layout's undo/redo handler;
 * - 1/2/3: Curva layer keys (`isLayerKeyEvent`/`layerFromKey` in pages/curva/layers.ts);
 * - Ctrl/⌘+K: Docs search (`isSearchShortcut` in pages/docs/search.ts).
 */
export function appShortcuts(): Shortcut[] {
	return [
		{ keys: '?', description: m.layout_shortcut_help() },
		{ keys: 'Esc', description: m.layout_shortcut_close() },
		{ keys: 'Ctrl / ⌘ + Z', description: m.layout_shortcut_undo() },
		{ keys: 'Ctrl / ⌘ + Shift + Z', description: m.layout_shortcut_redo() },
		{ keys: '1 / 2 / 3', description: m.layout_shortcut_layers() },
		{ keys: 'Ctrl / ⌘ + K', description: m.layout_shortcut_search() }
	];
}
