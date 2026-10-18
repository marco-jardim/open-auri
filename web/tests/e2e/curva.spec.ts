import { expect, test } from '@playwright/test';
import { installHidStub, hidLog } from './helpers/b-hid';
import { settleRendering } from './helpers/a-app';
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
	await expect(filterBank(page).getByRole('spinbutton', { name: 'Tipo', exact: true })).toHaveCount(10);
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
	const handle = page.getByRole('slider', { name: /^Filtro A,/ });
	const overlay = page.getByRole('group', { name: 'Alças dos filtros', exact: true });
	// The whole plot, not only the handle, sits mid-viewport: on a phone it is about 290 × 135 px
	// and the limit caption plate above it pushes it toward the fold. Every pointer position is
	// taken from the plot's box as it is now (after the scroll, the press and each step), because
	// the page may move under a pointer the handle has already captured.
	await overlay.evaluate((element) => element.scrollIntoView({ block: 'center' }));
	const start = await handle.boundingBox();
	const plot = await overlay.boundingBox();
	if (!start || !plot) throw new Error('The filter handle must have a visible bounding box');
	// The handle's place within the plot: across is its frequency, down its gain.
	const across = (start.x + start.width / 2 - plot.x) / plot.width;
	const down = (start.y + start.height / 2 - plot.y) / plot.height;
	await page.mouse.move(plot.x + plot.width * across, plot.y + plot.height * down);
	await page.mouse.down();
	// The press reached the handle itself (it holds the pointer), not something lying over it.
	await expect(handle).toHaveAttribute('class', /\bdragging\b/);
	// Near the top of the plot requests +9.2 dB, far beyond the -0.5 dB preamp's headroom.
	const steps = 8;
	for (let step = 1; step <= steps; step++) {
		const screen = await overlay.boundingBox();
		if (!screen) throw new Error('The filter handles lost their bounding box mid-drag');
		const at = down + (0.08 - down) * (step / steps);
		await page.mouse.move(screen.x + screen.width * across, screen.y + screen.height * at);
	}
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
		// The bank head also lists the envelope criteria (a)–(g); filter strips are the items with
		// a kind switch.
		const modules = bank
			.getByRole('listitem')
			.filter({ has: page.getByRole('spinbutton', { name: 'Tipo', exact: true }) });
		await expect(modules).toHaveCount(10);
		const module = modules.first();
		const kind = module.getByRole('spinbutton', { name: 'Tipo', exact: true });
		const handle = page.getByRole('slider', { name: /^Filtro A,/ });
		await expect(kind).toHaveAttribute('aria-valuetext', new RegExp(`\\(${sample.kind}\\)$`));
		await expect(kind).toBeEnabled();
		await expect(handle).toHaveAttribute('aria-disabled', 'false');
		await expect(
			module.locator('.mod-head').getByText('EXPERIMENTAL', { exact: true })
		).toBeVisible();
		await kind.focus();
		const legend = module.getByRole('tooltip');
		await expect(legend).toBeVisible();
		for (const experimental of ['HS', 'LP', 'HP']) {
			await expect(
				legend.getByRole('listitem').filter({ has: page.getByText(experimental, { exact: true }) })
			).toContainText('EXPERIMENTAL');
		}

		await page.getByRole('radio', { name: 'Ajustar', exact: true }).click();
		await expect(page).toHaveURL(/camada=ajustar/);
		// The current experimental filter is locked, but its dial can leave through an unlocked stop.
		await expect(kind).toBeEnabled();
		for (const input of await module.locator('input[type="number"]').all()) {
			await expect(input).toBeDisabled();
		}
		await expect(handle).toHaveAttribute('aria-disabled', 'true');
		await expect(handle).toHaveAccessibleName(new RegExp(`${sample.kind}, travado`));
		await expect(
			module.getByText('HS, LP e HP: disponíveis na camada Engenharia (experimental).', {
				exact: true
			})
		).toBeVisible();
		const unused = modules.nth(1).getByRole('spinbutton', { name: 'Tipo', exact: true });
		for (const next of ['PK', 'LS', 'OFF']) {
			await unused.press('ArrowRight');
			await expect(unused).toHaveAttribute('aria-valuetext', new RegExp(`\\(${next}\\)$`));
		}
		const before = await handle.getAttribute('aria-valuetext');
		await handle.press('ArrowRight');
		await expect(handle).toHaveAttribute('aria-valuetext', before ?? '');

		await page.getByRole('radio', { name: 'Engenharia', exact: true }).click();
		await expect(kind).toBeEnabled();
		await expect(module.getByRole('spinbutton', { name: 'Freq (Hz)', exact: true })).toBeEnabled();
		await expect(handle).toHaveAttribute('aria-disabled', 'false');
		await page.getByRole('radio', { name: 'Ajustar', exact: true }).click();
		await kind.press('ArrowRight');
		await expect(kind).toHaveAttribute('aria-valuetext', /\(PK\)$/);
		await expect(handle).toHaveAttribute('aria-disabled', 'false');
		expect((await hidLog(page)).reports).toEqual([]);
	});
}

