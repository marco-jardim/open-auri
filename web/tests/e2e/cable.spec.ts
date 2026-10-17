import { readFile } from 'node:fs/promises';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { hidLog, installHidStub, type HidLog, type HidReport } from './helpers/b-hid';
import {
	apo,
	barNavLink,
	closeChecklist,
	confirmBasics,
	connectCable,
	downloadBytes,
	EXPERIMENTAL_WARNING,
	exportFile,
	FLASH_NOTICE,
	goToCable,
	importTxt,
	LOUDNESS_WARNING,
	openChecklist,
	openCurva
} from './helpers/b-ui';

test.use({ locale: 'pt-BR', reducedMotion: 'reduce' });
test.setTimeout(60_000);

// FUX.P6: the Cabo tour opens on a first desktop visit; these specs exercise the rack, not
// the tour, so it is marked as dismissed before any page script runs.
test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		const stored = localStorage.getItem('oa.tour.v1');
		const tours: Record<string, string> = stored ? JSON.parse(stored) : {};
		tours.cabo ??= 'dispensado';
		tours.curva ??= 'dispensado';
		localStorage.setItem('oa.tour.v1', JSON.stringify(tours));
	});
});

/** FUX.P6: the literal warning is always visible; its lamp says whether it is raised. */
function loudness(dialog: Locator): Locator {
	return dialog.locator('[data-loudness]');
}

interface ReferenceFixture {
	constants: { hidReportId: number; commitCommand: number[] };
	presets: { padrao: { reports: number[][] } };
}

interface JournalRecord {
	status: 'ok' | 'interrupted' | 'simulated';
	device: string;
	preampDb: number;
}

/** Read the pinned reference at test time, never derive expected bytes from the app's encoder. */
async function padraoReports(): Promise<number[][]> {
	const reference: ReferenceFixture = JSON.parse(
		await readFile(new URL('../../../test/fixtures/eq0xcb.reference.json', import.meta.url), 'utf8')
	);
	expect(reference.constants.hidReportId).toBe(0xcb);
	expect(reference.presets.padrao.reports).toHaveLength(9);
	const commit = Array<number>(31).fill(0);
	commit.splice(0, reference.constants.commitCommand.length, ...reference.constants.commitCommand);
	expect(commit.slice(0, 5)).toEqual([0x01, 0x65, 0x00, 0x01, 0xff]);
	return [...reference.presets.padrao.reports, commit];
}

async function openCable(page: Page): Promise<void> {
	await page.goto('/cabo');
	await expect(
		page.getByRole('button', { name: 'Levantar tampa do checklist', exact: true })
	).toBeEnabled();
}

async function loadPadrao(page: Page): Promise<void> {
	await page
		.getByRole('combobox', { name: 'Carregar preset no editor (não grava)', exact: true })
		.selectOption('padrao');
}

function writeButton(dialog: Locator): Locator {
	return dialog.getByRole('button', { name: 'Gravar no cabo', exact: true });
}

async function writeConfirmed(dialog: Locator): Promise<void> {
	await confirmBasics(dialog);
	await expect(writeButton(dialog)).toBeEnabled();
	await writeButton(dialog).click();
	await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
}

async function exportedJournal(page: Page): Promise<JournalRecord[]> {
	const download = await exportFile(page, 'Exportar diário');
	return JSON.parse((await downloadBytes(download)).toString('utf8'));
}

async function editPreampThroughFile(page: Page, preampDb: number): Promise<void> {
	await (await barNavLink(page, 'Curva')).click();
	await importTxt(page, apo(preampDb));
	await goToCable(page);
}

function expectBytes(reports: HidReport[], expected: number[][]): void {
	expect(reports.map((report) => report.reportId)).toEqual(expected.map(() => 0xcb));
	expect(reports.map((report) => report.bytes)).toEqual(expected);
	for (const report of reports) expect(report.bytes).toHaveLength(31);
}

function expectDelay(actual: number, nominal: number, label: string): void {
	expect(actual, `${label}: ${actual.toFixed(3)} ms`).toBeGreaterThanOrEqual(nominal - 8);
	expect(actual, `${label}: ${actual.toFixed(3)} ms`).toBeLessThanOrEqual(nominal + 8);
}

