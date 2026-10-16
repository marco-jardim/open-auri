/** Attribute set by /lang-boot.js while the prerendered page waits for the resolved locale. */
export const LANG_BOOT_ATTRIBUTE = 'data-lang-boot';

/**
 * Apply the hydrated locale to `<html>` and reveal a document hidden by /lang-boot.js (FX2.3/I1).
 * Safe to call when the boot script did nothing (the attribute is absent).
 */
export function revealLocale(root: HTMLElement, locale: string, dir: 'ltr' | 'rtl'): void {
	root.lang = locale;
	root.dir = dir;
	if (!root.hasAttribute(LANG_BOOT_ATTRIBUTE)) return;
	root.removeAttribute(LANG_BOOT_ATTRIBUTE);
	root.style.removeProperty('visibility');
}
