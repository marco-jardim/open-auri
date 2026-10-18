import axe from 'axe-core';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { setLocale } from '#lib/paraglide/runtime.js';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import { m } from '#lib/paraglide/messages.js';

/** Unavailable controls say why: the reason is part of the accessible description. */
const why = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const engines: AudioEngine[] = [];
function sharedEngine() {
	const engine = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	engine.setVolume(-40);
	engines.push(engine);
	return engine;
}

afterEach(async () => {
	await cleanup();
	for (const engine of engines.splice(0)) await engine.dispose();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
	await page.viewport(1440, 900);
});

async function accessible(container: HTMLElement) {
	expect(container.querySelectorAll('[role="img"][aria-valuetext]')).toHaveLength(0);
	const result = await axe.run(container);
	expect(
		result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
	).toEqual([]);
}

for (const copy of [
	{
		locale: 'pt-BR',
		setup: 'Preparo',
		candidates: 'Candidatos',
		other: 'Outra saída',
		start: 'Começar',
		play: 'Tocar',
		position: 'Posição',
		finish: 'Encerrar e revelar',
		share: 'Compartilhar',
		send: 'Enviar preferências',
		cable: 'No cabo',
		soon: 'EM BREVE',
		instant: 'Movimento reduzido:',
		noCI: 'Indisponível com n < 2',
		next: 'Próxima rodada'
	},
	{
		locale: 'en-US',
		setup: 'Setup',
		candidates: 'Candidates',
		other: 'Other output',
		start: 'Start',
		play: 'Play',
		position: 'Position',
		finish: 'Finish and reveal',
		share: 'Share',
		send: 'Send preferences',
		cable: 'On the cable',
		soon: 'COMING SOON',
		instant: 'Reduced motion:',
		noCI: 'Unavailable with n < 2',
		next: 'Next round'
	}
] as const) {
	test(`complete local flow, declared output, real meter, disabled sending and axe in ${copy.locale}`, async () => {
		await setLocale(copy.locale, { reload: false });
		await page.viewport(copy.locale === 'pt-BR' ? 1440 : 390, 1000);
		const audio = sharedEngine();
		const start = vi.spyOn(audio, 'start');
		const createAB = vi.spyOn(audio, 'createAB');
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const screen = await render(BlindTest, { audio, reducedMotion: true });
		await accessible(screen.container);
		// No cable here: the output is declared as another output from the start, and says why.
		await expect
			.element(page.getByRole('radio', { name: new RegExp(`^${copy.other}`) }))
			.toBeChecked();
		await expect.element(page.getByText(m.cego_tcout_auto_none(), { exact: true })).toBeVisible();
		await page.getByRole('tab', { name: new RegExp(copy.candidates) }).click();
		await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
		await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
		expect(start).not.toHaveBeenCalled();
		expect(createAB).not.toHaveBeenCalled();
		await page.getByRole('button', { name: copy.start, exact: true }).click();
		expect(createAB).toHaveBeenCalledOnce();
		expect(start).not.toHaveBeenCalled();
		await expect.element(page.getByText(new RegExp(`^${copy.instant}`))).toBeVisible();
		// Neither the candidates panel nor any accessible label reveals identities during listening.
		expect(screen.container.textContent).not.toContain('Natural');
		expect(screen.container.textContent).not.toContain('Auri');
		await accessible(screen.container);
		const panel = page.getByRole('tabpanel');
		// The score faders live on the stage, under each bay; the panel only points there.
		expect(panel.getByRole('slider').elements()).toHaveLength(0);
		await expect.element(panel.getByText(m.cego_tcscore_hint(), { exact: true })).toBeVisible();
		const score = (number: number) =>
			page.getByRole('slider', { name: m.cego_rating({ number }), exact: true });
		const press = async (number: number, keys: string) => {
			const input = score(number).element();
			if (!(input instanceof HTMLInputElement)) throw new Error('Missing score fader');
			input.focus();
			await userEvent.keyboard(keys);
		};
		await expect.element(score(1)).toBeDisabled();
		await panel.getByRole('button', { name: copy.next, exact: true }).click();
		await expect.element(score(1)).toBeDisabled();
		await panel.getByRole('button', { name: copy.play, exact: true }).click();
		await expect.element(score(1)).toBeEnabled();
		await expect
			.poll(() => screen.container.querySelector('.candidate-meter [data-mode="live"]') !== null)
			.toBe(true);
		await expect
			.poll(() => screen.container.querySelector('.candidate-meter meter[aria-valuetext]') !== null)
			.toBe(true);
		await press(1, '{Home}');
		await panel.getByRole('button', { name: new RegExp(`${copy.position} 2`) }).click();
		await expect.element(score(2)).toBeEnabled();
		await press(2, '{End}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}');
		await expect
			.element(page.getByText(m.cego_tcscore_progress({ rated: 2, total: 2 }), { exact: true }))
			.toBeVisible();
		await accessible(screen.container);
		await panel.getByRole('button', { name: copy.finish, exact: true }).click();
		await expect.element(page.getByRole('table')).toBeVisible();
		await expect.element(page.getByText(copy.noCI, { exact: true }).first()).toBeVisible();
		expect(screen.container.textContent).toContain('Natural');
		expect(audio.state().playing).toBe(false);
		await accessible(screen.container);
		await page.getByRole('tab', { name: new RegExp(copy.cable) }).click();
		await expect.element(page.getByText(copy.soon, { exact: true })).toBeVisible();
		expect(screen.container.textContent).toContain('13');
		await page.getByRole('tab', { name: new RegExp(copy.share) }).click();
		const send = page.getByRole('button', { name: copy.send, exact: true });
		await expect.element(send).toHaveAttribute('aria-disabled', 'true');
		await expect.element(send).toHaveAccessibleDescription(why(m.cegos6_unavailable()));
		await page.getByRole('checkbox').nth(0).click();
		await page.getByRole('checkbox').nth(1).click();
		await expect.element(send).toHaveAttribute('aria-disabled', 'true');
		// Playwright refuses to click aria-disabled elements; dispatch the click to prove it is inert.
		(send.element() as HTMLElement).click();
		expect(fetchSpy).not.toHaveBeenCalled();
		await accessible(screen.container);
	}, 30000);
}

