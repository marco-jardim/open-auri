import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { NEUTRO, PADRAO_AURI } from 'open-auri/catalog';
import { createWav } from '../../scripts/gen-fixtures.mjs';
import {
	AUDIO_FILE_NAME,
	audioSnapshot,
	iirChainLengths,
	installAudioProbe,
	loadSineFile,
	openAudio,
	startPreview
} from './helpers/c-audio';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

test.beforeEach(async ({ page }) => {
	await installAudioProbe(page);
	await page.goto('/');
});

async function storedAudio(page: Page) {
	return page.evaluate(async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('open-auri');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const record = await new Promise<unknown>((resolve, reject) => {
				const request = db.transaction('audio').objectStore('audio').get('current');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			if (record === undefined) return null;
			if (typeof record !== 'object' || record === null) throw new Error('Invalid stored audio');
			if (!('blob' in record) || !(record.blob instanceof Blob) || !('name' in record)) {
				throw new Error('Stored audio is missing its name or Blob');
			}
			const bytes = await record.blob.arrayBuffer();
			const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
			return {
				name: record.name,
				size: record.blob.size,
				type: record.blob.type,
				header: [...new Uint8Array(bytes).slice(0, 44)],
				sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
			};
		} finally {
			db.close();
		}
	});
}

test('440 Hz WAV persists across every Phase 2 route via IndexedDB', async ({ page }) => {
	test.setTimeout(90000);
	await loadSineFile(page);
	const wav = createWav();
	const expected = {
		name: AUDIO_FILE_NAME,
		size: wav.length,
		type: 'audio/wav',
		header: [...wav.subarray(0, 44)],
		sha256: createHash('sha256').update(wav).digest('hex')
	};
	await expect.poll(() => storedAudio(page)).toEqual(expected);

	// Full navigations deliberately destroy the JS singleton: only IndexedDB can restore the file.
	for (const route of [
		'/biblioteca',
		'/comparar',
		'/soe-como-x',
		'/teste-cego',
		'/cabo',
		'/docs',
		'/privacidade',
		'/termos',
		'/offline',
		'/'
	]) {
		await test.step(`restore audio on ${route}`, async () => {
			const response = await page.goto(route);
			expect(response?.ok()).toBe(true);
			await expect(page.locator('.oa-audio-name')).toHaveText(AUDIO_FILE_NAME);
			const popover = await openAudio(page);
			await expect(popover.locator('.oa-audio-meta')).toContainText(AUDIO_FILE_NAME);
			await expect(popover.locator('.oa-audio-meta')).toContainText('0:03');
			await expect(popover.locator('.oa-audio-warn, .oa-audio-error')).toHaveCount(0);
			expect(await storedAudio(page)).toEqual(expected);
		});
	}
});

test('file playback requests and runs a 96 kHz AudioContext', async ({ page }) => {
	await loadSineFile(page);
	const popover = await openAudio(page);
	await popover.getByRole('button', { name: 'Tocar arquivo', exact: true }).click();
	await expect(popover.getByRole('button', { name: 'Pausar', exact: true })).toBeVisible();
	await expect
		.poll(async () => (await audioSnapshot(page)).contexts)
		.toEqual([{ requestedRate: 96000, sampleRate: 96000, state: 'running' }]);
	expect((await audioSnapshot(page)).mediaSources).toBe(1);
	await expect(popover.locator('.oa-audio-rate')).toContainText('96 kHz');
	await expect(popover.locator('.oa-audio-error')).toHaveCount(0);
});

for (const preset of [PADRAO_AURI, NEUTRO]) {
	test(`IIR chains have one native section per non-OFF band: ${preset.label}`, async ({ page }) => {
		await loadSineFile(page);
		await page.keyboard.press('Escape');
		if (preset.id === 'neutro') {
			await page
				.locator('.ps-res')
				.getByRole('button', { name: /^Neutro/ })
				.click();
		} else {
			const selectPreset = page.locator('.ps-pre').getByRole('button', {
				name: preset.label,
				exact: true
			});
			await selectPreset.click();
			await expect(selectPreset).toHaveAttribute('aria-pressed', 'true');
		}
		await expect(page.locator('.np-name')).toHaveText(preset.label);
		const active = preset.bands.filter((band) => band.kind !== 'OFF').length;
		const referenceActive = PADRAO_AURI.bands.filter((band) => band.kind !== 'OFF').length;
		expect(referenceActive).toBe(10);
		await startPreview(page);
		const expected = [referenceActive, active].filter((count) => count > 0).sort((a, b) => a - b);
		await expect
			.poll(async () => iirChainLengths(await audioSnapshot(page)).sort((a, b) => a - b))
			.toEqual(expected);
		const snapshot = await audioSnapshot(page);
		expect(snapshot.iirs).toHaveLength(referenceActive + active);
		for (const section of snapshot.iirs) {
			expect(section.feedforward).toHaveLength(3);
			expect(section.feedback).toHaveLength(3);
			expect(section.feedback[0]).toBe(1);
			expect([...section.feedforward, ...section.feedback].every(Number.isFinite)).toBe(true);
		}
	});
}

