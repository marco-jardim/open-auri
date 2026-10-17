import { expect, test } from '@playwright/test';
import { createWav } from '../../scripts/gen-fixtures.mjs';
import {
	audioSnapshot,
	installAudioProbe,
	loadSineFile,
	openAudio,
	startPreview
} from './helpers/c-audio';
import {
	idleMeterMutations,
	meterModuleUrl,
	renderMeters,
	type TimedMeterFrame
} from './helpers/c-meters';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

// The offline harness loads a blob clock module, not application code at a synthetic HTTP route.
// Keep production CSP enforced for all live UI/rest cases and for audio.spec.ts.
const offline = test.extend({ bypassCSP: true });

test.beforeEach(async ({ page }) => {
	await installAudioProbe(page);
	await page.goto('/?camada=engenharia');
	await expect(page.locator('.preview-row button.bat')).toBeEnabled();
});

function lastFrame(frames: TimedMeterFrame[]): TimedMeterFrame {
	expect(frames.length, 'the real AudioWorklet must deliver frames').toBeGreaterThan(0);
	const last = frames.at(-1);
	if (!last) throw new Error('No meter frame received');
	return last;
}

for (const sampleRate of [48000, 96000]) {
	offline(`1 kHz at −18 dBFS reads 0 VU ±0.2 (${sampleRate} Hz)`, async ({ page }) => {
		const moduleUrl = await meterModuleUrl(page);
		const result = await renderMeters(page, moduleUrl, { sampleRate, kinds: ['vu'] });
		expect(result.sampleRate).toBe(sampleRate);
		const settled = result.frames.filter((frame) => frame.seconds >= 1.5);
		expect(settled.length).toBeGreaterThanOrEqual(25);
		for (const frame of settled) {
			expect(frame.active).toBe(true);
			expect(Math.abs(frame.vuL)).toBeLessThanOrEqual(0.2);
			expect(Math.abs(frame.vuR)).toBeLessThanOrEqual(0.2);
		}
	});

	offline(`VU amplitude step reaches 99% in 300 ms ±10% (${sampleRate} Hz)`, async ({ page }) => {
		const moduleUrl = await meterModuleUrl(page);
		// A tone switched on at sample zero is a step in the rectified envelope, not a DC signal.
		const { frames } = await renderMeters(page, moduleUrl, { sampleRate, kinds: ['vu'] });
		const final = lastFrame(frames);
		for (const channel of ['vuL', 'vuR'] as const) {
			const deflection = (frame: TimedMeterFrame) => 10 ** ((frame[channel] - final[channel]) / 20);
			const crossing = frames.find((frame) => deflection(frame) >= 0.99);
			expect(crossing, `${channel} must reach 99%`).toBeDefined();
			if (!crossing) throw new Error(`${channel} did not reach 99%`);
			expect(crossing.seconds).toBeGreaterThanOrEqual(0.27);
			expect(crossing.seconds).toBeLessThanOrEqual(0.33);
			const previous = frames[frames.indexOf(crossing) - 1];
			expect(previous).toBeDefined();
			if (previous) expect(deflection(previous)).toBeLessThan(0.99);
			const overshoot = Math.max(...frames.map(deflection)) - 1;
			expect(overshoot).toBeGreaterThanOrEqual(0.01);
			expect(overshoot).toBeLessThanOrEqual(0.015);
		}
	});

	offline(`PPM I/II integrate 5/10 ms bursts (${sampleRate} Hz)`, async ({ page }) => {
		const moduleUrl = await meterModuleUrl(page);
		for (const ppmType of ['I', 'II'] as const) {
			const steady = await renderMeters(page, moduleUrl, {
				sampleRate,
				frequency: 5000,
				dbfs: 20 * Math.log10(0.5),
				seconds: 1,
				kinds: ['ppm'],
				ppmType
			});
			const reference = lastFrame(steady.frames);
			expect(Math.abs(reference.ppmL - 20 * Math.log10(0.5))).toBeLessThanOrEqual(0.2);
			for (const burstSeconds of [0.005, 0.01]) {
				const burst = await renderMeters(page, moduleUrl, {
					sampleRate,
					frequency: 5000,
					dbfs: 20 * Math.log10(0.5),
					seconds: 0.25,
					burstSeconds,
					kinds: ['ppm'],
					ppmType
				});
				const target =
					ppmType === 'I' ? (burstSeconds === 0.005 ? -2 : -1) : burstSeconds === 0.005 ? -4 : -2;
				// Burst-table tolerances from core conformance; ≤ one 60 Hz interval of decay adds <0.2 dB.
				const tolerance = burstSeconds === 0.005 ? 0.75 : 0.5;
				expect(burst.frames.some((frame) => frame.active)).toBe(true);
				for (const channel of ['ppmL', 'ppmR'] as const) {
					const peak = Math.max(...burst.frames.map((frame) => frame[channel]));
					const relative = peak - reference[channel];
					expect(Math.abs(relative - target)).toBeLessThanOrEqual(tolerance);
					expect(relative).toBeLessThan(-0.4);
				}
				// One inactive frame, then no decorative updates for the remaining silent render time.
				expect(burst.frames.filter((frame) => !frame.active)).toHaveLength(1);
				expect(lastFrame(burst.frames).active).toBe(false);
				expect(lastFrame(burst.frames).seconds).toBeLessThan(0.06);
			}
		}
	});

	offline(`true peak detects a crest between samples (${sampleRate} Hz)`, async ({ page }) => {
		const moduleUrl = await meterModuleUrl(page);
		const result = await renderMeters(page, moduleUrl, {
			sampleRate,
			frequency: sampleRate / 4,
			phase: Math.PI / 4,
			dbfs: 20 * Math.log10(0.5),
			seconds: 1,
			kinds: ['truePeak']
		});
		const settled = result.frames.filter((frame) => frame.seconds >= 0.2 && frame.seconds <= 0.9);
		expect(settled.length).toBeGreaterThan(30);
		expect(Math.abs(result.samplePeakDb - 20 * Math.log10(0.5 / Math.SQRT2))).toBeLessThan(0.01);
		for (const frame of settled) {
			expect(frame.truePeakDb).toBeGreaterThan(result.samplePeakDb + 2.5);
			expect(Math.abs(frame.truePeakDb - 20 * Math.log10(0.5))).toBeLessThanOrEqual(0.1);
		}
	});

	offline(`mono +1 / inverted −1 correlation (${sampleRate} Hz)`, async ({ page }) => {
		const moduleUrl = await meterModuleUrl(page);
		for (const signal of [
			{ channels: 1, inverted: false, expected: 1 },
			{ channels: 2, inverted: false, expected: 1 },
			{ channels: 2, inverted: true, expected: -1 }
		] as const) {
			const { frames } = await renderMeters(page, moduleUrl, {
				sampleRate,
				channels: signal.channels,
				inverted: signal.inverted,
				seconds: 1,
				kinds: ['correlation']
			});
			const settled = frames.filter((frame) => frame.seconds >= 0.5);
			expect(settled.length).toBeGreaterThanOrEqual(25);
			for (const frame of settled) {
				expect(frame.active).toBe(true);
				expect(Math.abs(frame.correlation - signal.expected)).toBeLessThanOrEqual(0.001);
			}
		}
	});
}

