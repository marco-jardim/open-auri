// Scoring happens on the stage: during Escuta each bay carries its own score fader on the floor,
// a sibling of the bay's selection button (never inside it), with the old slider's name, range,
// step and keys, wired to the test's own rating state and vote. It shows only the position number
// and the score until the result, where it turns into a read-only display of the score given.
// It stays compact and inside the stage at 320 px, and axe finds nothing serious on the stage.
import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import Stage from '#lib/components/pages/teste-cego/Stage.svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import '../../primitives/design-system.ts';

let audio: AudioEngine | null = null;
afterEach(async () => {
	await cleanup();
	await audio?.dispose();
	audio = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1440, 900);
});

const score = (number: number) =>
	page.getByRole('slider', { name: m.cego_rating({ number }), exact: true });

function fader(number: number): HTMLInputElement {
	const input = score(number).element();
	if (!(input instanceof HTMLInputElement)) throw new Error('Missing score fader');
	return input;
}

async function press(number: number, keys: string) {
	fader(number).focus();
	await userEvent.keyboard(keys);
}

async function stageAxe(stage: Element) {
	const result = await axe.run(stage);
	expect(
		result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
	).toEqual([]);
}

/** A started test (reduced motion: no swap wait) of two or three candidates, on Escuta. */
async function startTest(
	viewport: { width: number; height: number } = { width: 1440, height: 900 },
	three = false
) {
	await setLocale('en-US', { reload: false });
	await page.viewport(viewport.width, viewport.height);
	audio = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	audio.setVolume(-40);
	const screen = await render(BlindTest, { audio, reducedMotion: true });
	await page.getByRole('radio').last().click();
	await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
	await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
	await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
	if (three) {
		// Any other accepted candidate completes a three-position round.
		const third = [
			...screen.container.querySelectorAll<HTMLInputElement>('.candidate input[type="checkbox"]')
		].find((input) => !input.checked && !input.disabled);
		if (!third) throw new Error('No third candidate available');
		third.click();
		await expect.element(third).toBeChecked();
	}
	await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
	const stage = screen.container.querySelector<HTMLElement>('.stage');
	if (!stage) throw new Error('Missing stage');
	return { screen, stage };
}

test('each bay holds a select button and a sibling score fader with the old name, range and step', async () => {
	await setLocale('en-US', { reload: false });
	const onrate = vi.fn();
	const screen = await render(Stage, {
		onselect: vi.fn(),
		onrate,
		disabled: false,
		selected: 0,
		scoring: true,
		ratings: [null, 7, null],
		rateable: [true, true, false]
	});
	const bays = [...screen.container.querySelectorAll('.bays .bay')];
	expect(bays).toHaveLength(3);
	for (const [index, bay] of bays.entries()) {
		const input = fader(index + 1);
		// Not nested: the fader and the selection button are siblings in the bay.
		expect(input.closest('button')).toBeNull();
		expect(input.closest('.bay')).toBe(bay);
		expect(bay.querySelector(':scope > button.cego-bay')).not.toBeNull();
		expect(bay.querySelector('button input, button [role="slider"]')).toBeNull();
		expect([input.type, input.min, input.max, input.step]).toEqual(['range', '0', '10', '0.5']);
	}
	// Unrated: the fader rests mid-scale and says it has no score; the readout shows a dash.
	expect(fader(1).value).toBe('5');
	expect(fader(1).getAttribute('aria-valuetext')).toBe(m.cego_unrated());
	expect(bays[0]?.querySelector('.score-value')?.textContent).toBe('−');
	// Rated: value, valuetext and readout agree.
	expect(fader(2).value).toBe('7');
	expect(fader(2).getAttribute('aria-valuetext')).toBe('7.0');
	expect(bays[1]?.querySelector('.score-value')?.textContent).toBe('7.0');
	// Not heard: locked, with the reason.
	expect(fader(3).disabled).toBe(true);
	await expect.element(score(3)).toHaveAccessibleDescription(m.cego_tcscore_listen_reason());
	expect(bays[2]?.querySelector('.score-lock')?.textContent).toContain(m.cego_tcscore_listen());

	// The keys step by 0.5, as the old slider did.
	await press(1, '{ArrowRight}');
	expect(onrate).toHaveBeenLastCalledWith(0, '5.5');
	await press(1, '{ArrowLeft}{ArrowLeft}');
	expect(onrate).toHaveBeenLastCalledWith(0, '4.5');
	await press(2, '{Home}');
	expect(onrate).toHaveBeenLastCalledWith(1, '0');
	await press(2, '{End}');
	expect(onrate).toHaveBeenLastCalledWith(1, '10');
	// Enter on an unrated fader keeps the value it rests on as the score.
	await screen.rerender({ ratings: [null, 10, null] });
	onrate.mockClear();
	fader(1).value = '5';
	await press(1, '{Enter}');
	expect(onrate).toHaveBeenCalledWith(0, '5');
	// While the test swaps, every fader waits.
	await screen.rerender({ moving: true });
	for (const number of [1, 2, 3]) expect(fader(number).disabled).toBe(true);
	await expect.element(score(1)).toHaveAccessibleDescription(m.cego_fux_reason_moving());
});