function expectSendGap(log: HidLog, from: number, to: number, delays: number[]): void {
	const previous = log.reports[from];
	const next = log.reports[to];
	// Zero-delay macrotasks (including guardIo's abort grace) are not protocol waits.
	const timers = log.timers.filter(
		(timer) =>
			timer.delayMs !== 0 &&
			timer.scheduledAt >= previous.at &&
			timer.scheduledAt < next.at &&
			timer.firedAt !== null &&
			timer.firedAt <= next.at
	);
	// Wrong, missing or extra waits still fail, independently of browser scheduling load.
	expect(
		timers.map((timer) => timer.delayMs),
		`waits between sends ${from} → ${to}`
	).toEqual(delays);
	const timerLateness = timers.reduce(
		(sum, timer) => sum + Math.max(0, (timer.firedAt ?? 0) - timer.scheduledAt - timer.delayMs),
		0
	);
	const rawGap = next.at - previous.at;
	// Native setTimeout callbacks can arrive late under parallel axe/rendering work. Subtract
	// only independently observed callback lateness, never app work before/after the timer.
	// Report timestamps remain real performance.now() values; no clocks or delays are faked.
	expectDelay(
		rawGap - timerLateness,
		delays.reduce((sum, delay) => sum + delay, 0),
		`sends ${from} → ${to} (raw ${rawGap.toFixed(3)} ms, timer lateness ${timerLateness.toFixed(3)} ms)`
	);
}

test('padrao: mandatory checklist, exact bytes, and USB timing (±8 ms)', async ({ page }) => {
	const expected = await padraoReports();
	await installHidStub(page, { recordTimers: true });
	await openCable(page);
	await loadPadrao(page);
	await connectCable(page);
	expect((await hidLog(page)).requests).toEqual([
		{ filters: [{ vendorId: 0x3302, productId: 0x8902 }] }
	]);
	expect((await hidLog(page)).reports).toEqual([]);
	const dialog = await openChecklist(page);
	await expect(dialog.locator('[data-lamp]')).toHaveCount(8);
	await expect(dialog.locator('[data-lamp]:not([data-state="ok"])')).toHaveCount(0);
	await expect(dialog.getByText(LOUDNESS_WARNING, { exact: true })).toBeVisible();
	await expect(loudness(dialog)).toHaveAttribute('data-loudness', 'warn');
	await expect(dialog.getByText(/^O estado do cabo é desconhecido:/)).toBeVisible();
	const write = writeButton(dialog);
	const volume = dialog.getByRole('checkbox', { name: 'Abaixei o volume', exact: true });
	const connected = dialog.getByRole('checkbox', { name: /^Não vou desconectar/ });
	await expect(write).toBeDisabled();
	await volume.check();
	await expect(write).toBeDisabled();
	await volume.uncheck();
	await connected.check();
	await expect(write).toBeDisabled();
	await volume.check();
	await expect(write).toBeEnabled();
	expect((await hidLog(page)).reports).toEqual([]);
	await write.click();
	await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
	const log = await hidLog(page);
	await test.info().attach('hid-timing.json', {
		body: JSON.stringify(log, null, 2),
		contentType: 'application/json'
	});
	const { reports } = log;
	expectBytes(reports, expected);
	expect(reports.map((report) => report.device)).toEqual(Array<number>(10).fill(0));
	for (let index = 1; index < 9; index += 1) {
		expectSendGap(log, index - 1, index, [16]);
	}
	// The protocol also pauses 16 ms AFTER report 8, then settles for another 150 ms.
	expectSendGap(log, 8, 9, [16, 150]);
	await expect(volume).not.toBeChecked();
	await expect(connected).not.toBeChecked();
	await expect(write).toBeDisabled();
	await closeChecklist(dialog);
	await expect(page.locator('#main-content li[data-status="ok"]')).toHaveCount(1);
	expect(await exportedJournal(page)).toEqual([
		expect.objectContaining({ status: 'ok', device: 'USB DSP Audio', preampDb: -2.8 })
	]);
});

for (const sample of [
	{ kind: 'HS', filter: 'HSC Fc 8000 Hz Gain -3 dB Q 0.7' },
	{ kind: 'LP', filter: 'LPQ Fc 1000 Hz Q 0.7' },
	{ kind: 'HP', filter: 'HPQ Fc 1000 Hz Q 0.7' }
] as const) {
	test(`${sample.kind} requires experimental write confirmation`, async ({ page }) => {
		await installHidStub(page);
		await openCurva(page, 'engenharia');
		await importTxt(page, apo(-1, sample.filter));
		await goToCable(page);
		await connectCable(page);
		const dialog = await openChecklist(page);
		await expect(
			dialog.getByRole('heading', { name: 'Curva experimental', exact: true })
		).toBeVisible();
		await expect(dialog.getByText(EXPERIMENTAL_WARNING, { exact: true })).toBeVisible();
		await confirmBasics(dialog);
		await expect(writeButton(dialog)).toBeDisabled();
		expect((await hidLog(page)).reports).toEqual([]);
		await dialog
			.getByRole('checkbox', {
				name: 'Entendi e quero gravar esta curva experimental',
				exact: true
			})
			.check();
		await expect(writeButton(dialog)).toBeEnabled();
		await writeButton(dialog).click();
		await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
		expect((await hidLog(page)).reports).toHaveLength(10);
	});
}