test('normal motion blocks interaction for the three-second shuffle; tab arrows and keyboard work', async () => {
	await setLocale('en-US', { reload: false });
	const audio = sharedEngine();
	const screen = await render(BlindTest, { audio, reducedMotion: false });
	await page.getByRole('radio', { name: /^Other output/ }).click();
	await page.getByRole('tab', { name: /Setup/ }).click();
	await userEvent.keyboard('{ArrowRight}');
	await expect
		.element(page.getByRole('tab', { name: /Candidates/ }))
		.toHaveAttribute('aria-selected', 'true');
	await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
	await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	// Unavailable controls keep focus and say why (Button disabledReason).
	const panelPlay = page.getByRole('tabpanel').getByRole('button', { name: 'Play', exact: true });
	await expect.element(panelPlay).toHaveAttribute('aria-disabled', 'true');
	await expect.element(panelPlay).toHaveAttribute('aria-describedby');
	await expect
		.element(page.getByRole('button', { name: 'Position 1', exact: true }).first())
		.toHaveAttribute('aria-disabled', 'true');
	const lockedTab = page.getByRole('tab', { name: /Candidates/ });
	await expect.element(lockedTab).toBeDisabled();
	await expect
		.element(lockedTab)
		.toHaveAccessibleDescription(why(m.cego_fuxb_reason_tabs_locked()));
	await expect
		.element(page.getByText(m.cego_fuxb_reason_tabs_locked(), { exact: true }))
		.toBeVisible();
	expect(audio.state().playing).toBe(false);
	await expect
		.poll(() => screen.container.querySelector('.room')?.classList.contains('moving'), {
			timeout: 5000
		})
		.toBe(false);
	await expect.element(panelPlay).not.toHaveAttribute('aria-disabled');
	await page.getByRole('button', { name: 'Cancel test', exact: true }).click();
	expect(audio.state().playing).toBe(false);
	await accessible(screen.container);
}, 15000);
