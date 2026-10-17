import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { encodeS1, validateEnvelope } from 'open-auri/share';
import { neutralCurve } from '#lib/state/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { createSocialApi, createSocialSession, originOf } from '#lib/social/index.ts';
import { createCurveSocial } from '#lib/components/pages/comparar/social.svelte.ts';
import Workstation from '#lib/components/pages/soe-como-x/Workstation.svelte';
import { autoEqTrace, initialStation } from '#lib/components/pages/soe-como-x/model.ts';
import { solverRecipe } from '#lib/components/pages/soe-como-x/social.ts';
import { CSV, fakeDataClient, fitResult, measurement, targetEntries } from './fixtures.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

for (const source of ['feed', 'library']) {
	test(`solver uses a ${source} target and sends the validated S5 recipe`, async () => {
		await setLocale('en-US', { reload: false });
		const s1 = encodeS1(neutralCurve());
		const lineage = {
			id: 'soe-social',
			head: { id: 'soe-version', name: 'Community destination' }
		};
		const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url) => {
			if (url === '/api/v1/curves')
				return Response.json({
					lineageId: 'soe-result',
					versionId: 'soe-result-version',
					curveId: 'result'
				});
			if (url.startsWith('/api/v1/curves/'))
				return Response.json({
					lineage,
					version: { id: lineage.head.id, name: lineage.head.name },
					curve: { s1 }
				});
			return Response.json({
				items: source === 'library' ? [lineage] : [{ lineage }],
				nextCursor: null
			});
		});
		const social = createCurveSocial(
			createSocialApi({ fetch: fetcher }),
			createSocialSession({
				initial: { id: 'u-listener', username: 'listener', emailVerified: true }
			})
		);
		const worker = {
			solve: vi.fn(async () => ({ result: fitResult() })),
			cancel: vi.fn(),
			dispose: vi.fn()
		};
		await render(Workstation, {
			social,
			dataClient: fakeDataClient(),
			solverFactory: () => worker
		});
		await expect.poll(() => document.querySelectorAll('#soe-measurement option').length).toBe(2);
		await page
			.getByRole('combobox', { name: m.soe_choose_measurement() })
			.selectOptions(measurement.id);
		await page.getByRole('combobox', { name: m.soe_target_kind() }).selectOptions('community');
		await page
			.getByRole('combobox', { name: m.curve_social_sources(), exact: true })
			.selectOptions(source);
		await page.getByRole('button', { name: m.curve_social_load(), exact: true }).click();
		await page
			.getByRole('combobox', { name: m.curve_social_choose(), exact: true })
			.selectOptions(lineage.id);
		await page.getByRole('button', { name: m.curve_social_add() }).click();
		await expect
			.element(page.getByRole('button', { name: m.soe_solve() }))
			.not.toHaveAttribute('aria-disabled');
		expect(await originOf(s1)).toMatchObject({ lineageId: lineage.id, versionId: lineage.head.id });
		await page.getByRole('button', { name: m.soe_solve() }).click();
		await page.getByRole('button', { name: m.curve_social_publish() }).click();
		await page
			.getByRole('textbox', { name: m.curve_social_name(), exact: true })
			.fill('Solver result');
		await page.getByRole('button', { name: m.curve_social_submit() }).click();
		await expect.element(page.getByText(m.curve_social_published(), { exact: true })).toBeVisible();
		const request = fetcher.mock.calls.find(([url]) => url === '/api/v1/curves');
		const body: unknown = JSON.parse(String(request?.[1].body));
		expect(body).toMatchObject({
			visibility: 'public',
			envelope: {
				recipe: {
					measurement: { source: measurement.source, name: measurement.name },
					target: { source: 'community', name: 'community target' },
					solver: { name: 'open-auri', version: expect.stringMatching(/^\d+\.\d+\.\d+/) },
					params: { speed: 65, iso: true, d5Weight: 0.005 }
				}
			}
		});
		if (!body || typeof body !== 'object' || !('envelope' in body))
			throw new Error('Missing envelope');
		expect(validateEnvelope(body.envelope).ok).toBe(true);
	});
}