test('loudness: first write and +3 dB, but not repeats or +2.9 dB', async ({ page }) => {
	await installHidStub(page);
	await openCurva(page);
	await importTxt(page, apo(-6.5));
	await goToCable(page);
	await connectCable(page);
	let dialog = await openChecklist(page);
	await expect(dialog.getByText(LOUDNESS_WARNING, { exact: true })).toBeVisible();
	await expect(loudness(dialog)).toHaveAttribute('data-loudness', 'warn');
	await writeConfirmed(dialog);
	await closeChecklist(dialog);

	// The literal text stays on screen (spec §4.3); the warning is raised only by the policy.
	dialog = await openChecklist(page);
	await expect(dialog.getByText(LOUDNESS_WARNING, { exact: true })).toBeVisible();
	await expect(loudness(dialog)).toHaveAttribute('data-loudness', 'calm');
	await closeChecklist(dialog);
	await editPreampThroughFile(page, -3.6);
	dialog = await openChecklist(page);
	await expect(loudness(dialog)).toHaveAttribute('data-loudness', 'calm');
	await closeChecklist(dialog);
	await editPreampThroughFile(page, -3.5);
	dialog = await openChecklist(page);
	await expect(dialog.getByText(LOUDNESS_WARNING, { exact: true })).toBeVisible();
	await expect(loudness(dialog)).toHaveAttribute('data-loudness', 'warn');
	await expect(
		dialog.getByText('Diferença estimada de +3,0 dB em relação à última curva gravada.', {
			exact: true
		})
	).toBeVisible();
	await expect(dialog.getByText(/^O estado do cabo é desconhecido:/)).toHaveCount(0);
	expect((await hidLog(page)).reports).toHaveLength(10);
	await writeConfirmed(dialog);
	expect((await hidLog(page)).reports).toHaveLength(20);
});

test('fresh confirmations cannot bypass the 2 s wait between writes', async ({ page }) => {
	await installHidStub(page);
	await openCable(page);
	await connectCable(page);
	const dialog = await openChecklist(page);
	await writeConfirmed(dialog);
	await confirmBasics(dialog);
	await expect(dialog.getByText(/^Aguarde [\d,]+ s entre gravações$/)).toBeVisible();
	await expect(writeButton(dialog)).toBeDisabled();
	expect((await hidLog(page)).reports).toHaveLength(10);
	await expect(writeButton(dialog)).toBeEnabled({ timeout: 5000 });
	// Expiring the cooldown must not itself send anything.
	expect((await hidLog(page)).reports).toHaveLength(10);
	await writeButton(dialog).click();
	await expect.poll(async () => (await hidLog(page)).reports.length).toBe(20);
	await expect(dialog.getByRole('status')).toHaveText(/^Gravado no cabo\. CRC /);
	const { reports } = await hidLog(page);
	// Flash timestamps have integer-ms precision; allow that single millisecond of quantization.
	expect(reports[10].at - reports[9].at).toBeGreaterThanOrEqual(1999);
});

test('50 writes today: flash-life notice, not a hard limit', async ({ page }) => {
	await installHidStub(page);
	await page.addInitScript(() => {
		const now = new Date();
		const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
			.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
			.join('-');
		localStorage.setItem('oa.flash.day', JSON.stringify({ date, count: 50 }));
		localStorage.setItem('oa.flash.total', '50');
		localStorage.setItem('oa.flash.lastWriteAt', String(Date.now() - 3000));
	});
	await openCable(page);
	await connectCable(page);
	const dialog = await openChecklist(page);
	await expect(dialog.getByRole('note')).toHaveText(FLASH_NOTICE);
	const today = dialog.getByRole('term').filter({ hasText: /^hoje$/ });
	await expect(today.locator('..').getByRole('definition')).toHaveText('50');
	await writeConfirmed(dialog);
	await expect(today.locator('..').getByRole('definition')).toHaveText('51');
	expect((await hidLog(page)).reports).toHaveLength(10);
});

