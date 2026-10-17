// Chip, Lamp and Skeleton (FUX.1, spec §2.6): meter mode chips only say LIVE / DATA / OFF,
// lamps announce real state, skeletons are busy containers with screen-reader text.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { Chip, Lamp, Skeleton } from '#lib/components/primitives/index.ts';
import './design-system.ts';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

test.each([
	['live', 'AO VIVO', 'chip--ok'],
	['data', 'DADOS', 'chip--accent'],
	['off', 'APAGADO', 'chip--neutral']
] as const)('meter mode chip %s reads %s', async (mode, text, tone) => {
	const screen = await render(Chip, { mode });
	const chip = screen.container.querySelector('.chip');
	if (!(chip instanceof HTMLElement)) throw new Error('Missing chip');
	await expect.element(chip).toHaveTextContent(text);
	expect(chip.classList.contains('chip--mode')).toBe(true);
	expect(chip.classList.contains(tone)).toBe(true);
	expect(chip.dataset.mode).toBe(mode);
});

test('mode chips switch language with the app', async () => {
	await setLocale('en-US', { reload: false });
	const screen = await render(Chip, { mode: 'live' });
	await expect
		.element(screen.container.querySelector<HTMLElement>('.chip')!)
		.toHaveTextContent('LIVE');
});

test('tone chips render their content with the tone class', async () => {
	const screen = await render(Chip, {
		tone: 'warn',
		dot: true,
		children: createRawSnippet(() => ({ render: () => '<span>aprovado</span>' }))
	});
	const chip = screen.container.querySelector('.chip');
	if (!(chip instanceof HTMLElement)) throw new Error('Missing chip');
	await expect.element(chip).toHaveTextContent('aprovado');
	expect(chip.classList.contains('chip--warn')).toBe(true);
	expect(chip.querySelector('.chip__dot')?.getAttribute('aria-hidden')).toBe('true');
});

test('a labelled lamp announces its real state; an unlabelled one is decorative', async () => {
	const screen = await render(Lamp, { on: true, tone: 'ok', label: 'Nível igualado' });
	const lamp = page.getByRole('img', { name: 'Nível igualado: aceso' });
	await expect.element(lamp).toHaveAttribute('data-on', 'true');
	await screen.rerender({ on: false });
	await expect
		.element(page.getByRole('img', { name: 'Nível igualado: apagado' }))
		.toBeInTheDocument();
	await cleanup();
	const plain = await render(Lamp, { on: true });
	const element = plain.container.querySelector('.lamp');
	expect(element?.getAttribute('aria-hidden')).toBe('true');
	expect(element?.hasAttribute('role')).toBe(false);
});

test('skeleton: busy container, screen-reader text, fixed geometry, then the content', async () => {
	const screen = await render(Skeleton, {
		loading: true,
		width: '240px',
		height: '65px',
		children: createRawSnippet(() => ({ render: () => '<p>Pronto</p>' }))
	});
	const box = screen.container.querySelector('.skeleton-box');
	if (!(box instanceof HTMLElement)) throw new Error('Missing skeleton');
	expect(box.getAttribute('aria-busy')).toBe('true');
	await expect.element(page.getByText('Carregando…')).toBeInTheDocument();
	const rect = box.getBoundingClientRect();
	expect([rect.width, rect.height]).toEqual([240, 65]);
	expect(box.querySelector('.skeleton')?.getAttribute('aria-hidden')).toBe('true');
	await screen.rerender({ loading: false });
	await expect.element(page.getByText('Pronto')).toBeVisible();
	expect(box.getAttribute('aria-busy')).toBe('false');
	expect(page.getByText('Carregando…').elements()).toHaveLength(0);
});
