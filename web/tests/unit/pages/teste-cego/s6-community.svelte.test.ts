import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { OFFICIAL_PRESETS } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import { setLocale } from '#lib/paraglide/runtime.js';
import { m } from '#lib/paraglide/messages.js';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import CommunityCandidates from '#lib/components/pages/teste-cego/CommunityCandidates.svelte';

/** Unavailable controls say why: the reason is part of the accessible description. */
const why = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
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
	test('rankings paginate, trim the search and explain already-added and running-test controls', async () => {
		const { api, typed } = fakeApi();
		api.rankings.mockResolvedValueOnce({
			items: [{ lineage: { id: 'first', head: { id: 'v-first', name: 'Warm bass' } } }],
			nextCursor: 'next'
		});
		api.rankings.mockResolvedValueOnce({
			items: [{ lineage: { id: 'second', head: { id: 'v-second', name: 'Clear voice' } } }],
			nextCursor: null
		});
		const screen = await render(CommunityCandidates, {
			api: typed,
			added: ['community:v-first'],
			onadd: vi.fn()
		});
		await page.getByRole('combobox').selectOptions('rankings');
		await page.getByRole('button', { name: m.cegocom_load(), exact: true }).click();
		const first = page.getByRole('button', { name: m.cegocom_add_label({ name: 'Warm bass' }) });
		await expect.element(first).toHaveAttribute('aria-disabled', 'true');
		await expect.element(first).toHaveAccessibleDescription(why(m.cego_fuxb_reason_added()));
		await page.getByRole('button', { name: m.cegocom_more(), exact: true }).click();
		expect(api.rankings).toHaveBeenLastCalledWith(
			{ cursor: 'next', limit: 50 },
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
		await expect.element(page.getByText('Warm bass', { exact: true })).toBeVisible();
		await expect.element(page.getByText('Clear voice', { exact: true })).toBeVisible();
		await page.getByRole('searchbox').fill('  VOICE  ');
		await expect.element(page.getByText('Warm bass', { exact: true })).not.toBeInTheDocument();
		await expect.element(page.getByText('Clear voice', { exact: true })).toBeVisible();
		await page.getByRole('searchbox').fill('missing');
		await expect.element(page.getByText(m.cegocom_empty(), { exact: true })).toBeVisible();
		await page.getByRole('searchbox').fill('');
		await screen.rerender({ disabled: true });
		await expect.element(first).toHaveAccessibleDescription(why(m.cego_fuxb_reason_test_running()));
		expect(api.feed).not.toHaveBeenCalled();
	});

	test('adding a curve locks competing actions but does not issue duplicate requests', async () => {
		const { api, typed } = fakeApi();
		const result = await api.getCurve();
		api.getCurve.mockClear();
		let finish: ((value: typeof result) => void) | undefined;
		api.getCurve.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				})
		);
		const onadd = vi.fn();
		await render(CommunityCandidates, { api: typed, onadd });
		await page.getByRole('button', { name: m.cegocom_load(), exact: true }).click();
		const add = page.getByRole('button', { name: m.cegocom_add_label({ name: NAME }) });
		await add.click();
		await expect.element(add).toHaveAttribute('aria-busy', 'true');
		const load = page.getByRole('button', { name: m.cegocom_load(), exact: true });
		await expect.element(load).toHaveAttribute('aria-disabled', 'true');
		await expect.element(load).toHaveAccessibleDescription(why(m.cego_fuxb_reason_busy()));
		const element = add.element();
		if (!(element instanceof HTMLElement)) throw new Error('Missing add button');
		element.click();
		expect(api.getCurve).toHaveBeenCalledOnce();
		finish?.(result);
		await expect.poll(() => onadd.mock.calls.length).toBe(1);
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent(m.cegocom_added({ name: NAME }));
		await expect.element(load).not.toHaveAttribute('aria-disabled');
	});

	test.each([
		new Error('bad response'),
		new SocialApiError(403, 'FORBIDDEN'),
		new DOMException('cancelled', 'AbortError')
	])('list failures distinguish cancellation from visible failures (%s)', async (cause) => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { api, typed } = fakeApi(async () => {
			throw cause;
		});
		await render(CommunityCandidates, { api: typed, onadd: vi.fn() });
		await page.getByRole('button', { name: m.cegocom_load(), exact: true }).click();
		await expect
			.element(page.getByRole('button', { name: m.cegocom_load(), exact: true }))
			.not.toHaveAttribute('aria-busy');
		if (cause instanceof DOMException)
			expect(page.getByRole('status').element().textContent?.trim()).toBe('');
		else await expect.element(page.getByRole('status')).toHaveTextContent(m.cegocom_failed());
		expect(api.getCurve).not.toHaveBeenCalled();
	});

	test('invalid curve responses report failure, while a decoded unsafe candidate is explicitly rejected', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const { api, typed } = fakeApi();
		const result = await api.getCurve();
		api.getCurve.mockClear();
		api.getCurve.mockResolvedValueOnce({ ...result, curve: { ...result.curve, s1: 'not-an-s1' } });
		api.getCurve.mockResolvedValueOnce({
			...result,
			curve: { ...result.curve, s1: encodeS1({ bands: preset.bands, preampDb: 0 }) }
		});
		const onadd = vi.fn();
		await render(CommunityCandidates, { api: typed, onadd });
		await page.getByRole('button', { name: m.cegocom_load(), exact: true }).click();
		const add = page.getByRole('button', { name: m.cegocom_add_label({ name: NAME }) });
		await add.click();
		await expect.element(page.getByRole('status')).toHaveTextContent(m.cegocom_failed());
		expect(onadd).not.toHaveBeenCalled();
		await add.click();
		await expect.element(page.getByRole('status')).toHaveTextContent(m.cegocom_rejected());
		expect(onadd).toHaveBeenCalledWith(
			expect.objectContaining({ accepted: false, id: 'community:ver_c1' })
		);
	});

	test('changing source ignores a late feed response and an unmounted add cannot mutate the candidates', async () => {
		let finishFeed: ((value: unknown) => void) | undefined;
		const { api, typed } = fakeApi(
			() =>
				new Promise((resolve) => {
					finishFeed = resolve;
				})
		);
		api.rankings.mockResolvedValue({ items: [], nextCursor: null });
		const onadd = vi.fn();
		await render(CommunityCandidates, { api: typed, onadd });
		await page.getByRole('button', { name: m.cegocom_load(), exact: true }).click();
		await page.getByRole('combobox').selectOptions('rankings');
		finishFeed?.({
			items: [{ lineage: { id: 'late', head: { id: 'late-version', name: 'Stale candidate' } } }],
			nextCursor: null
		});
		await page.getByRole('button', { name: m.cegocom_load(), exact: true }).click();
		await expect.element(page.getByText(m.cegocom_empty(), { exact: true })).toBeVisible();
		await expect
			.element(page.getByText('Stale candidate', { exact: true }))
			.not.toBeInTheDocument();
		await cleanup();
		const fresh = fakeApi();
		const result = await fresh.api.getCurve();
		let finishAdd: ((value: typeof result) => void) | undefined;
		fresh.api.getCurve.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishAdd = resolve;
				})
		);
		await render(CommunityCandidates, { api: fresh.typed, onadd });
		await page.getByRole('button', { name: m.cegocom_load(), exact: true }).click();
		await page.getByRole('button', { name: m.cegocom_add_label({ name: NAME }) }).click();
		await cleanup();
		finishAdd?.(result);
		await fresh.api.getCurve.mock.results.at(-1)?.value;
		expect(onadd).not.toHaveBeenCalled();
	});
	test('a published curve joins the candidates and its origin is remembered', async () => {
		await setLocale('pt-BR', { reload: false });
		const { api, typed } = fakeApi();
		await render(BlindTest, { api: typed, reducedMotion: true });
		await page.getByRole('tab', { name: /Candidatos/ }).click();
		await page.getByRole('button', { name: 'Carregar lista', exact: true }).click();
		expect(api.feed).toHaveBeenCalledOnce();
		const add = page.getByRole('button', { name: `Adicionar ${NAME} aos candidatos` });
		(add.element() as HTMLElement).click();
		await vi.waitFor(() => expect(api.getCurve).toHaveBeenCalledOnce());
		expect(api.getCurve.mock.calls[0]).toEqual(
			expect.arrayContaining(['lin_c1', { versionId: 'ver_c1' }])
		);
		const box = page.getByRole('checkbox', { name: new RegExp(`^${NAME}`) });
		await expect.element(box).toBeVisible();
		await expect.element(box).toBeEnabled();
		await expect.element(add).toHaveAttribute('aria-disabled', 'true');
		await expect.element(add).toHaveAccessibleDescription(why(m.cego_fuxb_reason_added()));
		(add.element() as HTMLElement).click();
		expect(api.getCurve).toHaveBeenCalledOnce();
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

	test('during a running test every community control is unavailable and says why', async () => {
		await setLocale('pt-BR', { reload: false });
		const { api, typed } = fakeApi();
		await render(CommunityCandidates, { api: typed, disabled: true, onadd: vi.fn() });
		const load = page.getByRole('button', { name: 'Carregar lista', exact: true });
		await expect.element(load).toHaveAttribute('aria-disabled', 'true');
		await expect.element(load).toHaveAccessibleDescription(why(m.cego_fuxb_reason_test_running()));
		// Playwright refuses to click aria-disabled elements; dispatch the click to prove it is inert.
		(load.element() as HTMLElement).click();
		expect(api.feed).not.toHaveBeenCalled();
		for (const field of [page.getByRole('combobox'), page.getByRole('searchbox')]) {
			await expect.element(field).toBeDisabled();
			await expect
				.element(field)
				.toHaveAccessibleDescription(why(m.cego_fuxb_reason_test_running()));
		}
		await expect
			.element(page.getByRole('paragraph').filter({ hasText: m.cego_fuxb_reason_test_running() }))
			.toBeVisible();
	});

	test('while a list is loading, load shows its progress and ignores a second press', async () => {
		await setLocale('pt-BR', { reload: false });
		let release: (value: unknown) => void = () => undefined;
		const { api, typed } = fakeApi(
			() =>
				new Promise((resolve) => {
					release = resolve;
				})
		);
		await render(CommunityCandidates, { api: typed, onadd: vi.fn() });
		const load = page.getByRole('button', { name: 'Carregar lista', exact: true });
		(load.element() as HTMLElement).click();
		// The running operation's own button is busy (spinner, aria-busy), not unavailable.
		await expect.element(load).toHaveAttribute('aria-busy', 'true');
		await expect.element(load).not.toHaveAttribute('aria-disabled');
		(load.element() as HTMLElement).click();
		expect(api.feed).toHaveBeenCalledOnce();
		release({ sort: 'new', window: null, computedAt: null, items: [], nextCursor: null });
		await expect.element(load).not.toHaveAttribute('aria-busy');
		await expect.element(page.getByText(m.cegocom_empty(), { exact: true })).toBeVisible();
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
