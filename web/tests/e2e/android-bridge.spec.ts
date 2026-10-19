import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect, cableInfo, type FakeAndroidNative } from './fixtures/capacitor-bridge';
import { closeChecklist, confirmBasics, connectCable, openChecklist } from './helpers/b-ui';

// Uses the normal preview server and runs in both desktop and mobile projects. Each test gets
// Playwright's fresh context/storage and a new native state machine, not a mocked core runtime.
test.use({ locale: 'pt-BR', reducedMotion: 'reduce' });
test.setTimeout(60_000);

const TITLE = 'Gravação pelo app ainda não testada num cabo';
const BANNER =
	'Gravação pelo app ainda não testada num cabo real. Em teoria funciona igual ao computador.';
const ANDROID_CONFIRM =
	'Entendo que a gravação pelo app Android ainda não foi testada num cabo real.';
const SIMULATED = 'SIMULADO · nenhum report é enviado ao cabo real';
const POLICY =
	'A gravação pelo app está desligada no momento. Use o site no computador (Chrome ou Edge) ou atualize o app.';
const COMMIT = [0x01, 0x65, 0x00, 0x01, 0xff, ...Array<number>(26).fill(0)];

function notice(page: Page): Locator {
	return page.getByRole('dialog', { name: TITLE, exact: true });
}

async function acknowledge(page: Page): Promise<void> {
	await expect(notice(page)).toBeVisible();
	await notice(page).getByRole('button', { name: 'Entendi', exact: true }).click();
	await expect(notice(page)).not.toBeVisible();
}

async function openApp(page: Page, path = '/cabo'): Promise<void> {
	await page.goto(path);
	await acknowledge(page);
	if (path === '/cabo')
		await expect(
			page.getByRole('button', { name: 'Levantar tampa do checklist', exact: true })
		).toBeEnabled();
}

async function connectAndroid(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Conectar pelo USB do Android', exact: true }).click();
	await expect(
		page
			.getByRole('list', { name: 'Máquina de estados do cabo' })
			.locator('[data-state="connected"]')
	).toHaveAttribute('aria-current', 'step');
}

function androidItem(dialog: Locator): Locator {
	return dialog.getByRole('checkbox', { name: ANDROID_CONFIRM, exact: true });
}

function writeButton(dialog: Locator): Locator {
	return dialog.getByRole('button', { name: 'Gravar no cabo', exact: true });
}

async function confirmAndroid(dialog: Locator): Promise<void> {
	await confirmBasics(dialog);
	await androidItem(dialog).check();
}

async function loadPadrao(page: Page): Promise<void> {
	await page
		.getByRole('combobox', { name: 'Carregar preset no editor (não grava)', exact: true })
		.selectOption('padrao');
}

async function expectedPadrao(): Promise<number[][]> {
	const reference: { presets: { padrao: { reports: number[][] } } } = JSON.parse(
		await readFile(new URL('../../../test/fixtures/eq0xcb.reference.json', import.meta.url), 'utf8')
	);
	return [...reference.presets.padrao.reports, COMMIT];
}

function expectNoNativeIo(native: FakeAndroidNative): void {
	expect(
		native.calls.filter(({ methodName }) =>
			['requestDevice', 'open', 'sendReport'].includes(methodName)
		)
	).toEqual([]);
	expect(native.reports).toEqual([]);
}

test('first use: G.1 consent persists after reload; G.2 banner remains on Cabo', async ({
	page,
	nativeBridge
}) => {
	await page.goto('/cabo');
	await expect(notice(page)).toBeVisible();
	await expect(notice(page)).toContainText('Só muda o caminho até o USB.');
	await acknowledge(page);
	await expect(page.getByRole('complementary', { name: TITLE, exact: true })).toHaveText(
		new RegExp(BANNER.replaceAll('.', '\\.'))
	);
	await page.reload();
	await expect(page.getByText('App Android v1.0.0, USB host OK', { exact: true })).toBeVisible();
	await expect(notice(page)).not.toBeVisible();
	await expect(page.getByText(BANNER, { exact: true })).toBeVisible();
	expect(nativeBridge.calls.filter(({ methodName }) => methodName === 'getInfo')).toHaveLength(2);
	expectNoNativeIo(nativeBridge);
});

