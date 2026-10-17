import { readFile } from 'node:fs/promises';
import { expect, type Download, type Locator, type Page } from '@playwright/test';

export const LOUDNESS_WARNING =
	'A nova curva pode soar mais alta. Abaixe o volume antes de gravar.';
export const EXPERIMENTAL_WARNING =
	'Esta curva usa tipos que a página oficial nunca gravou. Os coeficientes estão dentro do envelope observado, mas o firmware nunca recebeu esses formatos.';
export const FLASH_NOTICE =
	'A memória do cabo tem vida útil desconhecida; memórias desse tipo costumam aguentar de 10 mil a 1 milhão de gravações.';

/** Small, valid curves enter through the same file picker a user operates. */
export function apo(preampDb: number, ...filters: string[]): string {
	return [
		`Preamp: ${preampDb} dB`,
		...filters.map((filter, index) => `Filter ${index + 1}: ON ${filter}`),
		''
	].join('\n');
}

export function filterBank(page: Page): Locator {
	return page.getByRole('region', { name: 'Banco de filtros', exact: true });
}

export async function openCurva(page: Page, layer = 'ajustar'): Promise<void> {
	await page.goto(`/?camada=${layer}`);
	await expect(page.getByRole('main')).toHaveAttribute('data-layer', layer);
	await expect(page.getByLabel('Importar .txt ou JSON', { exact: true })).toBeEnabled();
}

export async function importTxt(page: Page, text: string, name = 'e2e-curve.txt'): Promise<void> {
	await expect(page.getByLabel('Importar .txt ou JSON', { exact: true })).toBeEnabled();
	await page.setInputFiles('input[accept=".txt,.json,text/plain,application/json"]', {
		name,
		mimeType: 'text/plain',
		buffer: Buffer.from(text, 'utf8')
	});
	await expect(
		page
			.getByRole('main')
			.getByRole('status')
			.filter({ hasText: /^Importado:/ })
	).toHaveText(/^Importado: \d+ seções, preamp /);
}

export async function exportFile(page: Page, name: string): Promise<Download> {
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name, exact: true }).click();
	return download;
}

export async function downloadBytes(download: Download): Promise<Buffer> {
	const path = await download.path();
	if (path === null) throw new Error('The browser did not save the download');
	return readFile(path);
}

export async function editorCrc(page: Page): Promise<string> {
	const state = page.getByRole('main').getByTestId('editor-state');
	await expect(state).toContainText(/CRC (?:0x)?[\dA-F]{4}/i);
	const crc = /CRC ((?:0x)?[\dA-F]{4})/i.exec((await state.textContent()) ?? '')?.[1];
	if (!crc) throw new Error('The editor did not display its CRC');
	return crc;
}

// ---- Global bar (FUX.NAV) ----------------------------------------------------------------
// Desktop folds destinations into "Mais" and the presets into "Carregar no editor"; at 720 px
// and below the row keeps the wordmark, cable lamp, Áudio, Gravar and a menu button, and the
// menu sheet holds the navigation, presets, account, language and help.
const BAR = '[data-chrome="bar"]';
const MENU_BUTTON = /^(Abrir menu|Open menu)$/;
const SHEET = /^Menu$/;

/** Where the user operates the bar: the bar itself, or the menu sheet (opened here) on mobile. */
export async function barScope(page: Page): Promise<Locator> {
	const bar = page.locator(BAR);
	const menuButton = bar.getByRole('button', { name: MENU_BUTTON });
	if (!(await menuButton.isVisible())) return bar;
	const sheet = bar.getByRole('dialog', { name: SHEET });
	// Retried: a press before hydration opens nothing.
	await expect(async () => {
		if (!(await sheet.isVisible())) await menuButton.click();
		await expect(sheet).toBeVisible({ timeout: 1_000 });
	}).toPass();
	return sheet;
}

/** A main-navigation destination as a user reaches it: inline link, "Mais" item or sheet link. */
export async function barNavLink(page: Page, name: string): Promise<Locator> {
	const scope = await barScope(page);
	const nav = scope.getByRole('navigation', { name: /^(Principal|Main)$/ });
	const link = nav.getByRole('link', { name, exact: true });
	if (await link.isVisible()) return link;
	const more = nav.getByRole('button', { name: /^(Mais|More)$/ });
	const item = page.getByRole('menuitem', { name, exact: true });
	await expect(async () => {
		if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
		await expect(item).toBeVisible({ timeout: 1_000 });
	}).toPass();
	return item;
}

/**
 * A bar action (Neutro, Padrão Auri, help, language…): its visible button, the "Carregar no
 * editor" item on desktop below 1600 px, or the sheet's button on mobile.
 */
export async function barAction(
	page: Page,
	name: string,
	{ exact = true }: { exact?: boolean } = {}
): Promise<Locator> {
	const scope = await barScope(page);
	const button = scope.getByRole('button', { name, exact });
	if (await button.isVisible()) return button;
	const tools = scope.getByRole('button', { name: /^(Carregar no editor|Load into the editor)$/ });
	const item = page.getByRole('menuitem', { name, exact });
	await expect(async () => {
		if ((await tools.getAttribute('aria-expanded')) !== 'true') await tools.click();
		await expect(item).toBeVisible({ timeout: 1_000 });
	}).toPass();
	return item;
}

/** Navigate in the UI, preserving the running app and the stub's permitted devices. */
export async function goToCable(page: Page): Promise<void> {
	await (await barNavLink(page, 'Cabo')).click();
	await expect(page).toHaveURL(/\/cabo(?:[?#]|$)/);
	await expect(
		page.getByRole('button', { name: 'Levantar tampa do checklist', exact: true })
	).toBeEnabled();
}

export async function connectCable(page: Page, simulated = false): Promise<void> {
	await page
		.getByRole('button', {
			name: simulated ? 'Conectar cabo simulado' : 'Conectar via WebHID real',
			exact: true
		})
		.click();
	await expect(
		page
			.getByRole('list', { name: 'Máquina de estados do cabo' })
			.locator('[data-state="connected"]')
	).toHaveAttribute('aria-current', 'step');
}

export async function openChecklist(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Levantar tampa do checklist', exact: true }).click();
	await page.getByRole('button', { name: 'Revisar e gravar', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Antes de gravar', exact: true });
	await expect(dialog).toBeVisible();
	return dialog;
}

export async function confirmBasics(dialog: Locator): Promise<void> {
	await dialog.getByRole('checkbox', { name: 'Abaixei o volume', exact: true }).check();
	await dialog.getByRole('checkbox', { name: /^Não vou desconectar durante a gravação/ }).check();
}

export async function closeChecklist(dialog: Locator): Promise<void> {
	await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
	await expect(dialog).not.toBeVisible();
}
