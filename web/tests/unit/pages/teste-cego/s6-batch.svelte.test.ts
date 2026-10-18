import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import serverS6 from '../../../../src/lib/server/social/s6.ts?raw';
import serverTurnstile from '../../../../src/lib/server/security/turnstile.ts?raw';
import {
	officialCandidates,
	recordRound,
	startSession
} from '#lib/components/pages/teste-cego/experiment.ts';
import {
	S6_CONSENT_VERSION,
	S6_ITEM_PATTERN,
	S6_RECEIPT_PATTERN,
	S6_RECEIPTS_KEY,
	S6_TURNSTILE_ACTION,
	addReceipt,
	buildBatch,
	buildPairs,
	newReceipt,
	readReceipts,
	removeReceipt,
	type ReceiptStorage
} from '#lib/components/pages/teste-cego/s6.ts';
import S6Send from '#lib/components/pages/teste-cego/S6Send.svelte';
import { m } from '#lib/paraglide/messages.js';
import { SocialApiError } from '#lib/social/index.ts';

/** Unavailable buttons say why: the reason is part of the accessible description. */
const why = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

function memory(): ReceiptStorage & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => void map.set(key, value)
	};
}

function finished() {
	const candidates = officialCandidates()
		.filter((c) => c.accepted)
		.slice(0, 2);
	let session = startSession(candidates, 2, 'neutral', () => 0);
	session = recordRound(session, [8, 3], () => 0);
	session = recordRound(session, [5, 5], () => 0);
	return session;
}

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

describe('S6 constants mirror the server', () => {
	test('consent version, receipt and item patterns, Turnstile action', () => {
		expect(serverS6).toContain(`export const S6_CONSENT_VERSION = '${S6_CONSENT_VERSION}';`);
		expect(serverS6).toContain(`export const S6_ITEM_PATTERN = /${S6_ITEM_PATTERN.source}/;`);
		expect(serverS6).toContain(`export const S6_RECEIPT_PATTERN = /${S6_RECEIPT_PATTERN.source}/;`);
		expect(serverTurnstile).toContain(`s6: '${S6_TURNSTILE_ACTION}'`);
		expect(S6_CONSENT_VERSION).toBe('s6-consent-v1');
	});
});

describe('S6 batch', () => {
	test('a receipt is 32 random bytes in unpadded base64url (43 chars)', () => {
		const random = vi.fn((bytes: Uint8Array) => bytes.fill(0xff));
		expect(newReceipt(random)).toBe(`${'_'.repeat(42)}8`);
		expect(random.mock.calls[0]![0]).toHaveLength(32);
		const fresh = newReceipt();
		expect(fresh).toHaveLength(43);
		expect(fresh).toMatch(S6_RECEIPT_PATTERN);
		expect(newReceipt()).not.toBe(fresh);
	});

	test('pairs carry curve ids and the rated choice; the body has only the allowed keys', async () => {
		const pairs = await buildPairs(finished());
		expect(pairs).toHaveLength(2);
		for (const pair of pairs) {
			expect(Object.keys(pair)).toEqual(['a', 'b', 'choice', 'levelMatched']);
			expect(pair.a).toMatch(S6_ITEM_PATTERN);
			expect(pair.b).toMatch(S6_ITEM_PATTERN);
			expect(pair.a).not.toBe(pair.b);
			expect(pair.levelMatched).toBe(true);
		}
		expect(pairs.map((pair) => pair.choice)).toEqual(['a', 'tie']);
		const batch = buildBatch('r'.repeat(43), pairs);
		expect(Object.keys(batch)).toEqual(['consentVersion', 'receipt', 'pairs']);
		expect(batch.consentVersion).toBe(S6_CONSENT_VERSION);
		expect(await buildPairs(null)).toEqual([]);
	});

	test('local receipts: add, ignore invalid records, remove', () => {
		const storage = memory();
		const receipt = newReceipt();
		expect(addReceipt(storage, { receipt, day: '2026-10-16', pairs: 3 })).toEqual([
			{ receipt, day: '2026-10-16', pairs: 3 }
		]);
		storage.map.set(
			S6_RECEIPTS_KEY,
			JSON.stringify([...readReceipts(storage), { receipt: 'bad', day: 'x', pairs: 1 }])
		);
		expect(readReceipts(storage)).toHaveLength(1);
		expect(removeReceipt(storage, receipt)).toEqual([]);
		storage.map.set(S6_RECEIPTS_KEY, '{not json');
		expect(readReceipts(storage)).toEqual([]);
	});
});

