// W5 (FUX.2): pointer or keyboard intent on the "Soe como X" nav link prefetches the AutoEq index
// once per session; no other link prefetches it. prefetchUrl is spied on and still runs, so the
// real <link rel="prefetch"> is checked too.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { prefetchUrl } from '#lib/app/warm.ts';
import { Nav } from '#lib/components/chrome/index.ts';

vi.mock('#lib/app/warm.ts', async (importOriginal) => {
	const original = await importOriginal<typeof import('#lib/app/warm.ts')>();
	return { ...original, prefetchUrl: vi.fn(original.prefetchUrl) };
});

const SOUND_HREF = '/soe-como-x';
const AUTOEQ_INDEX_URL = '/data/autoeq/index.json';

/** The eight inline links (FUX.NAV: the "Mais" menu also renders the folded ones as items). */
function links(container: HTMLElement): HTMLAnchorElement[] {
	return [...container.querySelectorAll<HTMLAnchorElement>('a[data-nav-link]')];
}

function hover(link: HTMLAnchorElement): void {
	link.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
}

const prefetchLinks = () =>
	document.head.querySelectorAll(`link[rel="prefetch"][href="${AUTOEQ_INDEX_URL}"]`);

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
	vi.mocked(prefetchUrl).mockClear();
});

afterEach(async () => {
	await cleanup();
});

// Runs first on purpose: the once-per-session guard is still untouched here.
test('hovering or focusing any other nav link never prefetches the AutoEq index', async () => {
	const screen = await render(Nav);
	const others = links(screen.container).filter((link) => link.getAttribute('href') !== SOUND_HREF);
	expect(others).toHaveLength(7);
	for (const link of others) {
		hover(link);
		link.focus();
		link.blur();
	}
	expect(prefetchUrl).not.toHaveBeenCalled();
	expect(prefetchLinks()).toHaveLength(0);
});

test('the "Soe como X" link prefetches the AutoEq index once on hover or focus', async () => {
	const first = await render(Nav);
	const sound = links(first.container).find((link) => link.getAttribute('href') === SOUND_HREF);
	expect(sound).toBeDefined();
	if (!sound) return;

	hover(sound);
	expect(prefetchUrl).toHaveBeenCalledTimes(1);
	expect(prefetchUrl).toHaveBeenCalledWith(AUTOEQ_INDEX_URL);
	expect(prefetchLinks()).toHaveLength(1);

	// Repeated intent on the same bar: no second request.
	hover(sound);
	sound.focus();
	sound.blur();
	sound.focus();
	expect(prefetchUrl).toHaveBeenCalledTimes(1);

	// A remounted bar (client navigation) keeps the session's single prefetch.
	await cleanup();
	const second = await render(Nav);
	const again = links(second.container).find((link) => link.getAttribute('href') === SOUND_HREF);
	expect(again).toBeDefined();
	if (again) {
		again.focus();
		hover(again);
	}
	expect(prefetchUrl).toHaveBeenCalledTimes(1);
	expect(prefetchLinks()).toHaveLength(1);
});
