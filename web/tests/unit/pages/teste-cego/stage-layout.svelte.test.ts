// The stage is the heart of the page without displacing its title: beside the title on wide
// screens, a full-width band right under it on narrower ones, and compact on phones (about 40 %
// of the viewport height at most) with no horizontal overflow down to 320 px. The bays stay large
// targets at every width.
import { afterEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import '../../primitives/design-system.ts';

afterEach(async () => {
	await cleanup();
	await page.viewport(1440, 900);
});

async function mount(width: number, height: number) {
	await page.viewport(width, height);
	const screen = await render(BlindTest, { reducedMotion: true });
	await expect.element(page.getByRole('heading', { level: 1 })).toBeVisible();
	const room = screen.container.querySelector<HTMLElement>('.room');
	const title = room?.querySelector<HTMLElement>('.room-title');
	const heading = room?.querySelector<HTMLElement>('h1');
	const stage = room?.querySelector<HTMLElement>('.stage');
	if (!room || !title || !heading || !stage) throw new Error('Missing the room');
	return { room, title, heading, stage };
}

const overlaps = (a: DOMRect, b: DOMRect) =>
	a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

for (const viewport of [
	{ width: 320, height: 640 },
	{ width: 320, height: 568 },
	{ width: 390, height: 844 }
] as const) {
	test(`at ${viewport.width} × ${viewport.height} the stage is compact, under the title, with no horizontal overflow`, async () => {
		const { room, title, heading, stage } = await mount(viewport.width, viewport.height);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
		expect(room.scrollWidth).toBeLessThanOrEqual(room.clientWidth);
		expect(stage.scrollWidth).toBeLessThanOrEqual(stage.clientWidth);
		const box = stage.getBoundingClientRect();
		expect(box.left).toBeGreaterThanOrEqual(0);
		expect(box.right).toBeLessThanOrEqual(viewport.width);
		expect(box.height).toBeLessThanOrEqual(viewport.height * 0.4 + 1);
		// The title keeps its place on top; the stage never sits under it.
		expect(title.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.top);
		expect(overlaps(heading.getBoundingClientRect(), box)).toBe(false);
		const head = stage.querySelector<HTMLElement>('.stage-head');
		expect(head?.scrollWidth).toBeLessThanOrEqual(head?.clientWidth ?? 0);
		for (const bay of stage.querySelectorAll('.btn.cego-bay')) {
			const target = bay.getBoundingClientRect();
			expect(target.width).toBeGreaterThanOrEqual(44);
			expect(target.height).toBeGreaterThanOrEqual(44);
			expect(target.left).toBeGreaterThanOrEqual(box.left);
			expect(target.right).toBeLessThanOrEqual(box.right);
		}
	});
}

test('on a tablet the stage is a full-width band right under the title', async () => {
	const { room, title, stage } = await mount(900, 1000);
	const box = stage.getBoundingClientRect();
	expect(title.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.top);
	const inner = room.getBoundingClientRect();
	const padding = parseFloat(getComputedStyle(room).paddingLeft);
	expect(box.width).toBeGreaterThanOrEqual(inner.width - 2 * padding - 1);
	expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(900);
});

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 1920, height: 1080 }
] as const) {
	test(`at ${viewport.width} px the stage stands beside the title, which keeps its own column`, async () => {
		const { title, heading, stage } = await mount(viewport.width, viewport.height);
		const text = title.getBoundingClientRect();
		const box = stage.getBoundingClientRect();
		expect(box.left).toBeGreaterThanOrEqual(text.right);
		expect(overlaps(heading.getBoundingClientRect(), box)).toBe(false);
		// Side by side, centred on each other: the title is not pushed into a corner.
		expect(box.top).toBeLessThan(text.bottom);
		expect(box.bottom).toBeGreaterThan(text.top);
		const middle = (rect: DOMRect) => rect.top + rect.height / 2;
		expect(Math.abs(middle(text) - middle(box))).toBeLessThan(box.height / 2);
		// The stage is the larger half of the hero.
		expect(box.width).toBeGreaterThan(text.width);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
	});
}
