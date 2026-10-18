// The test is blind: before the result nothing on stage identifies a candidate (no name, no
// curve, no colour or shape that differs between the bays), even when the page already knows
// them. At the result the curtain rises and each bay shows its candidate's name, response line and
// mean score, with the highest mean marked (none on a tie).
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import ListeningRoom from '#lib/components/pages/teste-cego/ListeningRoom.svelte';
import { officialCandidates } from '#lib/components/pages/teste-cego/experiment.ts';
import { sparkPath } from '#lib/components/pages/teste-cego/stage.ts';
import { m } from '#lib/paraglide/messages.js';
import '../../primitives/design-system.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const STYLE_KEYS = ['fill', 'stroke', 'strokeOpacity', 'opacity', 'color', 'filter'] as const;
/** What a viewer can see of every element of a bay or cabinet, minus its position number. */
function look(root: Element): string {
	return [root, ...root.querySelectorAll('*')]
		.map((node) => {
			const style = getComputedStyle(node);
			const text = node.children.length === 0 ? (node.textContent ?? '').replace(/\d/g, '#') : '';
			return `${node.tagName}|${STYLE_KEYS.map((key) => style[key]).join('|')}|${text}`;
		})
		.join('\n');
}

test('before the result the bays are identical and carry no name or curve; at the result they do', async () => {
	const [a, b, c] = officialCandidates();
	if (!a || !b || !c) throw new Error('Missing official candidates');
	const names = [a.name, b.name, c.name];
	const screen = await render(ListeningRoom, {
		onselect: vi.fn(),
		names,
		curves: [a, b, c],
		scores: ['7,5', '4,0', '6,0'],
		top: 0,
		disabled: false,
		selected: 1,
		reducedMotion: true
	});
	const stage = screen.container.querySelector<HTMLElement>('.stage');
	const aperture = stage?.querySelector<HTMLElement>('.aperture');
	const scrim = stage?.querySelector<HTMLElement>('.scrim');
	if (!stage || !aperture || !scrim) throw new Error('Missing stage');

	// Closed: no identity anywhere on stage, and nothing tells the three positions apart.
	for (const name of names) expect(stage.textContent).not.toContain(name);
	expect(stage.querySelectorAll('.plaque, .spark')).toHaveLength(0);
	expect(stage.textContent).not.toContain(m.cego_tcwow_top());
	const cabs = [...stage.querySelectorAll('.cab')];
	expect(cabs).toHaveLength(3);
	expect(new Set(cabs.map((cab) => cab.querySelector('.box')?.outerHTML)).size).toBe(1);
	expect(new Set(cabs.map(look)).size).toBe(1);
	const bays = [...stage.querySelectorAll('.btn.cego-bay')];
	// Only the pressed state (the position the test plays) differs, never a candidate.
	expect(look(bays[0]!)).toBe(look(bays[2]!));
	expect(scrim.getBoundingClientRect().bottom).toBeGreaterThan(
		aperture.getBoundingClientRect().top
	);

	// The result: the curtain is up, and each bay shows who it was.
	await screen.rerender({ revealed: true, disabled: true, selected: -1 });
	expect(scrim.getBoundingClientRect().bottom).toBeLessThanOrEqual(
		aperture.getBoundingClientRect().top + 1
	);
	const plaques = [...stage.querySelectorAll('.plaque')];
	expect(plaques.map((plaque) => plaque.querySelector('.plaque-name')?.textContent)).toEqual(names);
	expect([...stage.querySelectorAll('.spark path')].map((path) => path.getAttribute('d'))).toEqual(
		[a, b, c].map((curve) => sparkPath(curve))
	);
	expect(plaques[0]?.textContent).toContain(m.cego_tcwow_score({ value: '7,5' }));
	expect(plaques[0]?.textContent).toContain(m.cego_tcwow_top());
	expect(stage.querySelectorAll('.plaque.top')).toHaveLength(1);
	expect(stage.querySelector('.cue')?.textContent).toContain(m.cego_revealed());
	// Each bay's name now carries what it revealed (its visible plaque text).
	const first = page.getByRole('button', {
		name: new RegExp('^' + escape(m.cego_position({ number: 1 })))
	});
	await expect.element(first).toHaveAccessibleName(new RegExp(escape(a.name)));

	// A tie marks no winner and says so.
	await screen.rerender({ top: -1, tied: true });
	expect(stage.querySelectorAll('.plaque.top')).toHaveLength(0);
	expect(stage.querySelector('.cue')?.textContent).toContain(m.cego_tcwow_tie());

	// A new test closes the curtain again and the names leave the stage.
	await screen.rerender({ revealed: false, tied: false, names: [], curves: [], scores: [] });
	for (const name of names) expect(stage.textContent).not.toContain(name);
	expect(stage.querySelectorAll('.plaque, .spark')).toHaveLength(0);
});