offline('a silent offline signal produces no worklet meter updates', async ({ page }) => {
	const moduleUrl = await meterModuleUrl(page);
	const { frames } = await renderMeters(page, moduleUrl, { silence: true, seconds: 2 });
	expect(frames).toEqual([]);
});

test('idle meters show DADOS with zero DOM mutations over 2 s', async ({ page }) => {
	const meters = page.locator('main [data-mode]');
	await expect(page.locator('.bank')).toBeVisible();
	await expect(page.locator('.ps-out .meter')).toHaveAttribute('role', 'meter');
	expect(await meters.count()).toBeGreaterThan(10);
	await expect(page.locator('main [data-mode]:not([data-mode="data"])')).toHaveCount(0);
	for (const label of await page.locator('main .oa-meter-mode').all()) {
		await expect(label).toHaveText('DADOS');
	}
	expect((await audioSnapshot(page)).contexts).toEqual([]);
	const result = await idleMeterMutations(page);
	expect(result.elements).toBeGreaterThan(10);
	expect(result.count).toBe(0);
});

test('a running silent WAV stays in DADOS with zero meter mutations over 2 s', async ({ page }) => {
	const popover = await openAudio(page);
	await popover.locator('input[type="file"]').setInputFiles({
		name: 'silence.wav',
		mimeType: 'audio/wav',
		buffer: createWav({ silence: true })
	});
	await expect(popover.locator('.oa-audio-meta')).toContainText('0:03');
	await startPreview(page);
	await expect.poll(async () => (await audioSnapshot(page)).mediaSources).toBe(1);
	expect((await audioSnapshot(page)).contexts[0]?.state).toBe('running');
	await expect(page.locator('main [data-mode]:not([data-mode="data"])')).toHaveCount(0);
	expect((await idleMeterMutations(page)).count).toBe(0);
});