test('recipes retain the dataset names and source credits for AutoEq measurements and targets', async () => {
	const client = fakeDataClient();
	const target = targetEntries[0];
	const recipe = solverRecipe({
		...initialStation(),
		measurement: await autoEqTrace(client, measurement),
		target: await autoEqTrace(client, target),
		result: fitResult()
	});
	expect(recipe).toMatchObject({
		measurement: { source: measurement.source, name: measurement.name },
		target: { source: target.source, name: target.name }
	});
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`published recipes never include imported measurement or target file names in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
			Response.json({ lineageId: 'import-result', versionId: 'import-version', curveId: 'result' })
		);
		const social = createCurveSocial(
			createSocialApi({ fetch: fetcher }),
			createSocialSession({
				initial: { id: 'u-listener', username: 'listener', emailVerified: true }
			})
		);
		await render(Workstation, {
			social,
			dataClient: fakeDataClient(),
			solverFactory: () => ({
				solve: vi.fn(async () => ({ result: fitResult() })),
				cancel: vi.fn(),
				dispose: vi.fn()
			})
		});
		await page.getByRole('combobox', { name: m.soe_target_kind() }).selectOptions('csv');
		const files = [
			['soe-input-file', 'Maria-private-hearing-test.csv'],
			['soe-target-import-file', 'Maria-personal-target.csv']
		] as const;
		for (const [id, name] of files) {
			const input = document.getElementById(id);
			if (!(input instanceof HTMLInputElement)) throw new Error('Missing CSV input');
			const transfer = new DataTransfer();
			transfer.items.add(new File([CSV], name));
			input.files = transfer.files;
			input.dispatchEvent(new Event('change', { bubbles: true }));
			await expect.element(page.getByText(name, { exact: true })).toBeVisible();
		}
		await page.getByRole('button', { name: m.soe_solve() }).click();
		await page.getByRole('button', { name: m.curve_social_publish() }).click();
		await page.getByRole('textbox', { name: m.curve_social_name(), exact: true }).fill('Result');
		await page.getByRole('button', { name: m.curve_social_submit() }).click();
		await expect.element(page.getByText(m.curve_social_published(), { exact: true })).toBeVisible();
		const request = fetcher.mock.calls.find(([url]) => url === '/api/v1/curves');
		const serialized = String(request?.[1].body);
		for (const [, name] of files) expect(serialized).not.toContain(name);
		const body: unknown = JSON.parse(serialized);
		if (!body || typeof body !== 'object' || !('envelope' in body))
			throw new Error('Missing envelope');
		expect(body.envelope).toMatchObject({
			recipe: {
				measurement: { source: 'csv', name: 'imported measurement' },
				target: { source: 'csv', name: 'imported target' }
			}
		});
		expect(validateEnvelope(body.envelope).ok).toBe(true);
	});
}

test('signed-out target library invites login and does not block local preset targets', async () => {
	const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
		Response.json({})
	);
	const social = createCurveSocial(
		createSocialApi({ fetch: fetcher }),
		createSocialSession({ initial: null })
	);
	await render(Workstation, { social, dataClient: fakeDataClient() });
	await page.getByRole('combobox', { name: m.soe_target_kind() }).selectOptions('community');
	await page
		.getByRole('combobox', { name: m.curve_social_sources(), exact: true })
		.selectOptions('library');
	await expect.element(page.getByRole('link', { name: m.curve_social_login() })).toBeVisible();
	expect(fetcher).not.toHaveBeenCalled();
	await page.getByRole('combobox', { name: m.soe_target_kind() }).selectOptions('preset');
	await expect.element(page.getByRole('combobox', { name: m.soe_preset() })).toBeEnabled();
});