test('A/B crossfades gains without rebuilding IIRs or the media source', async ({ page }) => {
	await loadSineFile(page);
	await startPreview(page);
	const baseline = await audioSnapshot(page);
	expect(baseline.mediaSources).toBe(1);
	const switches = page.getByRole('radiogroup', { name: 'A/B da prévia' });
	let previous = baseline;
	let outputIds: number[] = [];
	let previousAudible: number | undefined;
	for (const side of ['A', 'B', 'A', 'B']) {
		const radio = switches.getByRole('radio', { name: new RegExp(`^${side} ·`) });
		await radio.click();
		await expect(radio).toHaveAttribute('aria-checked', 'true');
		const after = await audioSnapshot(page);
		const ramps = after.ramps.slice(previous.ramps.length);
		expect(ramps).toHaveLength(2);
		expect(ramps.filter(({ value }) => value === 0)).toHaveLength(1);
		expect(ramps.filter(({ value }) => value > 0 && value <= 1)).toHaveLength(1);
		const audible = ramps.find(({ value }) => value > 0)?.node;
		if (previousAudible !== undefined) expect(audible).not.toBe(previousAudible);
		previousAudible = audible;
		const ids = ramps.map(({ node }) => node).sort((a, b) => a - b);
		if (outputIds.length === 0) outputIds = ids;
		expect(ids).toEqual(outputIds);
		await expect
			.poll(async () => {
				const current = await audioSnapshot(page);
				return ramps.every(({ node, value }) => {
					const gain = current.gains.find(({ id }) => id === node);
					return gain !== undefined && Math.abs(gain.value - value) < 1e-5;
				});
			})
			.toBe(true);
		expect(after.mediaSources).toBe(1);
		expect(after.mediaDisconnections).toBe(0);
		expect(after.iirs).toEqual(baseline.iirs);
		expect(after.gains.map(({ id }) => id)).toEqual(baseline.gains.map(({ id }) => id));
		expect(after.contexts).toEqual(baseline.contexts);
		previous = after;
	}
});

test('removing a file deletes IndexedDB and starts looping pink noise', async ({ page }) => {
	await loadSineFile(page);
	const popover = await openAudio(page);
	await popover.getByRole('button', { name: 'Tocar arquivo', exact: true }).click();
	await expect(popover.getByRole('button', { name: 'Pausar', exact: true })).toBeVisible();
	expect((await audioSnapshot(page)).buffers).toHaveLength(0);
	await popover.getByRole('button', { name: 'Remover', exact: true }).click();
	await expect(popover.locator('.oa-audio-meta')).toContainText('Nenhum arquivo: ruído rosa');
	await expect(page.locator('.oa-audio-name')).toHaveText('Áudio');
	await expect.poll(() => storedAudio(page)).toBeNull();
	await expect
		.poll(async () => (await audioSnapshot(page)).buffers)
		.toEqual([{ started: true, loop: true, channels: 1, frames: 96000 * 4, peak: 0.5 }]);
	const snapshot = await audioSnapshot(page);
	expect(snapshot.mediaSources).toBe(1);
	expect(snapshot.mediaDisconnections).toBe(1);
	expect(snapshot.contexts[0]?.state).toBe('running');
	await expect(popover.getByRole('button', { name: 'Pausar', exact: true })).toBeVisible();
	await expect(popover.locator('.oa-audio-error')).toHaveCount(0);
	await page.reload();
	await expect(page.locator('.oa-audio-name')).toHaveText('Áudio');
	await expect.poll(() => storedAudio(page)).toBeNull();
});
