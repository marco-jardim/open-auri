import { expect, test } from '@playwright/test';
import { installHidStub, hidLog } from './helpers/b-hid';
import {
	apo,
	downloadBytes,
	editorCrc,
	exportFile,
	filterBank,
	importTxt,
	openCurva
} from './helpers/b-ui';

test.use({ locale: 'pt-BR', reducedMotion: 'reduce' });

test.beforeEach(async ({ page }) => {
	await installHidStub(page);
});

test('layers are cumulative and reflected in ?camada=, including a reload', async ({ page }) => {
	await page.goto('/?from=e2e#scope');
	await expect(page.getByLabel('Importar .txt ou JSON', { exact: true })).toBeEnabled();
	await expect(page).toHaveTitle('Curva · open-auri');
	const main = page.getByRole('main');
	const layers = page.getByRole('radiogroup', { name: 'Camada', exact: true });
	await expect(main).toHaveAttribute('data-layer', 'ouvir');
	await expect(layers.getByRole('radio', { name: 'Ouvir', exact: true })).toBeChecked();
	await expect(page.getByRole('region', { name: 'Presets', exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Ajuste fino', exact: true })).toBeVisible();
	await expect(filterBank(page)).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Gabinete modular', exact: true })).toHaveCount(0);

	await layers.getByRole('radio', { name: 'Ajustar', exact: true }).click();
	await expect(main).toHaveAttribute('data-layer', 'ajustar');
	await expect(page).toHaveURL(/camada=ajustar/);
	await expect(filterBank(page).getByRole('combobox')).toHaveCount(10);
	await expect(page.getByRole('region', { name: 'Presets', exact: true })).toBeVisible();
	await expect(page.getByRole('region', { name: 'Gabinete modular', exact: true })).toHaveCount(0);

	await layers.getByRole('radio', { name: 'Ajustar', exact: true }).press('ArrowRight');
	await expect(layers.getByRole('radio', { name: 'Engenharia', exact: true })).toBeChecked();
	await expect(page).toHaveURL(/camada=engenharia/);
	expect(new URL(page.url()).searchParams.get('from')).toBe('e2e');
	expect(new URL(page.url()).hash).toBe('#scope');
	await expect(filterBank(page)).toBeVisible();
	await expect(page.getByRole('region', { name: 'Gabinete modular', exact: true })).toBeVisible();
	await page.reload();
	await expect(main).toHaveAttribute('data-layer', 'engenharia');
	await expect(layers.getByRole('radio', { name: 'Engenharia', exact: true })).toBeChecked();

	await layers.getByRole('radio', { name: 'Ouvir', exact: true }).click();
	await expect(main).toHaveAttribute('data-layer', 'ouvir');
	await expect(page).not.toHaveURL(/camada=/);
	expect(new URL(page.url()).searchParams.get('from')).toBe('e2e');
	expect(new URL(page.url()).hash).toBe('#scope');
	await page.goto('/?camada=not-a-layer');
	await expect(main).toHaveAttribute('data-layer', 'ouvir');
});

test('pointer drag stops at the gate boundary with a reason', async ({ page }) => {
	await openCurva(page);
	await importTxt(page, apo(-0.5, 'PK Fc 1000 Hz Gain -6 dB Q 1'));
	const handle = page.getByRole('slider', { name: /^Filtro 1:/ });
	const overlay = page.getByRole('group', { name: 'Alças dos filtros', exact: true });
	await handle.scrollIntoViewIfNeeded();
	const start = await handle.boundingBox();
	const screen = await overlay.boundingBox();
	if (!start || !screen) throw new Error('The filter handle must have a visible bounding box');
	const x = start.x + start.width / 2;
	await page.mouse.move(x, start.y + start.height / 2);
	await page.mouse.down();
	// Near the top of the plot requests +9.2 dB, far beyond the -0.5 dB preamp's headroom.
	await page.mouse.move(x, screen.y + screen.height * 0.08, { steps: 8 });
	await page.mouse.up();
	const reason = page
		.getByRole('region', { name: 'Osciloscópio', exact: true })
		.getByRole('status')
		.filter({ hasText: /^A banda 1 parou no último ponto seguro\./ });
	await expect(reason).toHaveText(
		/^A banda 1 parou no último ponto seguro\. A banda 1 \(1 kHz\) .*(?:saída|pico interno)/
	);
	const gain = filterBank(page)
		.getByRole('spinbutton', { name: 'Ganho (dB)', exact: true })
		.first();
	await expect.poll(async () => Number(await gain.inputValue())).toBeGreaterThan(-6);
	const accepted = Number(await gain.inputValue());
	expect(accepted).toBeLessThanOrEqual(0.1);
	expect(accepted).toBeLessThan(9.2);
	expect(Math.round(accepted * 10) / 10).toBe(accepted);
	await expect(page.getByText('Envelope observado: dentro', { exact: true })).toBeVisible();
	expect(Number(await handle.getAttribute('aria-valuenow'))).toBeCloseTo(1000, 0);
	expect((await hidLog(page)).reports).toEqual([]);
});

for (const sample of [
	{ kind: 'HS', filter: 'HSC Fc 8000 Hz Gain -3 dB Q 0.7' },
	{ kind: 'LP', filter: 'LPQ Fc 1000 Hz Q 0.7' },
	{ kind: 'HP', filter: 'HPQ Fc 1000 Hz Q 0.7' }
] as const) {
	test(`${sample.kind} is experimental in Engenharia and locked in Ajustar`, async ({ page }) => {
		await openCurva(page, 'engenharia');
		await importTxt(page, apo(-1, sample.filter));
		const bank = filterBank(page);
		const module = bank.getByRole('listitem').first();
		const kind = module.getByRole('combobox', { name: 'Tipo', exact: true });
		const handle = page.getByRole('slider', { name: /^Filtro 1:/ });
		await expect(kind).toHaveValue(sample.kind);
		await expect(kind).toBeEnabled();
		await expect(handle).toHaveAttribute('aria-disabled', 'false');
		await expect(module.getByText('EXPERIMENTAL', { exact: true })).toBeVisible();
		for (const option of ['HS', 'LP', 'HP']) {
			await expect(kind.locator(`option[value="${option}"]`)).toHaveText(
				`${option} · EXPERIMENTAL`
			);
		}

		await page.getByRole('radio', { name: 'Ajustar', exact: true }).click();
		await expect(page).toHaveURL(/camada=ajustar/);
		await expect(kind).toBeDisabled();
		for (const input of await module.getByRole('spinbutton').all()) {
			await expect(input).toBeDisabled();
		}
		await expect(handle).toHaveAttribute('aria-disabled', 'true');
		await expect(handle).toHaveAccessibleName(new RegExp(`${sample.kind}, travado`));
		await expect(
			module.getByText('HS, LP e HP: disponíveis na camada Engenharia (experimental).', {
				exact: true
			})
		).toBeVisible();
		const unused = bank.getByRole('listitem').nth(1).getByRole('combobox');
		await expect(unused.locator('option')).toHaveText(['Desligado', 'PK', 'LS']);
		const before = await handle.getAttribute('aria-valuetext');
		await handle.press('ArrowRight');
		await expect(handle).toHaveAttribute('aria-valuetext', before ?? '');

		await page.getByRole('radio', { name: 'Engenharia', exact: true }).click();
		await expect(kind).toBeEnabled();
		await expect(module.getByRole('spinbutton', { name: 'Freq (Hz)', exact: true })).toBeEnabled();
		await expect(handle).toHaveAttribute('aria-disabled', 'false');
	});
}

test('a refused reorder snaps back without changing the curve or its CRC', async ({ page }) => {
	await openCurva(page, 'engenharia');
	await importTxt(page, apo(-0.5, 'PK Fc 1000 Hz Gain -6 dB Q 1', 'PK Fc 1000 Hz Gain 6 dB Q 1'));
	const cabinet = page.getByRole('region', { name: 'Gabinete modular', exact: true });
	const modules = cabinet.getByRole('button', { name: /^S\d+ / });
	await expect(modules).toHaveCount(10);
	const order = await modules.allTextContents();
	const crc = await editorCrc(page);
	await cabinet.getByRole('button', { name: 'Mover S2 para a esquerda', exact: true }).click();
	await expect(cabinet.getByRole('status')).toHaveText(
		/^Ordem recusada: A banda 1 \(1 kHz\) faria o sinal saturar.*pico interno/
	);
	await expect.poll(() => modules.allTextContents()).toEqual(order);
	await expect(cabinet.getByRole('listitem').nth(1)).not.toHaveClass(/\bspring\b/);
	expect(await editorCrc(page)).toBe(crc);
	await expect(
		filterBank(page).getByRole('spinbutton', { name: 'Ganho (dB)', exact: true }).nth(0)
	).toHaveValue('-6');
	await expect(
		filterBank(page).getByRole('spinbutton', { name: 'Ganho (dB)', exact: true }).nth(1)
	).toHaveValue('6');
});

test('.txt import/export and an S1 #p= link preserve the exact curve', async ({ page }) => {
	await openCurva(page);
	await importTxt(
		page,
		apo(-3, 'PK Fc 1000 Hz Gain -6 dB Q 1.25', 'LSC Fc 100 Hz Gain -2 dB Q 0.7')
	);
	const originalCrc = await editorCrc(page);
	const originalBytes = await downloadBytes(await exportFile(page, 'bytes .bin'));
	expect(originalBytes).toHaveLength(220);
	const download = await exportFile(page, '.txt (EqualizerAPO)');
	expect(download.suggestedFilename()).toMatch(/\.txt$/);
	const text = (await downloadBytes(download)).toString('utf8');
	expect(text).toContain('Preamp: -3 dB');
	expect(text).toContain('PK Fc 1000 Hz Gain -6 dB Q 1.25');
	expect(text).toContain('LSC Fc 100 Hz Gain -2 dB Q 0.7');
	const rescue = page.getByRole('region', { name: 'Resgate', exact: true });
	await rescue.getByRole('button', { name: 'Neutro', exact: true }).click();
	expect(await editorCrc(page)).not.toBe(originalCrc);
	await importTxt(page, text, download.suggestedFilename());
	expect(await editorCrc(page)).toBe(originalCrc);
	expect(await downloadBytes(await exportFile(page, 'bytes .bin'))).toEqual(originalBytes);

	await page.getByRole('button', { name: 'Copiar link da curva', exact: true }).click();
	const link = page.getByRole('textbox', { name: 'Link da curva', exact: true });
	await expect(link).toHaveValue(/#p=.+/);
	const sharedUrl = await link.inputValue();
	expect(new URL(sharedUrl).searchParams.get('camada')).toBe('ajustar');
	await rescue.getByRole('button', { name: 'Neutro', exact: true }).click();
	expect(await editorCrc(page)).not.toBe(originalCrc);
	// A new document must decode the link, not merely retain the old in-memory editor.
	const recipient = await page.context().newPage();
	await recipient.goto(sharedUrl);
	await expect(
		recipient.getByRole('main').getByRole('status').filter({
			hasText: 'Curva carregada do link. Nada foi gravado.'
		})
	).toHaveText('Curva carregada do link. Nada foi gravado.');
	expect(await editorCrc(recipient)).toBe(originalCrc);
	expect(await downloadBytes(await exportFile(recipient, 'bytes .bin'))).toEqual(originalBytes);
	// The consumed link leaves the address bar (path and layer kept), so a reload keeps later edits.
	await expect.poll(() => new URL(recipient.url()).hash).toBe('');
	expect(new URL(recipient.url()).searchParams.get('camada')).toBe('ajustar');
	await recipient
		.getByRole('region', { name: 'Resgate', exact: true })
		.getByRole('button', { name: 'Neutro', exact: true })
		.click();
	const editedCrc = await editorCrc(recipient);
	expect(editedCrc).not.toBe(originalCrc);
	await recipient.reload();
	await expect(recipient.locator('.preview-row button.bat')).toBeEnabled();
	expect(new URL(recipient.url()).hash).toBe('');
	await expect(
		recipient.getByRole('main').getByRole('status').filter({
			hasText: 'Curva carregada do link. Nada foi gravado.'
		})
	).toHaveCount(0);
	// Whatever the restored editor is, the link curve was not applied again.
	expect(await editorCrc(recipient)).not.toBe(originalCrc);
	expect((await hidLog(page)).reports).toEqual([]);
	await recipient.close();
});