test('real core + native bridge: Android confirmation gates a byte-exact write and labelled journal', async ({
	page,
	nativeBridge
}) => {
	await openApp(page);
	await loadPadrao(page);
	await connectAndroid(page);
	expect(
		nativeBridge.calls.find(({ methodName }) => methodName === 'requestDevice')?.options
	).toEqual({ filters: [{ vendorId: 0x3302, productId: 0x8902 }] });
	const dialog = await openChecklist(page);
	await expect(dialog.locator('[data-confirmation="android-untested"]')).toHaveCount(1);
	await expect(androidItem(dialog)).not.toBeChecked();
	await confirmBasics(dialog);
	await expect(writeButton(dialog)).toBeDisabled();
	expect(nativeBridge.reports).toEqual([]);
	await androidItem(dialog).check();
	await expect(writeButton(dialog)).toBeEnabled();
	await androidItem(dialog).uncheck();
	await expect(writeButton(dialog)).toBeDisabled();
	await androidItem(dialog).check();
	await writeButton(dialog).click();
	await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
	expect(nativeBridge.reports.map(({ reportId }) => reportId)).toEqual(
		Array<number>(10).fill(0xcb)
	);
	expect(nativeBridge.reports.map(({ bytes }) => bytes)).toEqual(await expectedPadrao());
	expect(nativeBridge.reports[9].bytes).toEqual(COMMIT);
	expect(nativeBridge.calls.filter(({ methodName }) => methodName === 'sendReport')).toHaveLength(
		10
	);
	await expect(androidItem(dialog)).not.toBeChecked();
	await closeChecklist(dialog);
	await expect(page.locator('#main-content li[data-status="ok"]')).toHaveCount(1);
	await expect(page.locator('#main-content li[data-status="ok"]')).toContainText('USB DSP Audio');
});

test('Engineering diagnostics loads immediately after connect, before any write', async ({
	page,
	nativeBridge
}) => {
	await openApp(page, '/cabo?camada=engenharia');
	await connectAndroid(page);
	expect(nativeBridge.calls.filter(({ methodName }) => methodName === 'open')).toEqual([]);
	const diagnostics = page.getByRole('region', { name: 'Diagnóstico USB', exact: true });
	await diagnostics.getByRole('button', { name: 'Carregar diagnóstico USB', exact: true }).click();
	const json = diagnostics.locator('pre');
	await expect(json).toBeVisible();
	expect(JSON.parse((await json.textContent()) ?? '')).toMatchObject({
		device: cableInfo(),
		transfer: 'control',
		outputReports: [{ reportId: 0xcb, bytes: 31 }]
	});
	expect(
		nativeBridge.calls
			.filter(({ methodName }) => ['requestDevice', 'open', 'diagnostics'].includes(methodName))
			.map(({ methodName }) => methodName)
	).toEqual(['requestDevice', 'open', 'diagnostics']);
	expect(nativeBridge.reports).toEqual([]);
});