test('Biblioteca VU is metered pre-volume (AO VIVO) and follows the global 0 VU reference', async ({
	page
}) => {
	await page.goto('/biblioteca');
	const bridge = page.locator('section.console');
	await expect(bridge).toHaveAttribute('data-mode', 'data');
	await loadSineFile(page);
	const popover = await openAudio(page);
	// The raw preview from the global popover: a user gesture, as in the real flow.
	await popover.locator('.oa-audio-row button').first().click();
	await expect(bridge).toHaveAttribute('data-mode', 'live');
	await expect(bridge.locator('.mode')).toHaveText('AO VIVO');
	const vu = bridge.locator('.oa-vu').first();
	await expect(vu).toHaveAttribute('data-mode', 'live');
	const reading = async () => Number(await vu.getAttribute('aria-valuenow'));
	// 440 Hz at −18 dBFS reads about 0 VU with the default −18 dBFS reference.
	await expect.poll(reading, { timeout: 5000 }).toBeGreaterThan(-1);
	await expect.poll(reading).toBeLessThan(1);
	const before = await reading();

	const volume = popover.getByRole('slider');
	await volume.fill('-40');
	await expect(volume).toHaveAttribute('aria-valuetext', '−40 dB');
	// Pre-volume: −40 dB of preview volume would move a post-volume VU by ~40; here the reading only
	// has to stay within 1 VU (ballistics, throttled readout and audio-thread underruns when the e2e
	// suite runs 8 browsers in parallel; a dependency on the volume would be ~40× larger).
	await expect(bridge.locator('.mode')).toHaveText('AO VIVO');
	await expect
		.poll(async () => Math.abs((await reading()) - before), { timeout: 5000 })
		.toBeLessThanOrEqual(1);
	await volume.fill('0');
	await expect
		.poll(async () => Math.abs((await reading()) - before), { timeout: 5000 })
		.toBeLessThanOrEqual(1);

	// 0 VU at −20 dBFS: the same −18 dBFS tone reads about +2 VU on every tap.
	await popover.getByRole('radio', { name: '−20 dBFS' }).check();
	// The needle overshoots briefly on the 2 dB step (IEC ballistics); wait for it to settle.
	await expect
		.poll(async () => Math.abs((await reading()) - before - 2), { timeout: 5000 })
		.toBeLessThanOrEqual(0.5);
	await popover.getByRole('radio', { name: '−18 dBFS' }).check();
	await expect
		.poll(async () => Math.abs((await reading()) - before), { timeout: 5000 })
		.toBeLessThanOrEqual(1);
});

test('stopping audio returns meters to DADOS and leaves the DOM at rest', async ({ page }) => {
	await loadSineFile(page);
	await startPreview(page);
	await expect(page.locator('.ps-out .meter')).toHaveAttribute('data-mode', 'live');
	await page.locator('.preview-row button.bat').click();
	await expect(page.locator('.preview-row button.bat')).toHaveAttribute('aria-pressed', 'false');
	await expect(page.locator('main [data-mode]:not([data-mode="data"])')).toHaveCount(0);
	// The throttled numeric readout may settle once after mode changes; do not include that in rest.
	await expect(page.locator('.ps-out .meter')).toHaveAttribute('aria-valuenow', '-0.5');
	expect((await idleMeterMutations(page)).count).toBe(0);
});