test('the stage faders drive the round votes; blind while listening, read-only at the result', async () => {
	const { screen, stage } = await startTest();
	const panel = page.getByRole('tabpanel');
	// The Escuta panel keeps a hint and its actions; no slider is left there.
	expect(panel.getByRole('slider').elements()).toHaveLength(0);
	await expect.element(panel.getByText(m.cego_tcscore_hint(), { exact: true })).toBeVisible();
	await expect.element(score(1)).toBeDisabled();
	await expect.element(score(2)).toBeDisabled();
	await stageAxe(stage);

	await panel.getByRole('button', { name: m.cego_play(), exact: true }).click();
	await expect.element(score(1)).toBeEnabled();
	await press(1, '{End}');
	await expect.element(score(1)).toHaveAttribute('aria-valuetext', '10.0');
	await expect
		.element(panel.getByText(m.cego_tcscore_progress({ rated: 1, total: 2 }), { exact: true }))
		.toBeVisible();
	// The bay picks position 2 (heard while playing), then its fader scores 0.
	await page
		.getByRole('group', { name: m.cego_tcwow_bays(), exact: true })
		.getByRole('button', { name: m.cego_position({ number: 2 }), exact: true })
		.click();
	await expect.element(score(2)).toBeEnabled();
	await press(2, '{Home}');
	await expect.element(score(2)).toHaveAttribute('aria-valuetext', '0.0');
	await expect
		.element(panel.getByText(m.cego_tcscore_progress({ rated: 2, total: 2 }), { exact: true }))
		.toBeVisible();
	// Blind: neither the stage nor the faders' names tell who is where.
	for (const name of ['Auri', 'Natural']) {
		expect(stage.textContent).not.toContain(name);
		for (const input of stage.querySelectorAll('input')) {
			expect(input.getAttribute('aria-label') ?? '').not.toContain(name);
			expect(input.getAttribute('aria-valuetext') ?? '').not.toContain(name);
		}
	}
	await stageAxe(stage);

	// The same vote logic: finishing records these scores, so the means are exactly 10 and 0.
	await panel.getByRole('button', { name: m.cego_finish(), exact: true }).click();
	await expect.element(page.getByRole('table')).toBeVisible();
	const means = [...screen.container.querySelectorAll('.table-wrap tbody tr')].map(
		(row) => row.querySelectorAll('td')[0]?.textContent
	);
	expect(means.sort()).toEqual(['0.00', '10.00']);
	// Result: no fader left on stage; each bay shows its score, read-only, beside the names.
	expect(stage.querySelectorAll('input, [role="slider"]')).toHaveLength(0);
	const finals = [...stage.querySelectorAll('.score.final')];
	expect(finals.map((final) => final.querySelector('.score-value')?.textContent)).toEqual([
		m.cego_qa1tc_last_round({ value: '10.0' }),
		m.cego_qa1tc_last_round({ value: '0.0' })
	]);
	expect(finals[0]?.textContent).toContain(m.cego_position({ number: 1 }));
	expect(stage.textContent).toContain('Auri');
	expect(stage.textContent).toContain('Natural');
	await stageAxe(stage);
	expect(audio?.state().playing).toBe(false);
}, 30000);

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`the result labels the last round separately from the mean in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		await page.viewport(320, 568);
		const screen = await render(Stage, {
			onselect: vi.fn(),
			revealed: true,
			reducedMotion: true,
			names: ['Auri', 'Natural', 'Third'],
			scores: ['6', '5', '4'],
			ratings: [10, 0, null]
		});
		const finals = [...screen.container.querySelectorAll<HTMLElement>('.score.final')];
		const format = new Intl.NumberFormat(locale, {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1
		});
		expect(finals.map((final) => final.querySelector('.score-value')?.textContent)).toEqual([
			m.cego_qa1tc_last_round({ value: format.format(10) }),
			m.cego_qa1tc_last_round({ value: format.format(0) }),
			m.cego_qa1tc_last_round({ value: m.cego_unrated() })
		]);
		await expect
			.element(page.getByText(m.cego_tcwow_score({ value: '6' }), { exact: true }))
			.toBeVisible();
		for (const final of finals) {
			expect(final.scrollWidth).toBeLessThanOrEqual(final.clientWidth);
			const bay = final.closest('.bay')?.getBoundingClientRect();
			if (!bay) throw new Error('Missing result bay');
			expect(final.getBoundingClientRect().top).toBeGreaterThanOrEqual(bay.top);
			expect(final.getBoundingClientRect().bottom).toBeLessThanOrEqual(bay.bottom);
		}
	});
}

for (const viewport of [
	{ width: 320, height: 640 },
	{ width: 320, height: 568 }
] as const) {
	test(`at ${viewport.width} × ${viewport.height} three compact faders fit under the bays`, async () => {
		// A three-candidate round fills every bay.
		const { stage } = await startTest(viewport, true);
		await expect.element(score(3)).toBeInTheDocument();

		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
		expect(stage.scrollWidth).toBeLessThanOrEqual(stage.clientWidth);
		const box = stage.getBoundingClientRect();
		expect(box.right).toBeLessThanOrEqual(viewport.width);
		// It grows a little for the score row, and stays under about half the screen.
		expect(box.height).toBeLessThanOrEqual(viewport.height * 0.5 + 1);
		const aperture = stage.querySelector('.aperture')?.getBoundingClientRect();
		if (!aperture) throw new Error('Missing aperture');
		for (const [index, bay] of [...stage.querySelectorAll('.bays .bay')].entries()) {
			const area = bay.getBoundingClientRect();
			const control = bay.querySelector('.score')?.getBoundingClientRect();
			const input = fader(index + 1).getBoundingClientRect();
			const select = bay.querySelector('button.cego-bay')?.getBoundingClientRect();
			if (!control || !select) throw new Error('Incomplete bay');
			expect(control.left).toBeGreaterThanOrEqual(area.left - 0.5);
			expect(control.right).toBeLessThanOrEqual(area.right + 0.5);
			expect(control.bottom).toBeLessThanOrEqual(aperture.bottom);
			// Touch targets: the fader and the select button stay large enough.
			expect(input.height).toBeGreaterThanOrEqual(24);
			expect(input.width).toBeGreaterThanOrEqual(24);
			expect(select.height).toBeGreaterThanOrEqual(24);
			// The score row sits under the select button, never over it.
			expect(control.top).toBeGreaterThanOrEqual(select.bottom - 0.5);
		}
		await stageAxe(stage);
		await page.getByRole('button', { name: m.cego_cancel(), exact: true }).click();
		expect(audio?.state().playing).toBe(false);
	}, 30000);
}