test('a revoked then re-granted native session can write again without a reload', async ({
	page,
	nativeBridge
}) => {
	await openApp(page);
	await loadPadrao(page);
	await connectAndroid(page);
	const dialog = await openChecklist(page);
	await confirmAndroid(dialog);
	await writeButton(dialog).click();
	await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
	expect(nativeBridge.reports.map(({ bytes }) => bytes)).toEqual(await expectedPadrao());

	nativeBridge.revokePermission(cableInfo());
	await confirmAndroid(dialog);
	await writeButton(dialog).click();
	await expect(dialog.getByRole('status')).toHaveText('A gravação foi interrompida.');
	expect(nativeBridge.reports).toHaveLength(10);
	expect(nativeBridge.calls.filter(({ methodName }) => methodName === 'sendReport')).toHaveLength(
		11
	);
	expect(nativeBridge.events).toEqual([]);

	nativeBridge.grantPermission(cableInfo());
	await confirmAndroid(dialog);
	await writeButton(dialog).click();
	await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
	expect(nativeBridge.calls.filter(({ methodName }) => methodName === 'open')).toHaveLength(2);
	expect(nativeBridge.reports.map(({ bytes }) => bytes)).toEqual([
		...(await expectedPadrao()),
		...(await expectedPadrao())
	]);
	expect(nativeBridge.reports[19].bytes).toEqual(COMMIT);
	await closeChecklist(dialog);
	await expect(page.locator('#main-content li[data-status="interrupted"]')).toHaveCount(1);
	await expect(page.locator('#main-content li[data-status="ok"]')).toHaveCount(2);
});

for (const fault of ['detach', 'timeout'] as const) {
	test.describe(fault, () => {
		test.use({
			nativeOptions: { faults: fault === 'detach' ? { detachAtReport: 4 } : { timeoutAtReport: 4 } }
		});
		test(`${fault} at report 4: interrupted outcome, no retry and no commit`, async ({
			page,
			nativeBridge
		}) => {
			await openApp(page);
			await loadPadrao(page);
			await connectAndroid(page);
			const dialog = await openChecklist(page);
			await confirmAndroid(dialog);
			await writeButton(dialog).click();
			await expect(dialog.getByRole('status')).toHaveText('A gravação foi interrompida.');
			expect(nativeBridge.reports.map(({ bytes }) => bytes)).toEqual(
				(await expectedPadrao()).slice(0, 4)
			);
			expect(
				nativeBridge.calls.filter(({ methodName }) => methodName === 'sendReport')
			).toHaveLength(5);
			expect(
				nativeBridge.reports.some(({ bytes }) =>
					bytes.every((byte, index) => byte === COMMIT[index])
				)
			).toBe(false);
			expect(nativeBridge.events.map(({ name }) => name)).toEqual(
				fault === 'detach' ? ['disconnect'] : []
			);
			await closeChecklist(dialog);
			await expect(
				page.getByRole('region', { name: 'Gravação interrompida', exact: true })
			).toBeVisible();
			await expect(page.locator('#main-content li[data-status="interrupted"]')).toHaveCount(1);
		});
	});
}

test.describe('permission denied', () => {
	test.use({ nativeOptions: { permission: 'denied' } });
	test('cancelled Android permission returns no device and sends nothing', async ({
		page,
		nativeBridge
	}) => {
		await openApp(page);
		const connect = page.getByRole('button', { name: 'Conectar pelo USB do Android', exact: true });
		await connect.click();
		await expect
			.poll(
				() => nativeBridge.calls.filter(({ methodName }) => methodName === 'requestDevice').length
			)
			.toBe(1);
		await expect(connect).toBeEnabled();
		await expect(page.getByRole('button', { name: 'Desconectar', exact: true })).toHaveCount(0);
		await expect(
			page
				.getByRole('list', { name: 'Máquina de estados do cabo' })
				.locator('[data-state="connected"]')
		).not.toHaveAttribute('aria-current', 'step');
		expect(
			nativeBridge.calls.filter(({ methodName }) => ['open', 'sendReport'].includes(methodName))
		).toEqual([]);
		expect(nativeBridge.reports).toEqual([]);
	});
});

