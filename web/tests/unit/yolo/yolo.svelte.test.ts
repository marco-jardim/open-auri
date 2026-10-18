import { afterEach, beforeEach, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import { createYoloState, YOLO_PHRASE } from '#lib/state/yolo.svelte.ts';
import YoloBar from '#lib/components/yolo/YoloBar.svelte';
import YoloCurveNotice from '#lib/components/yolo/YoloCurveNotice.svelte';
import YoloToggle from '#lib/components/yolo/YoloToggle.svelte';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
});

test('outside Engenharia the switch stays unavailable and says why', async () => {
	const yolo = createYoloState();
	await render(YoloToggle, { yolo, layer: 'ajustar' });
	const toggle = page.getByRole('switch', { name: 'Modo YOLO' });
	await expect.element(toggle).toHaveAttribute('aria-disabled', 'true');
	await expect.element(toggle).toHaveAttribute('aria-checked', 'false');
	await expect
		.element(toggle)
		.toHaveAccessibleDescription(
			'Só na camada Engenharia. Gire o seletor até Engenharia para liberar.'
		);
	// A plain DOM click: aria-disabled keeps it focusable, and pressing it does nothing.
	toggle.element().dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(yolo.enabled).toBe(false);
});

test('consent: cancel has the focus, the phrase is validated live, turn on only when it matches', async () => {
	const yolo = createYoloState();
	await render(YoloToggle, { yolo, layer: 'engenharia' });
	const toggle = page.getByRole('switch', { name: 'Modo YOLO' });
	await toggle.click();
	const dialog = page.getByRole('dialog', { name: 'Ativar o Modo YOLO' });
	await expect.element(dialog).toBeVisible();
	await expect.element(dialog.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
	for (const heading of ['O que muda', 'O que continua travado', 'Riscos', 'Como termina']) {
		await expect.element(dialog.getByRole('heading', { name: heading, exact: true })).toBeVisible();
	}
	const confirm = dialog.getByRole('button', { name: 'Ativar o Modo YOLO' });
	await expect.element(confirm).toHaveAttribute('aria-disabled', 'true');

	const field = dialog.getByRole('textbox');
	await field.fill('assumo');
	await expect.element(dialog.getByText('Até aqui confere. Continue.')).toBeVisible();
	await field.fill('assumo o riscx');
	await expect.element(field).toHaveAttribute('aria-invalid', 'true');
	await expect
		.element(dialog.getByText('A frase não confere. Digite ASSUMO O RISCO.'))
		.toBeVisible();
	await expect.element(confirm).toHaveAttribute('aria-disabled', 'true');

	await field.fill(`  ${YOLO_PHRASE.toLowerCase()} `);
	await expect
		.element(dialog.getByText('A frase confere. O botão de ativar está liberado.'))
		.toBeVisible();
	await expect.element(confirm).not.toHaveAttribute('aria-disabled');
	await confirm.click();
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	expect(yolo.enabled).toBe(true);
	await expect.element(toggle).toHaveAttribute('aria-checked', 'true');
});

test('Escape cancels the consent, keeps YOLO off and returns the focus', async () => {
	const yolo = createYoloState();
	await render(YoloToggle, { yolo, layer: 'engenharia' });
	const toggle = page.getByRole('switch', { name: 'Modo YOLO' });
	await toggle.click();
	await expect.element(page.getByRole('dialog')).toBeVisible();
	await userEvent.keyboard('{Escape}');
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	await expect.element(toggle).toHaveFocus();
	expect(yolo.enabled).toBe(false);
});

test('on: the sub-controls show, and one press turns YOLO off', async () => {
	const yolo = createYoloState();
	yolo.enable(YOLO_PHRASE, 'engenharia');
	let broughtBack = 0;
	await render(YoloToggle, {
		yolo,
		layer: 'engenharia',
		onbringback: () => {
			broughtBack += 1;
		}
	});
	await expect.element(page.getByRole('checkbox', { name: 'Prévia sem limites' })).toBeVisible();
	await page.getByRole('button', { name: 'Trazer para o modo normal' }).click();
	expect(broughtBack).toBe(1);
	await page.getByRole('switch', { name: 'Modo YOLO' }).click();
	expect(yolo.enabled).toBe(false);
});

test('the bar names what is waived, opens the warning and turns YOLO off in one press', async () => {
	const yolo = createYoloState();
	yolo.enable(YOLO_PHRASE, 'engenharia');
	await render(YoloBar, { yolo });
	const bar = page.getByRole('region', { name: 'Modo YOLO ligado' });
	await expect.element(bar).toBeVisible();
	await expect.element(bar).toMatchTextContent('Sem limites de engenharia');
	await expect.element(bar).toMatchTextContent('Travas de hardware mantidas');

	await bar.getByRole('button', { name: 'Aviso' }).click();
	const dialog = page.getByRole('dialog', { name: 'Aviso do Modo YOLO' });
	await expect.element(dialog).toBeVisible();
	const close = dialog.getByRole('button', { name: 'Fechar' });
	await expect.element(close).toHaveFocus();
	await close.click();
	await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();

	// The visible label is split in two spans; the accessible name keeps the space.
	await bar.getByRole('button', { name: 'Desligar YOLO', exact: true }).click();
	expect(yolo.enabled).toBe(false);
	await expect.element(page.getByRole('region', { name: 'Modo YOLO ligado' })).not.toBeInTheDocument();
});

test('the curve notice titles each variant and carries the full disclaimer', async () => {
	const variants = [
		['editor', 'Curva YOLO no editor'],
		['library', 'Curva YOLO na biblioteca'],
		['share', 'Você abriu uma curva YOLO'],
		['public', 'Curva YOLO publicada']
	] as const;
	for (const [variant, title] of variants) {
		await render(YoloCurveNotice, { variant, waived: ['ganho', 'Q', 'ganho', ' '] });
		const note = page.getByRole('note', { name: title });
		await expect.element(note).toBeVisible();
		await expect.element(note.getByRole('heading', { level: 3, name: title })).toBeVisible();
		expect(note.getByRole('listitem').elements()).toHaveLength(2);
		await expect.element(note).toMatchTextContent('Modo YOLO ligado na camada Engenharia');
		await expect.element(note).toMatchTextContent('As travas de hardware continuam valendo');
		await cleanup();
	}
});

test('the compact curve notice is a badge and one line, with no heading', async () => {
	await render(YoloCurveNotice, { variant: 'public', compact: true });
	const note = page.getByRole('note', { name: 'Aviso de curva YOLO' });
	await expect.element(note).toMatchTextContent('YOLO');
	await expect.element(note).toMatchTextContent('Além dos limites padrão. Gravar exige o Modo YOLO.');
	await expect.element(note.getByRole('heading')).not.toBeInTheDocument();
});