test('Neutro parks ten points with a hint; one becomes a gated filter, nothing is written', async ({
	page
}) => {
	await openCurva(page);
	await page
		.getByRole('region', { name: 'Resgate', exact: true })
		.getByRole('button', { name: 'Neutro', exact: true })
		.click();
	await expect(
		page.getByText('Arraste um ponto para criar um filtro, ou carregue um preset', { exact: true })
	).toBeVisible();
	await expect(page.getByRole('slider', { name: /^Ponto [A-J], .*estacionado em 0 dB/ })).toHaveCount(
		10
	);
	const bank = filterBank(page);
	await expect(bank.getByText('Envelope observado', { exact: true })).toBeVisible();
	await expect(bank.locator('.gaterow li')).toHaveCount(7);
	await expect(page.getByText(/GATE v2/)).toHaveCount(0);
	await page.getByRole('slider', { name: /^Ponto F,/ }).focus();
	await page.keyboard.press('ArrowDown');
	await expect(page.getByRole('slider', { name: /^Filtro F,/ })).toBeVisible();
	await expect(
		bank.getByRole('spinbutton', { name: 'Ganho (dB)', exact: true }).first()
	).toHaveValue('-1');
	await expect(page.getByRole('slider', { name: /^Ponto [A-J],/ })).toHaveCount(0);
	expect((await hidLog(page)).reports).toEqual([]);
});

test('the bank wraps without horizontal scrolling and shares its badges with the scope', async ({
	page
}) => {
	await openCurva(page);
	await importTxt(page, apo(-3, 'PK Fc 1000 Hz Gain -6 dB Q 1'));
	await settleRendering(page);
	const bank = filterBank(page);
	const modules = bank.locator('ol.modules > li.module');
	await expect(modules).toHaveCount(10);
	await expect(modules.locator('.mod-badge')).toHaveText('ABCDEFGHIJ'.split(''));
	await expect(bank.getByRole('spinbutton', { name: 'Tipo', exact: true })).toHaveCount(10);
	const columns = await bank
		.locator('ol.modules')
		.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
	expect(columns).toBe((page.viewportSize()?.width ?? 0) >= 1000 ? 5 : 2);
	expect(await bank.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	const name = (await modules.first().locator('.mod-name').textContent())?.trim();
	expect(name).toBeTruthy();
	expect(await page.getByRole('slider', { name: /^Filtro A,/ }).getAttribute('aria-label')).toContain(
		`Filtro A, ${name}: PK`
	);
	// Processing order is secondary metadata, not the band's identity or its main heading.
	await expect(modules.first().locator('.mod-stage')).toHaveAttribute(
		'title',
		'Estágio 1 na ordem de processamento'
	);
	const scope = page.getByRole('region', { name: 'Osciloscópio', exact: true });
	await expect(scope.locator('.grat text').filter({ hasText: /^48k$/ })).toBeVisible();
	await expect(scope.locator('.inaudible-t')).toHaveText('inaudível · até Nyquist (48 kHz)');
});

test('a refused reorder snaps back without changing the curve or its CRC', async ({ page }) => {
	await openCurva(page, 'engenharia');
	await importTxt(page, apo(-0.5, 'PK Fc 1000 Hz Gain -6 dB Q 1', 'PK Fc 1000 Hz Gain 6 dB Q 1'));
	const cabinet = page.getByRole('region', { name: 'Gabinete modular', exact: true });
	// Cabinet slots still name processing order; A–J badges identify the scope and bank instead.
	const modules = cabinet.getByRole('button', { name: /^Filtro \d+ / });
	await expect(modules).toHaveCount(10);
	const order = await modules.allTextContents();
	const crc = await editorCrc(page);
	await cabinet
		.getByRole('button', { name: 'Mover o filtro 2 para a esquerda', exact: true })
		.click();
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