describe('S6Send', () => {
	test.each([
		{
			error: new Error('lost answer'),
			message: () => m.cegos6_failed(),
			keep: true,
			renewed: false
		},
		{
			error: new SocialApiError(0, 'OFFLINE'),
			message: () => m.cegos6_offline(),
			keep: true,
			renewed: false
		},
		{
			error: new SocialApiError(409, 'DUPLICATE'),
			message: () => m.cegos6_sent(),
			keep: true,
			renewed: true
		},
		{
			error: new SocialApiError(422, 'INVALID_BODY'),
			message: () => m.cegos6_failed(),
			keep: false,
			renewed: true
		}
	])(
		'send failure $error retains only withdrawable uncertain receipts',
		async ({ error, message, keep, renewed }) => {
			vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			const storage = memory();
			const api = {
				postS6Batch: vi.fn(async (): Promise<{ ok: true }> => {
					throw error;
				}),
				deleteS6Batch: vi.fn()
			};
			const screen = await render(S6Send, {
				session: finished(),
				api,
				storage,
				token: 'single-use'
			});
			const preview = screen.container.querySelector('textarea');
			await expect.poll(() => JSON.parse(preview?.value ?? '{}').pairs?.length).toBe(2);
			const before: { receipt: string } = JSON.parse(preview?.value ?? '{}');
			await page.getByRole('checkbox').nth(0).click();
			await page.getByRole('checkbox').nth(1).click();
			await page.getByRole('button', { name: m.cego_send(), exact: true }).click();
			await expect.element(page.getByRole('status')).toHaveTextContent(message());
			expect(readReceipts(storage).map((record) => record.receipt)).toEqual(
				keep ? [before.receipt] : []
			);
			expect(JSON.parse(preview?.value ?? '{}').receipt === before.receipt).toBe(!renewed);
			await expect
				.element(page.getByRole('button', { name: m.cego_send(), exact: true }))
				.toHaveAttribute('aria-disabled', 'true');
			await expect
				.element(page.getByRole('button', { name: m.cego_send(), exact: true }))
				.toHaveAccessibleDescription(why(m.cego_fuxb_reason_no_check()));
		}
	);

	test.each([new Error('delete unavailable'), new SocialApiError(503, 'INTERNAL')])(
		'failed withdrawal keeps the receipt for retry (%s)',
		async (error) => {
			vi.spyOn(console, 'warn').mockImplementation(() => undefined);
			const storage = memory();
			const receipt = newReceipt();
			addReceipt(storage, { receipt, day: '2026-10-16', pairs: 2 });
			const api = {
				postS6Batch: vi.fn(),
				deleteS6Batch: vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
			};
			await render(S6Send, { api, storage });
			const remove = page.getByRole('button', {
				name: m.cegos6_delete_label({ id: receipt.slice(0, 8) })
			});
			await remove.click();
			await expect.element(page.getByRole('status')).toHaveTextContent(m.cegos6_delete_failed());
			expect(readReceipts(storage)).toHaveLength(1);
			await remove.click();
			await expect.element(page.getByRole('status')).toHaveTextContent(m.cegos6_deleted());
			expect(readReceipts(storage)).toEqual([]);
		}
	);

	test('withdrawal locks other receipts and a ready send with a busy reason', async () => {
		const storage = memory();
		const first = newReceipt();
		const second = newReceipt();
		for (const receipt of [first, second])
			addReceipt(storage, { receipt, day: '2026-10-16', pairs: 2 });
		let finish: (() => void) | undefined;
		const api = {
			postS6Batch: vi.fn(),
			deleteS6Batch: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					})
			)
		};
		const screen = await render(S6Send, {
			session: finished(),
			api,
			storage,
			token: 'ready-token'
		});
		await expect
			.poll(
				() => JSON.parse(screen.container.querySelector('textarea')?.value ?? '{}').pairs?.length
			)
			.toBe(2);
		await page.getByRole('checkbox').nth(0).click();
		await page.getByRole('checkbox').nth(1).click();
		await page
			.getByRole('button', { name: m.cegos6_delete_label({ id: first.slice(0, 8) }) })
			.click();
		const other = page.getByRole('button', {
			name: m.cegos6_delete_label({ id: second.slice(0, 8) })
		});
		const send = page.getByRole('button', { name: m.cego_send(), exact: true });
		for (const button of [other, send]) {
			await expect.element(button).toHaveAttribute('aria-disabled', 'true');
			await expect.element(button).toHaveAccessibleDescription(why(m.cego_fuxb_reason_busy()));
			const element = button.element();
			if (!(element instanceof HTMLElement)) throw new Error('Missing locked button');
			element.click();
		}
		expect(api.postS6Batch).not.toHaveBeenCalled();
		expect(api.deleteS6Batch).toHaveBeenCalledOnce();
		finish?.();
		await expect.element(other).not.toHaveAttribute('aria-disabled');
		expect(readReceipts(storage).map((record) => record.receipt)).toEqual([second]);
	});

	test('null storage still permits sending but never shows a local receipt', async () => {
		const api = { postS6Batch: vi.fn(async () => ({ ok: true as const })), deleteS6Batch: vi.fn() };
		const screen = await render(S6Send, {
			session: finished(),
			api,
			storage: null,
			token: 'no-storage'
		});
		await expect
			.poll(
				() => JSON.parse(screen.container.querySelector('textarea')?.value ?? '{}').pairs?.length
			)
			.toBe(2);
		await page.getByRole('checkbox').nth(0).click();
		await page.getByRole('checkbox').nth(1).click();
		await page.getByRole('button', { name: m.cego_send(), exact: true }).click();
		await expect.element(page.getByRole('status')).toHaveTextContent(m.cegos6_sent());
		await expect.element(page.getByText(m.cegos6_no_receipts(), { exact: true })).toBeVisible();
		expect(api.postS6Batch).toHaveBeenCalledOnce();
	});

	test('without finished pairs the reason names the missing result', async () => {
		await render(S6Send, { api: { postS6Batch: vi.fn(), deleteS6Batch: vi.fn() }, storage: null });
		const send = page.getByRole('button', { name: m.cego_send(), exact: true });
		await expect.element(send).toHaveAttribute('aria-disabled', 'true');
		await expect.element(send).toHaveAccessibleDescription(why(m.cegos6_no_pairs()));
	});
	test('previews the exact JSON and keeps sending disabled without consent and Turnstile', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const api = { postS6Batch: vi.fn(), deleteS6Batch: vi.fn() };
		const screen = await render(S6Send, { session: finished(), api, storage: memory() });
		const preview = screen.container.querySelector('textarea');
		await expect.poll(() => JSON.parse(preview?.value ?? '{}').pairs?.length).toBe(2);
		const body = JSON.parse(preview!.value) as Record<string, unknown>;
		expect(Object.keys(body)).toEqual(['consentVersion', 'receipt', 'pairs']);
		expect(body.consentVersion).toBe(S6_CONSENT_VERSION);
		expect(body.receipt).toMatch(S6_RECEIPT_PATTERN);
		const send = page.getByRole('button', { name: 'Enviar preferências', exact: true });
		await expect.element(send).toHaveAttribute('aria-disabled', 'true');
		await expect.element(send).toHaveAccessibleDescription(why(m.cegos6_ready_note()));
		await page.getByRole('checkbox').nth(0).click();
		await page.getByRole('checkbox').nth(1).click();
		await expect.element(send).toHaveAttribute('aria-disabled', 'true');
		// Consent given, but this host has no Turnstile: the reason says the check is missing.
		await expect.element(send).toHaveAccessibleDescription(why(m.cego_fuxb_reason_no_check()));
		(send.element() as HTMLElement).click();
		expect(api.postS6Batch).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	test('send posts exactly the previewed JSON with the token and keeps the receipt locally', async () => {
		const storage = memory();
		const postS6Batch = vi.fn(async () => ({ ok: true as const }));
		const api = { postS6Batch, deleteS6Batch: vi.fn() };
		const screen = await render(S6Send, { session: finished(), api, storage, token: 'tok-1' });
		const preview = screen.container.querySelector('textarea');
		await expect.poll(() => JSON.parse(preview?.value ?? '{}').pairs?.length).toBe(2);
		const shown = preview!.value;
		await page.getByRole('checkbox').nth(0).click();
		await page.getByRole('checkbox').nth(1).click();
		await page.getByRole('button', { name: 'Enviar preferências', exact: true }).click();
		await vi.waitFor(() => expect(postS6Batch).toHaveBeenCalledOnce());
		const [body, token] = postS6Batch.mock.calls[0] as unknown as [unknown, string];
		expect(body).toEqual(JSON.parse(shown));
		expect(token).toBe('tok-1');
		const sent = JSON.parse(shown) as { receipt: string };
		expect(readReceipts(storage).map((r) => r.receipt)).toEqual([sent.receipt]);
		// A fresh receipt for the next batch; the single-use token is gone.
		await expect.poll(() => JSON.parse(preview!.value).receipt).not.toBe(sent.receipt);
		const again = page.getByRole('button', { name: 'Enviar preferências', exact: true });
		await expect.element(again).toHaveAttribute('aria-disabled', 'true');
		await expect.element(again).toHaveAccessibleDescription(why(m.cegos6_ready_note()));
	});

	test('a refused batch forgets its receipt', async () => {
		const storage = memory();
		const { SocialApiError } = await import('#lib/social/index.ts');
		const api = {
			postS6Batch: vi.fn(async (): Promise<{ ok: true }> => {
				throw new SocialApiError(400, 'CONSENT_REQUIRED');
			}),
			deleteS6Batch: vi.fn()
		};
		await render(S6Send, { session: finished(), api, storage, token: 'tok-2' });
		await page.getByRole('checkbox').nth(0).click();
		await page.getByRole('checkbox').nth(1).click();
		const send = page.getByRole('button', { name: 'Enviar preferências', exact: true });
		await expect.element(send).not.toHaveAttribute('aria-disabled');
		(send.element() as HTMLElement).click();
		await vi.waitFor(() => expect(api.postS6Batch).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(readReceipts(storage)).toEqual([]));
	});

	test('"apagar" withdraws the batch by receipt and forgets it locally', async () => {
		const storage = memory();
		const receipt = newReceipt();
		addReceipt(storage, { receipt, day: '2026-10-16', pairs: 2 });
		const api = { postS6Batch: vi.fn(), deleteS6Batch: vi.fn(async () => undefined) };
		await render(S6Send, { session: null, api, storage });
		const remove = page.getByRole('button', { name: new RegExp(receipt.slice(0, 8)) });
		await expect.element(remove).not.toHaveAttribute('aria-disabled');
		(remove.element() as HTMLElement).click();
		await vi.waitFor(() => expect(api.deleteS6Batch).toHaveBeenCalledWith(receipt));
		await vi.waitFor(() => expect(readReceipts(storage)).toEqual([]));
	});

	test('without a social client, send and withdraw stay unavailable and say why', async () => {
		const storage = memory();
		const receipt = newReceipt();
		addReceipt(storage, { receipt, day: '2026-10-16', pairs: 2 });
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		await render(S6Send, { session: finished(), api: null, storage, token: 'tok-3' });
		const send = page.getByRole('button', { name: 'Enviar preferências', exact: true });
		await expect.element(send).toHaveAttribute('aria-disabled', 'true');
		await expect.element(send).toHaveAccessibleDescription(why(m.cegos6_unavailable()));
		const remove = page.getByRole('button', { name: new RegExp(receipt.slice(0, 8)) });
		await expect.element(remove).toHaveAttribute('aria-disabled', 'true');
		await expect.element(remove).toHaveAccessibleDescription(why(m.cegos6_unavailable()));
		(remove.element() as HTMLElement).click();
		expect(readReceipts(storage).map((r) => r.receipt)).toEqual([receipt]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
