// YOLO publication in Minha biblioteca: three badge states (YOLO, warn, none) and the
// acknowledgement step before a YOLO head is opened to others (visibility), sent as
// `acknowledge: 'yolo'`; 403 YOLO_PUBLICATION_OFF says why.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { NEUTRO } from 'open-auri/catalog';
import { encodeS1 } from 'open-auri/share';
import {
	createSocialApi,
	createSocialSession,
	type LibraryItem,
	type rememberOrigin
} from '#lib/social/index.ts';
import MinhaBiblioteca from '#lib/components/pages/biblioteca/MinhaBiblioteca.svelte';
import type { KeyValueStorage } from '#lib/components/pages/biblioteca/social.ts';
import { m } from '#lib/paraglide/messages.js';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

const s1 = encodeS1({ bands: NEUTRO.bands, preampDb: NEUTRO.preampDb });

function item(id: string, name: string, curve: Partial<LibraryItem['curve']>): LibraryItem {
	return {
		id,
		own: true,
		visibility: 'private',
		status: 'active',
		moderation: 'visible',
		curated: false,
		forkedFromVersion: null,
		createdAt: 1,
		updatedAt: 1,
		author: { username: 'ana', displayUsername: 'Ana' },
		head: {
			id: `${id}v`,
			parentId: null,
			name,
			description: '',
			license: 'CC-BY-4.0',
			lang: 'pt-BR',
			recipe: null,
			labels: null,
			createdAt: 1
		},
		curve: { id: `${id}c`, s1, levelDb: null, gateOk: true, ...curve },
		at: 1
	};
}

const ITEMS = [
	item('linS', 'Padrão minha', { gateOk: true, yolo: false, waived: [] }),
	item('linY', 'Subsônica', { gateOk: false, yolo: true, waived: ['a:b2'] }),
	item('linW', 'Antiga', { gateOk: false, yolo: false, waived: [] })
];

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
	method: string;
	path: string;
	body: unknown;
}

function server(visibility: (body: unknown) => Response) {
	const calls: Call[] = [];
	const fetch = async (input: string, init: RequestInit) => {
		const url = new URL(input, 'https://example.test');
		const method = init.method ?? 'GET';
		const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
		calls.push({ method, path: url.pathname, body });
		if (method === 'GET' && url.pathname === '/api/v1/me/library') {
			const shelf = url.searchParams.get('shelf');
			return json({ shelf, items: shelf === 'created' ? ITEMS : [], nextCursor: null });
		}
		if (method === 'GET' && url.pathname === '/api/v1/me/packs') {
			return json({ items: [], nextCursor: null });
		}
		if (method === 'PUT' && url.pathname === '/api/v1/lineages/linY/visibility') {
			return visibility(body);
		}
		return json({ error: { code: 'NOT_FOUND' } }, 404);
	};
	const puts = () => calls.filter((call) => call.method === 'PUT');
	return { puts, api: createSocialApi({ fetch, online: () => true }) };
}

function memoryStorage(): KeyValueStorage {
	const data = new Map<string, string>();
	return {
		getItem: (key) => data.get(key) ?? null,
		setItem: (key, value) => {
			data.set(key, value);
		}
	};
}

async function setup(api: ReturnType<typeof createSocialApi>) {
	const remember = vi.fn<typeof rememberOrigin>(async () => {});
	const session = createSocialSession({
		initial: { id: 'u-ana', username: 'Ana', emailVerified: true }
	});
	await render(MinhaBiblioteca, {
		session,
		api,
		origin: 'https://example.test',
		locale: 'pt-BR',
		storage: memoryStorage(),
		remember
	});
	await expect.element(page.getByText('Subsônica', { exact: true })).toBeVisible();
}

const opened = (visibility: string) =>
	json({ lineageId: 'linY', status: 'active', visibility, moderation: 'visible' });
const picker = () =>
	page.getByRole('combobox', {
		name: m.biblioteca_social_change_visibility({ name: 'Subsônica' })
	});

test('three badge states: YOLO, warn and none', async () => {
	const { api } = server(() => opened('private'));
	await setup(api);
	expect(document.querySelectorAll('[data-curve-badge="yolo"]')).toHaveLength(1);
	expect(document.querySelectorAll('[data-curve-badge="warn"]')).toHaveLength(1);
	const yoloRow = document.querySelector('[data-curve-badge="yolo"]')?.closest('li');
	expect(yoloRow?.textContent).toContain('Subsônica');
	expect(yoloRow?.textContent).not.toContain(m.biblioteca_social_gate_failed());
	const warnRow = document.querySelector('[data-curve-badge="warn"]')?.closest('li');
	expect(warnRow?.textContent).toContain('Antiga');
});

test('opening a YOLO head to others asks for the acknowledgement, then sends it', async () => {
	const { api, puts } = server((body) => {
		const acked = typeof body === 'object' && body !== null && 'acknowledge' in body;
		return acked ? opened('public') : json({ error: { code: 'YOLO_ACK_REQUIRED' } }, 409);
	});
	await setup(api);
	await picker().selectOptions('public');
	const step = page.getByRole('group', { name: m.yolopub_ack_title() });
	await expect.element(step).toBeVisible();
	expect(puts()).toHaveLength(0);
	await step.getByRole('checkbox', { name: m.yolopub_ack_checkbox() }).click();
	await step.getByRole('button', { name: m.yolopub_ack_button() }).click();
	await expect.element(page.getByText(m.biblioteca_social_saved_visibility())).toBeVisible();
	expect(puts().map((call) => call.body)).toEqual([{ visibility: 'public', acknowledge: 'yolo' }]);
	expect(document.querySelector('[data-yolo-publish-ack]')).toBeNull();
});

test('403 YOLO_PUBLICATION_OFF says to keep it private; "Voltar" restores the picker', async () => {
	const { api, puts } = server((body) => {
		const acked = typeof body === 'object' && body !== null && 'acknowledge' in body;
		return acked ? json({ error: { code: 'YOLO_PUBLICATION_OFF' } }, 403) : opened('unlisted');
	});
	await setup(api);
	await picker().selectOptions('unlisted');
	const step = page.getByRole('group', { name: m.yolopub_ack_title() });
	await step.getByRole('checkbox', { name: m.yolopub_ack_checkbox() }).click();
	await step.getByRole('button', { name: m.yolopub_ack_button() }).click();
	await expect.element(page.getByText(m.yolopub_error_off())).toBeVisible();
	expect(puts().map((call) => call.body)).toEqual([
		{ visibility: 'unlisted', acknowledge: 'yolo' }
	]);
	// "Voltar" leaves the step and the picker shows the real visibility again.
	await step.getByRole('button', { name: m.yolopub_ack_cancel() }).click();
	await expect.element(picker()).toHaveValue('private');
});