test('disconnect at report k: interrupted journal, no commit, rescue', async ({ page }) => {
	const expected = await padraoReports();
	const k = 4;
	await installHidStub(page, { disconnectAtReport: k });
	await openCable(page);
	await loadPadrao(page);
	await connectCable(page);
	const dialog = await openChecklist(page);
	await confirmBasics(dialog);
	await expect(writeButton(dialog)).toBeEnabled();
	await writeButton(dialog).click();
	await expect(dialog.getByRole('status')).toHaveText('A gravação foi interrompida.');
	const log = await hidLog(page);
	expectBytes(log.reports, expected.slice(0, k));
	expect(log.disconnects).toHaveLength(1);
	expect(log.disconnects[0].device).toBe(0);
	expect(
		log.reports.some((report) => report.bytes.every((byte, index) => byte === expected[9][index]))
	).toBe(false);
	await closeChecklist(dialog);
	const rescue = page.getByRole('region', { name: 'Gravação interrompida', exact: true });
	const rescueText =
		'O estado do cabo é desconhecido. Grave o Neutro ou uma curva conhecida antes de continuar ouvindo.';
	await expect(rescue).toBeVisible();
	// Interrupted in this session: the body is announced as an alert.
	await expect(rescue.getByRole('alert')).toHaveText(rescueText);
	await expect(rescue.getByRole('button', { name: 'Gravar Neutro', exact: true })).toBeVisible();
	await expect(page.locator('#main-content li[data-status="interrupted"]')).toHaveCount(1);
	expect(await exportedJournal(page)).toEqual([
		expect.objectContaining({ status: 'interrupted', device: 'USB DSP Audio' })
	]);
	await page.reload();
	await expect(rescue).toBeVisible();
	// Restored from the journal on load: a polite status, not a re-announced alert.
	await expect(rescue.getByRole('status')).toHaveText(rescueText);
	await expect(rescue.getByRole('alert')).toHaveCount(0);
	expect((await hidLog(page)).reports).toEqual([]);
});

test('X9 reviews two cables and writes complete sequences in order', async ({ page }) => {
	const expected = await padraoReports();
	await installHidStub(page, { devices: 2 });
	await openCable(page);
	await loadPadrao(page);
	await connectCable(page);
	await page.getByRole('button', { name: 'Adicionar outro cabo', exact: true }).click();
	expect((await hidLog(page)).requests).toHaveLength(2);
	const dialog = await openChecklist(page);
	const queue = dialog.getByRole('region', { name: 'Vários cabos em sequência', exact: true });
	await expect(queue.getByRole('checkbox', { name: 'USB DSP Audio', exact: true })).toBeChecked();
	await expect(
		queue.getByRole('checkbox', { name: 'USB DSP Audio #2', exact: true })
	).toBeChecked();
	await expect(queue.getByRole('button', { name: 'Revisar fila', exact: true })).toBeDisabled();
	await confirmBasics(dialog);
	await expect(queue.getByRole('button', { name: 'Revisar fila', exact: true })).toBeEnabled();
	await queue.getByRole('button', { name: 'Revisar fila', exact: true }).click();
	await expect(queue.getByRole('heading', { name: 'Confirme a fila', exact: true })).toBeVisible();
	await expect(queue.getByRole('listitem')).toHaveText(['USB DSP Audio', 'USB DSP Audio #2']);
	expect((await hidLog(page)).reports).toEqual([]);
	await queue.getByRole('button', { name: 'Confirmar e gravar em 2 cabos', exact: true }).click();
	await expect(queue.locator('li[data-status="ok"]')).toHaveCount(2, { timeout: 10_000 });
	const { reports } = await hidLog(page);
	expect(reports.map((report) => report.device)).toEqual([
		...Array<number>(10).fill(0),
		...Array<number>(10).fill(1)
	]);
	expectBytes(reports.slice(0, 10), expected);
	expectBytes(reports.slice(10), expected);
	expect(reports[10].at - reports[9].at).toBeGreaterThanOrEqual(1999);
	await closeChecklist(dialog);
	expect(await exportedJournal(page)).toEqual([
		expect.objectContaining({ status: 'ok', device: 'USB DSP Audio' }),
		expect.objectContaining({ status: 'ok', device: 'USB DSP Audio #2' })
	]);
});

test('missing navigator.hid: simulated label and no hardware reports', async ({ page }) => {
	await installHidStub(page, { absent: true });
	await openCable(page);
	await expect(
		page.getByText('SIMULADO · nenhum report é enviado ao cabo real', { exact: true })
	).toBeVisible();
	await connectCable(page, true);
	const dialog = await openChecklist(page);
	await expect(dialog.getByText('simulado', { exact: true })).toBeVisible();
	const write = dialog.getByRole('button', { name: 'Gravar (simulado)', exact: true });
	await expect(write).toBeDisabled();
	await confirmBasics(dialog);
	await expect(write).toBeEnabled();
	await write.click();
	await expect(dialog.getByRole('status')).toHaveText(
		/^Gravação simulada concluída\..*Nada foi enviado a um cabo\.$/
	);
	await closeChecklist(dialog);
	await expect(page.locator('#main-content li[data-status="simulated"]')).toHaveCount(1);
	expect(await exportedJournal(page)).toEqual([
		expect.objectContaining({ status: 'simulated', device: expect.stringContaining('simulado') })
	]);
	const log = await hidLog(page);
	expect(log.reports).toEqual([]);
	expect(log.requests).toEqual([]);
});