test.describe('two cables', () => {
	test.use({ nativeOptions: { devices: [cableInfo(0), cableInfo(1)] } });
	test('one Android acknowledgement covers the reviewed queue, complete sequences stay ordered', async ({
		page,
		nativeBridge
	}) => {
		await openApp(page);
		await loadPadrao(page);
		await connectAndroid(page);
		await page.getByRole('button', { name: 'Adicionar outro cabo', exact: true }).click();
		const dialog = await openChecklist(page);
		const queue = dialog.getByRole('region', { name: 'Vários cabos em sequência', exact: true });
		await expect(queue.getByRole('checkbox', { name: 'USB DSP Audio', exact: true })).toBeChecked();
		await expect(
			queue.getByRole('checkbox', { name: 'USB DSP Audio #2', exact: true })
		).toBeChecked();
		await expect(androidItem(dialog)).toHaveCount(1);
		await confirmBasics(dialog);
		await expect(queue.getByRole('button', { name: 'Revisar fila', exact: true })).toBeDisabled();
		await androidItem(dialog).check();
		await queue.getByRole('button', { name: 'Revisar fila', exact: true }).click();
		await expect(queue.getByRole('listitem')).toHaveText(['USB DSP Audio', 'USB DSP Audio #2']);
		await queue.getByRole('button', { name: 'Confirmar e gravar em 2 cabos', exact: true }).click();
		await expect(queue.locator('li[data-status="ok"]')).toHaveCount(2, { timeout: 10_000 });
		expect(nativeBridge.reports.map(({ key }) => key)).toEqual([
			...Array<string>(10).fill(cableInfo(0).key),
			...Array<string>(10).fill(cableInfo(1).key)
		]);
		const expected = await expectedPadrao();
		expect(nativeBridge.reports.map(({ bytes }) => bytes)).toEqual([...expected, ...expected]);
		expect(nativeBridge.reports[10].at - nativeBridge.reports[9].at).toBeGreaterThanOrEqual(1999);
		await closeChecklist(dialog);
		await expect(page.locator('#main-content li[data-status="ok"]')).toHaveCount(2);
	});
});

