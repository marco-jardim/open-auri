import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { encodeS1 } from 'open-auri/share';
import { NEUTRAL_CURVE } from '#lib/cable/service.ts';
import type { JournalEntry } from '#lib/cable/types.ts';
import { rememberOrigin, type OriginsStorage } from '#lib/social/origins.ts';
import SocialStatus from '#lib/components/pages/cabo/SocialStatus.svelte';

function memoryStorage(): OriginsStorage {
	const map = new Map<string, string>();
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value)
	};
}

const bands = NEUTRAL_CURVE.bands.map((band) => ({ ...band }));
const preampDb = NEUTRAL_CURVE.preampDb;

function entry(status: JournalEntry['status'], name = 'Comunitaria'): JournalEntry {
	return { schema: 1, at: 1, name, crc: 0x4fff, preampDb, bands, status, device: 'CB5100' };
}

async function remembered() {
	const storage = memoryStorage();
	await rememberOrigin(
		{ s1: encodeS1({ bands, preampDb }), lineageId: 'lin_1', versionId: 'ver_1' },
		{ storage }
	);
	return { storage };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

afterEach(async () => {
	await cleanup();
});

describe('Cabo social status', () => {
	test('signed in: a real ok write of a community curve shows "instalada"', async () => {
		const origins = await remembered();
		const screen = await render(SocialStatus, {
			entries: [entry('ok')],
			signedIn: true,
			origins
		});
		await expect
			.poll(() => screen.container.querySelector('.social-status')?.textContent ?? '')
			.toContain('Comunitaria');
	});

	test('signed out shows nothing social', async () => {
		const origins = await remembered();
		const screen = await render(SocialStatus, {
			entries: [entry('ok')],
			signedIn: false,
			origins
		});
		await settle();
		expect(screen.container.querySelector('.social-status')).toBeNull();
		expect(screen.container.textContent?.trim()).toBe('');
	});

	test('simulated and interrupted entries never count as installed', async () => {
		const origins = await remembered();
		const screen = await render(SocialStatus, {
			entries: [entry('simulated'), entry('interrupted')],
			signedIn: true,
			origins
		});
		await settle();
		expect(screen.container.querySelector('.social-status')).toBeNull();
	});

	test('a curve without a community origin shows nothing', async () => {
		const screen = await render(SocialStatus, {
			entries: [entry('ok')],
			signedIn: true,
			origins: { storage: memoryStorage() }
		});
		await settle();
		expect(screen.container.querySelector('.social-status')).toBeNull();
	});

	test('the newest ok entry decides, even when a later simulated entry exists', async () => {
		const origins = await remembered();
		const screen = await render(SocialStatus, {
			entries: [entry('ok'), entry('simulated', 'Simulada')],
			signedIn: true,
			origins
		});
		await expect
			.poll(() => screen.container.querySelector('.social-status')?.textContent ?? '')
			.toContain('Comunitaria');
		expect(screen.container.textContent).not.toContain('Simulada');
	});
});
