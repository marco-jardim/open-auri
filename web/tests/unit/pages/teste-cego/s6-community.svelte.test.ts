import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { OFFICIAL_PRESETS } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import { setLocale } from '#lib/paraglide/runtime.js';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import { ORIGINS_KEY, originOf } from '#lib/social/origins.ts';
import { SocialApiError, type SocialApi } from '#lib/social/index.ts';

const preset = OFFICIAL_PRESETS.find((p) => p.label === 'Natural') ?? OFFICIAL_PRESETS[0]!;
const s1 = encodeS1({ bands: preset.bands, preampDb: preset.preampDb });
const NAME = 'Vozes da Comunidade';

function fakeApi(feed?: () => Promise<unknown>) {
	const api = {
		feed: vi.fn(
			feed ??
				(async () => ({
					sort: 'new',
					window: null,
					computedAt: null,
					items: [
						{
							lineage: { id: 'lin_c1', head: { id: 'ver_c1', name: NAME } },
							rank: null,
							score: null
						}
					],
					nextCursor: null
				}))
		),
		rankings: vi.fn(),
		getCurve: vi.fn(async () => ({
			curve: { id: 'curveid0001', s1 },
			lineage: { id: 'lin_c1' },
			version: { id: 'ver_c1', name: NAME }
		})),
		postS6Batch: vi.fn(),
		deleteS6Batch: vi.fn()
	};
	return { api, typed: api as unknown as SocialApi };
}

afterEach(async () => {
	await cleanup();
	localStorage.removeItem(ORIGINS_KEY);
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

describe('Teste cego: candidates from the Comunidade', () => {
	test('a published curve joins the candidates and its origin is remembered', async () => {
		await setLocale('pt-BR', { reload: false });
		const { api, typed } = fakeApi();
		await render(BlindTest, { api: typed, reducedMotion: true });
		await page.getByRole('tab', { name: /Candidatos/ }).click();
		await page.getByRole('button', { name: 'Carregar lista', exact: true }).click();
		expect(api.feed).toHaveBeenCalledOnce();
		const add = page.getByRole('button', { name: `Adicionar ${NAME} aos candidatos` });
		await add.click();
		await vi.waitFor(() => expect(api.getCurve).toHaveBeenCalledOnce());
		expect(api.getCurve.mock.calls[0]).toEqual(
			expect.arrayContaining(['lin_c1', { versionId: 'ver_c1' }])
		);
		const box = page.getByRole('checkbox', { name: new RegExp(`^${NAME}`) });
		await expect.element(box).toBeVisible();
		await expect.element(box).toBeEnabled();
		await expect.element(add).toBeDisabled();
		expect(await originOf(s1)).toMatchObject({ lineageId: 'lin_c1', versionId: 'ver_c1' });
		expect(api.postS6Batch).not.toHaveBeenCalled();
	});

	test('offline: a discreet notice, the local candidates keep working', async () => {
		const { typed } = fakeApi(async () => {
			throw new SocialApiError(0, 'OFFLINE');
		});
		await render(BlindTest, { api: typed, reducedMotion: true });
		await page.getByRole('tab', { name: /Candidatos/ }).click();
		await page.getByRole('button', { name: 'Carregar lista', exact: true }).click();
		await expect
			.element(page.getByText('Sem conexão: a lista da Comunidade volta quando a rede voltar.'))
			.toBeVisible();
		await expect.element(page.getByRole('checkbox', { name: /^Auri\b/ })).toBeEnabled();
	});

	test('without a social client nothing social is shown', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		await render(BlindTest, { reducedMotion: true });
		await page.getByRole('tab', { name: /Candidatos/ }).click();
		await expect
			.element(page.getByRole('button', { name: 'Carregar lista', exact: true }))
			.not.toBeInTheDocument();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
