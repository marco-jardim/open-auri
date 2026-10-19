import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { OFFICIAL_PRESETS } from 'open-auri/catalog';
import { gateForWrite } from 'open-auri/safety';
import { encodeS1 } from 'open-auri/share';
import type { ClientApp } from '#lib/app/client.svelte.ts';
import { IDLE_STATE, type AudioEngineState } from '#lib/audio/engine.ts';
import type { MeterUpdate } from '#lib/audio/meters.ts';
import { neutralCurve, type CurveData } from '#lib/state/model.ts';
import type { LibraryItem } from '#lib/state/library.svelte.ts';
import { createYoloState } from '#lib/state/yolo.svelte.ts';
import type { CommitInput, CommitResult } from '#lib/workers/gate-handler.ts';
import {
	archiveTapes,
	number,
	rmsTo,
	type Tape
} from '#lib/components/pages/biblioteca/archive.ts';
import Biblioteca from '#lib/components/pages/biblioteca/Biblioteca.svelte';
import { downloadBlob } from '#lib/components/pages/biblioteca/sheet-export.ts';
import { createSocialApi, createSocialSession } from '#lib/social/index.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';

const mocks = vi.hoisted(() => ({ tap: vi.fn(), worker: vi.fn(), tapes: null as Tape[] | null }));
vi.mock('#lib/audio/meters.ts', async (original) => ({
	...(await original<typeof import('#lib/audio/meters.ts')>()),
	tap: mocks.tap
}));
vi.mock('#lib/workers/gate-client.ts', () => ({ createGateWorker: mocks.worker }));
vi.mock('#lib/components/pages/biblioteca/archive.ts', async (original) => {
	const module = await original<typeof import('#lib/components/pages/biblioteca/archive.ts')>();
	return {
		...module,
		archiveTapes: (items: readonly LibraryItem[]) => mocks.tapes ?? module.archiveTapes(items)
	};
});
vi.mock('#lib/components/pages/biblioteca/sheet-export.ts', async (original) => ({
	...(await original<typeof import('#lib/components/pages/biblioteca/sheet-export.ts')>()),
	downloadBlob: vi.fn()
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

type GateCommit = (input: Omit<CommitInput, 'type'>) => Promise<CommitResult>;
let workers: { commit: ReturnType<typeof vi.fn<GateCommit>>; dispose: ReturnType<typeof vi.fn> }[] =
	[];

beforeEach(() => {
	workers = [];
	mocks.tapes = null;
	mocks.worker.mockReset().mockImplementation(() => {
		const worker = {
			commit: vi.fn<GateCommit>(async (input) => ({
				type: 'commit',
				id: 1,
				verdict: gateForWrite(input.bands, input.preampDb)
			})),
			dispose: vi.fn()
		};
		workers.push(worker);
		return worker;
	});
	mocks.tap
		.mockReset()
		.mockImplementation(async () => ({ disconnect: vi.fn(), subscribe: () => vi.fn() }));
	vi.mocked(downloadBlob).mockReset();
});

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

function local(name = 'Local curve', preampDb = -3): LibraryItem {
	const curve = { ...neutralCurve(), name, preampDb };
	return { ...curve, id: name, s1: encodeS1(curve), favorite: false, createdAt: 0, updatedAt: 1 };
}

function fakeApp(
	options: {
		loading?: boolean;
		error?: boolean;
		items?: LibraryItem[];
		curve?: CurveData | null;
	} = {}
) {
	let state: AudioEngineState = { ...IDLE_STATE };
	const listeners = new Set<(state: AudioEngineState) => void>();
	const audio = {
		state: () => state,
		onChange: (listener: (state: AudioEngineState) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getMeterBus: () => meterBus,
		getSourceBus: () => sourceBus
	};
	const meterBus = {} as AudioNode;
	const sourceBus = {} as AudioNode;
	const library = {
		items: options.items ?? [],
		loading: options.loading ?? false,
		error: options.error ?? false,
		save: vi.fn<(curve: CurveData) => Promise<LibraryItem | null>>(async () => local())
	};
	const app = {
		audio,
		yolo: createYoloState(),
		state: {
			library,
			curve: { current: options.curve === undefined ? neutralCurve() : options.curve },
			meterRef: { value: -18 }
		}
	};
	return {
		app: app as unknown as ClientApp,
		library,
		audio,
		listeners,
		emit(next: Partial<AudioEngineState>) {
			state = { ...state, ...next };
			for (const listener of listeners) listener(state);
		}
	};
}

test('without the runtime, save explains its aria-disabled state and the local shelf is loading', async () => {
	const screen = await render(Biblioteca, { origin: 'https://example.test' });
	const save = page.getByRole('button', { name: m.biblioteca_save(), exact: true });
	await expect.element(save).toHaveAttribute('aria-disabled', 'true');
	await expect.element(save).toHaveAccessibleDescription(m.biblioteca_reason_loading());
	(save.element() as HTMLButtonElement).click();
	expect(
		screen.container.querySelector('[data-tour="biblioteca-shelf"] [aria-busy="true"]')
	).not.toBeNull();
	expect(screen.container.querySelector('.library-empty')).toBeNull();
});

test('restoration, empty and storage-error shelves are distinct, with no misleading empty state on error', async () => {
	const loading = fakeApp({ loading: true, curve: null });
	const screen = await render(Biblioteca, { app: loading.app, origin: 'https://example.test' });
	expect(
		screen.container.querySelector('[data-tour="biblioteca-shelf"] [aria-busy="true"]')
	).not.toBeNull();
	const empty = fakeApp();
	await screen.rerender({ app: empty.app });
	await expect.element(page.getByText(m.empty_library_title())).toBeVisible();
	expect(screen.container.querySelectorAll('.example-box')).toHaveLength(3);
	const failed = fakeApp({ error: true });
	await screen.rerender({ app: failed.app });
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.biblioteca_local_error());
	expect(screen.container.querySelector('.library-empty')).toBeNull();
	expect(screen.container.querySelectorAll('.example-box')).toHaveLength(0);
	expect(loading.listeners.size).toBe(0);
	expect(empty.listeners.size).toBe(0);
});

test('saving the editor curve is single-flight and announces success before unlocking', async () => {
	const client = fakeApp({ curve: { ...neutralCurve(), name: 'Editor', preampDb: -9 } });
	const pending = deferred<LibraryItem | null>();
	client.library.save.mockReturnValueOnce(pending.promise);
	await render(Biblioteca, { app: client.app, origin: 'https://example.test' });
	const button = page.getByRole('button', { name: m.biblioteca_save(), exact: true });
	await button.click();
	await expect.element(button).toHaveAttribute('aria-busy', 'true');
	(button.element() as HTMLButtonElement).click();
	expect(client.library.save).toHaveBeenCalledExactlyOnceWith(client.app.state.curve.current);
	pending.resolve(local('Editor', -9));
	await expect.element(page.getByText(m.biblioteca_saved(), { exact: true })).toBeVisible();
	await expect.element(button).not.toHaveAttribute('aria-busy', 'true');
});

// YOLO publication: the library save is class-based. A YOLO curve is saved (YOLO on or off) and
// its tape carries the YOLO badge; a rejected curve is refused with the gate's reason.
const yoloBands = [
	{ kind: 'HP' as const, freqHz: 30, qFactor: 0.71 },
	...neutralCurve().bands.slice(1)
];
const yoloEditor = (): CurveData => ({
	...neutralCurve(),
	name: 'Subsônica',
	preampDb: -0.5,
	bands: yoloBands
});

test('a YOLO editor curve is saved to the library and its tape shows the YOLO badge', async () => {
	const curve = yoloEditor();
	const savedItem: LibraryItem = {
		...curve,
		id: 'subsonica',
		s1: encodeS1(curve),
		favorite: false,
		createdAt: 0,
		updatedAt: 1
	};
	const client = fakeApp({ curve, items: [savedItem, local('Plain', -3)] });
	client.library.save.mockResolvedValueOnce(savedItem);
	const screen = await render(Biblioteca, { app: client.app, origin: 'https://example.test' });
	const button = page.getByRole('button', { name: m.biblioteca_save(), exact: true });
	await expect.element(button).not.toHaveAttribute('aria-disabled', 'true');
	await button.click();
	expect(client.library.save).toHaveBeenCalledExactlyOnceWith(curve);
	await expect
		.element(page.getByText(m.yolopub_library_saved_yolo(), { exact: true }))
		.toBeVisible();
	// Only the YOLO tape has the badge (derived from its bands; S1 and S5 carry no marker).
	const badges = screen.container.querySelectorAll('[data-curve-badge="yolo"]');
	expect(badges).toHaveLength(1);
	expect(badges[0]?.closest('.tape')?.textContent).toContain('Subsônica');
});

test('a rejected editor curve is not saved: the button says why', async () => {
	const boost = { kind: 'PK' as const, freqHz: 1000, gainDb: 9, qFactor: 1 };
	const curve: CurveData = {
		...neutralCurve(),
		name: 'Alta',
		preampDb: -0.5,
		bands: [boost, boost, boost, boost, ...neutralCurve().bands.slice(4)]
	};
	const client = fakeApp({ curve });
	await render(Biblioteca, { app: client.app, origin: 'https://example.test' });
	const button = page.getByRole('button', { name: m.biblioteca_save(), exact: true });
	await expect.element(button).toHaveAttribute('aria-disabled', 'true');
	(button.element() as HTMLButtonElement).click();
	expect(client.library.save).not.toHaveBeenCalled();
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`local cards, official comparison, sorting and tag reset work in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const saved = local('<img> Local', -7);
		const client = fakeApp({ items: [saved] });
		const screen = await render(Biblioteca, { app: client.app, origin: 'https://example.test' });
		const card = screen.container.querySelector('[data-tour="biblioteca-shelf"] .tape');
		expect(card?.querySelector('.serial')?.textContent).toBe('LOCAL');
		expect(card?.textContent).toContain(m.biblioteca_local_license());
		expect(card?.textContent).toContain(saved.name);
		expect(card?.querySelector('img')).toBeNull();
		expect(card?.querySelector('.tape-description')).toBeNull();
		expect(screen.container.querySelector('.library-empty')).toBeNull();
		const official = archiveTapes([]).find((tape) => tape.group === 'referencia');
		if (!official) throw new Error('Missing official reference');
		await page
			.getByRole('combobox', { name: m.biblioteca_current(), exact: true })
			.selectOptions(official.id);
		await expect
			.poll(() => card?.querySelector('.tape-bottom')?.textContent)
			.toContain(`RMS ${number(rmsTo(saved, official), locale, 2)}`);
		for (const sort of ['pre', 'distance', 'name', 'official']) {
			await page.getByRole('combobox', { name: m.biblioteca_sort() }).selectOptions(sort);
			expect(screen.container.querySelectorAll('.tape')).toHaveLength(12);
			const byName = new Map(archiveTapes([saved]).map((tape) => [tape.name, tape]));
			for (const shelf of screen.container.querySelectorAll('.shelf-group')) {
				const displayed = [...shelf.querySelectorAll('.tape .tape-label strong')].map(
					(node) => node.textContent ?? ''
				);
				if (sort === 'name') {
					expect(displayed).toEqual(
						[...displayed].sort(
							new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare
						)
					);
				} else {
					const values = displayed.map((name) => {
						const tape = byName.get(name);
						if (!tape) throw new Error(`Unknown tape ${name}`);
						return sort === 'pre'
							? tape.preampDb
							: sort === 'distance'
								? rmsTo(tape, official)
								: tape.order;
					});
					expect(values).toEqual([...values].sort((a, b) => a - b));
				}
			}
		}
		await page.getByRole('button', { name: m.biblioteca_flat(), exact: true }).click();
		await expect
			.element(page.getByRole('button', { name: m.biblioteca_flat(), exact: true }))
			.toHaveAttribute('aria-pressed', 'true');
		expect(screen.container.querySelector('.pack-box')).toBeNull();
		await page.getByRole('button', { name: m.biblioteca_all(), exact: true }).click();
		expect(screen.container.querySelector('.pack-box')).not.toBeNull();
		await page.getByRole('searchbox', { name: m.biblioteca_search() }).fill('   ');
		expect(screen.container.querySelector('.pack-box')).not.toBeNull();
	});
}

test('English uses translated descriptions or explicitly marks the original Portuguese', async () => {
	const [first, second] = archiveTapes([]);
	mocks.tapes = [
		{ ...first, description: 'Descrição original', descriptionEn: null },
		{ ...second, description: 'Outra descrição', descriptionEn: 'Translated description' }
	];
	await setLocale('en-US', { reload: false });
	await render(Biblioteca, { origin: 'https://example.test' });
	await expect
		.element(page.getByText('Descrição original', { exact: true }))
		.toHaveAttribute('lang', 'pt-BR');
	await expect
		.element(page.getByText('Translated description', { exact: true }))
		.toHaveAttribute('lang', 'en-US');
	await expect
		.element(page.getByText(m.biblioteca_original_description(), { exact: true }))
		.toBeVisible();
});

test('pack export downloads all 11 official presets rather than the filtered cards', async () => {
	await render(Biblioteca, { origin: 'https://example.test' });
	await page.getByRole('button', { name: m.biblioteca_pack_export(), exact: true }).click();
	await expect.poll(() => vi.mocked(downloadBlob).mock.calls.length).toBe(1);
	const [blob, name] = vi.mocked(downloadBlob).mock.calls[0];
	expect(name).toBe('open-auri-reference-pack.json');
	expect(blob.type).toBe('application/json');
	const pack: { presets: { name: string }[] } = JSON.parse(await blob.text());
	expect(pack.presets).toHaveLength(11);
	expect(pack.presets.map((preset) => preset.name)).toEqual(
		OFFICIAL_PRESETS.map((preset) => preset.label)
	);
	expect(blob.size).toBeGreaterThan(100);
});

test('optional account shelves load lazily and display the signed-out invite', async () => {
	const screen = await render(Biblioteca, {
		origin: 'https://example.test',
		social: {
			session: createSocialSession({ initial: null }),
			api: createSocialApi(),
			currentPath: '/biblioteca?from=archive'
		}
	});
	screen.container.querySelector('.account-card')?.scrollIntoView();
	await expect
		.element(page.getByRole('heading', { name: m.biblioteca_social_title(), exact: true }))
		.toBeVisible();
	await expect
		.element(page.getByRole('link', { name: m.biblioteca_social_signin_link() }))
		.toBeVisible();
});

test('gate failures announce the error; replacing the monitored curve disposes the previous worker', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const pending = deferred<CommitResult>();
	mocks.worker.mockImplementationOnce(() => {
		const worker = { commit: vi.fn<GateCommit>(() => pending.promise), dispose: vi.fn() };
		workers.push(worker);
		return worker;
	});
	const screen = await render(Biblioteca, { origin: 'https://example.test' });
	pending.reject(new Error('gate failed'));
	await expect.element(page.getByText(m.biblioteca_gate_error(), { exact: true })).toBeVisible();
	await screen.rerender({ app: fakeApp({ curve: { ...neutralCurve(), preampDb: -6 } }).app });
	expect(workers[0].dispose).toHaveBeenCalledOnce();
	await expect.poll(() => workers.length).toBe(2);
	await screen.unmount();
	expect(workers[1].dispose).toHaveBeenCalledOnce();
});

for (const outcome of ['resolve', 'reject'] as const) {
	test(`a gate ${outcome} after teardown does not update or announce a stale result`, async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const pending = deferred<CommitResult>();
		mocks.worker.mockImplementationOnce(() => ({
			commit: () => pending.promise,
			dispose: vi.fn()
		}));
		const screen = await render(Biblioteca, { origin: 'https://example.test' });
		await screen.unmount();
		if (outcome === 'resolve')
			pending.resolve({ type: 'commit', id: 1, verdict: gateForWrite(neutralCurve().bands, 0) });
		else pending.reject(new Error('late gate failure'));
		await pending.promise.catch(() => undefined);
		await tick();
		expect(log).not.toHaveBeenCalled();
	});
}

test('meter subscriptions disconnect, unsubscribe and reset to DATA when audio becomes unavailable', async () => {
	const handles = [0, 1].map(() => ({
		disconnect: vi.fn(),
		unsubscribe: vi.fn()
	}));
	mocks.tap.mockImplementation(async () => {
		const handle = handles[mocks.tap.mock.calls.length - 1];
		return {
			disconnect: handle.disconnect,
			subscribe: (listener: (update: MeterUpdate) => void) => {
				listener({ mode: 'live', frame: null });
				return handle.unsubscribe;
			}
		};
	});
	const client = fakeApp();
	const screen = await render(Biblioteca, { app: client.app, origin: 'https://example.test' });
	client.emit({ ready: true });
	await expect.poll(() => mocks.tap.mock.calls.length).toBe(2);
	await tick();
	client.emit({ ready: false });
	await expect
		.poll(() => handles.map((handle) => handle.disconnect.mock.calls.length))
		.toEqual([1, 1]);
	expect(handles.map((handle) => handle.unsubscribe.mock.calls.length)).toEqual([1, 1]);
	expect(screen.container.querySelector('.console')?.getAttribute('data-mode')).toBe('data');
	await screen.unmount();
	expect(client.listeners.size).toBe(0);
});

for (const outcome of ['resolve', 'reject'] as const) {
	test(`a meter ${outcome} after teardown is cleaned up silently`, async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const pending = deferred<{
			disconnect: ReturnType<typeof vi.fn>;
			subscribe: ReturnType<typeof vi.fn>;
		}>();
		mocks.tap.mockReturnValue(pending.promise);
		const client = fakeApp();
		const screen = await render(Biblioteca, { app: client.app, origin: 'https://example.test' });
		client.emit({ ready: true });
		await expect.poll(() => mocks.tap.mock.calls.length).toBe(2);
		await screen.unmount();
		const source = { disconnect: vi.fn(), subscribe: vi.fn() };
		if (outcome === 'resolve') pending.resolve(source);
		else pending.reject(new Error('late meter failure'));
		await pending.promise.catch(() => undefined);
		await tick();
		if (outcome === 'resolve') {
			expect(source.disconnect).toHaveBeenCalledTimes(2);
			expect(source.subscribe).not.toHaveBeenCalled();
		}
		expect(log).not.toHaveBeenCalled();
	});
}

test('a live meter startup failure is announced without removing the archive', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => undefined);
	mocks.tap.mockRejectedValue(new Error('worklet refused'));
	const client = fakeApp();
	const screen = await render(Biblioteca, { app: client.app, origin: 'https://example.test' });
	client.emit({ ready: true });
	await expect.element(page.getByText(m.biblioteca_audio_error(), { exact: true })).toBeVisible();
	expect(screen.container.querySelectorAll('.tape')).toHaveLength(11);
});