test('YOLO: phrase consent and both per-write confirmations, one cable only', async ({
	page,
	nativeBridge
}) => {
	// YOLO is a local Engenharia flow, no account or auth-flow server is needed.
	await openApp(page);
	await connectAndroid(page);
	await page.goto('/?camada=engenharia');
	await page.getByRole('switch', { name: 'Modo YOLO', exact: true }).click();
	const consent = page.getByRole('dialog', { name: 'Ativar o Modo YOLO', exact: true });
	await consent.getByRole('textbox').fill('ASSUMO O RISCO');
	await consent.getByRole('button', { name: 'Ativar o Modo YOLO', exact: true }).click();
	await expect(consent).not.toBeVisible();
	await page.getByRole('main').getByRole('button', { name: 'Gravar no cabo', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Antes de gravar', exact: true });
	// The native permission survives navigation, so the real service restores this one cable.
	await expect(dialog.locator('[data-yolo-banner]')).toBeVisible();
	await expect(
		dialog.getByRole('region', { name: 'Vários cabos em sequência', exact: true })
	).toHaveCount(0);
	await confirmAndroid(dialog);
	await expect(writeButton(dialog)).toBeDisabled();
	await dialog.getByRole('checkbox', { name: /^Gravar curva YOLO:/ }).check();
	await expect(writeButton(dialog)).toBeEnabled();
	await writeButton(dialog).click();
	await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
	expect(nativeBridge.reports).toHaveLength(10);
	expect(new Set(nativeBridge.reports.map(({ key }) => key))).toEqual(new Set([cableInfo().key]));
	expect(nativeBridge.reports[9].bytes).toEqual(COMMIT);
});

for (const scenario of [
	{
		name: 'outdated bridgeApi 2',
		options: { bridgeApi: 2 },
		text: 'Atualize o app Android para conectar seu cabo. Enquanto isso, o modo simulado está disponível.'
	},
	{ name: 'policy-blocked invalid appVersion', options: { appVersion: 'x' }, text: POLICY },
	{
		name: 'no USB host (RF13)',
		options: { usbHost: false },
		text: 'Este aparelho não suporta USB host (OTG)'
	}
]) {
	test.describe(scenario.name, () => {
		test.use({ nativeOptions: scenario.options });
		test('notice, simulated mode, and zero native USB I/O', async ({ page, nativeBridge }) => {
			// ANDROID_WRITE_POLICY is a deploy-time constant. Invalid SemVer exercises its real
			// canWriteFromApp refusal without patching the bundle or bypassing native detection.
			await openApp(page);
			await expect(page.getByText(scenario.text, { exact: true })).toBeVisible();
			await expect(page.getByText(SIMULATED, { exact: true }).first()).toBeVisible();
			await connectCable(page, true);
			const dialog = await openChecklist(page);
			await confirmBasics(dialog);
			await dialog.getByRole('button', { name: 'Gravar (simulado)', exact: true }).click();
			await expect(dialog.getByRole('status')).toHaveText(
				/^Gravação simulada concluída\..*Nada foi enviado a um cabo\.$/
			);
			expectNoNativeIo(nativeBridge);
		});
	});
}

test('journal download uses OpenAuriFiles.save with exact filename, MIME and UTF-8 JSON', async ({
	page,
	nativeBridge
}) => {
	await openApp(page);
	await connectAndroid(page);
	const dialog = await openChecklist(page);
	await confirmAndroid(dialog);
	await writeButton(dialog).click();
	await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
	await closeChecklist(dialog);
	await page.getByRole('button', { name: 'Exportar diário', exact: true }).click();
	await expect
		.poll(
			() =>
				nativeBridge.calls.filter(
					({ pluginId, methodName }) => pluginId === 'OpenAuriFiles' && methodName === 'save'
				).length
		)
		.toBe(1);
	const save = nativeBridge.calls.find(
		({ pluginId, methodName }) => pluginId === 'OpenAuriFiles' && methodName === 'save'
	);
	expect(save?.options).toEqual({
		name: 'open-auri-journal.json',
		mime: 'application/json',
		base64: expect.any(String)
	});
	const entries: unknown = JSON.parse(
		Buffer.from(String(save?.options.base64), 'base64').toString('utf8')
	);
	expect(entries).toEqual([expect.objectContaining({ status: 'ok', device: 'USB DSP Audio' })]);
});

test.describe('Chrome Android without the bridge', () => {
	test.use({
		nativeOptions: { enabled: false },
		userAgent:
			'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
	});
	test('offers the app instead of pretending native USB is present', async ({
		page,
		nativeBridge
	}) => {
		await page.goto('/cabo');
		await expect(
			page.getByRole('complementary', { name: 'Conecte pelo app Android', exact: true })
		).toBeVisible();
		await expect(notice(page)).not.toBeVisible();
		await expect(page.getByText(BANNER, { exact: true })).toHaveCount(0);
		expect(nativeBridge.calls).toEqual([]);
	});
});

test.describe('desktop browser without the bridge', () => {
	test.use({
		nativeOptions: { enabled: false },
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
	});
	test('keeps the existing simulated flow, no Android modal, banner or checklist item', async ({
		page,
		nativeBridge
	}) => {
		await page.addInitScript(() => {
			Object.defineProperty(navigator, 'hid', { configurable: true, value: undefined });
			Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: undefined });
		});
		await page.goto('/cabo');
		await expect(
			page.getByRole('button', { name: 'Levantar tampa do checklist', exact: true })
		).toBeEnabled();
		await expect(notice(page)).not.toBeVisible();
		await expect(page.getByText(BANNER, { exact: true })).toHaveCount(0);
		await expect(
			page.getByRole('complementary', { name: 'Conecte pelo app Android', exact: true })
		).toHaveCount(0);
		await connectCable(page, true);
		const dialog = await openChecklist(page);
		await expect(androidItem(dialog)).toHaveCount(0);
		await confirmBasics(dialog);
		await expect(
			dialog.getByRole('button', { name: 'Gravar (simulado)', exact: true })
		).toBeEnabled();
		expect(nativeBridge.calls).toEqual([]);
	});
});
