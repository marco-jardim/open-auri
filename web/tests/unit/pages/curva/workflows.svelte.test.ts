import '../../primitives/design-system.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO, OFFICIAL_PRESETS, PADRAO_AURI } from 'open-auri/catalog';
import { createClientApp, type ClientApp } from '#lib/app/index.ts';
import { AudioEngineError, type AudioErrorCode } from '#lib/audio/engine.ts';
import { m } from '#lib/paraglide/messages.js';
import { handleGateRequest } from '#lib/workers/gate-handler.ts';
import CurvaPage from '#lib/components/pages/curva/CurvaPage.svelte';
import { exportS5, linkHash } from '#lib/components/pages/curva/io.ts';
import type { GateClient } from '#lib/components/pages/curva/drag.ts';
import type { Layer } from '#lib/components/pages/curva/layers.ts';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import { firstReasonText } from '#lib/components/pages/curva/reasons.ts';
import { fakeAppOptions } from '../../app/fakes.ts';

const neutral: Curve = { bands: NEUTRO.bands, preampDb: NEUTRO.preampDb };
const cut: Band = { kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 };
const pad = (bands: Band[]) => [...bands, ...NEUTRO.bands.slice(bands.length)];
const apps: ClientApp[] = [];

afterEach(async () => {
	await cleanup();
	for (const app of apps.splice(0)) app.dispose();
	vi.restoreAllMocks();
});

function gateClient(): GateClient {
	let id = 0;
	return {
		async drag(input) {
			const result = handleGateRequest({ ...input, type: 'drag', id: ++id });
			if (result.type !== 'drag') throw new Error('Unexpected drag response');
			return result;
		},
		async commit(input) {
			const result = handleGateRequest({ ...input, type: 'commit', id: ++id });
			if (result.type !== 'commit') throw new Error('Unexpected commit response');
			return result;
		}
	};
}

async function setup(
	layer: Layer = 'ajustar',
	curve: Curve | null = neutral,
	hash = '',
	gate = gateClient(),
	/** null renders without the prop, to exercise the native default. */
	clearLinkHash: (() => void) | null = vi.fn()
) {
	const app = createClientApp(fakeAppOptions().options);
	apps.push(app);
	await app.state.ready;
	if (curve) app.state.curve.set({ ...curve, name: 'Editor', source: 'custom' });
	const onlayer = vi.fn();
	const screen = await render(CurvaPage, {
		app,
		layer,
		hash,
		pageUrl: new URL('https://example.test/'),
		onlayer,
		gateClient: gate,
		clearLinkHash: clearLinkHash ?? undefined
	});
	await tick();
	return { app, screen, onlayer, clearLinkHash };
}

function importFile(container: HTMLElement, text: string, name = 'curve.txt') {
	const input = container.querySelector('input[type="file"]');
	if (!(input instanceof HTMLInputElement)) throw new Error('Missing import input');
	const files = new DataTransfer();
	files.items.add(new File([text], name));
	input.files = files.files;
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

function changeRange(element: Element, value: number) {
	if (!(element instanceof HTMLInputElement)) throw new Error('Missing macro range');
	element.valueAsNumber = value;
	element.dispatchEvent(new Event('change', { bubbles: true }));
}

function pointerEditor(container: HTMLElement) {
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => undefined);
	const overlay = container.querySelector('svg.handles');
	if (!overlay) throw new Error('Missing handle overlay');
	const rect = overlay.getBoundingClientRect();
	return (type: string, horizontal = 0.4) => {
		handle.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				pointerId: 7,
				clientX: rect.left + rect.width * horizontal,
				clientY: rect.top + rect.height * 0.65
			})
		);
	};
}

/** The first bank module's kind dial (the bank is a deferred island: wait for it). */
async function kindDial(): Promise<HTMLElement> {
	const dial = page.getByRole('spinbutton', { name: m.curva_kind(), exact: true }).first();
	await expect.element(dial).toBeInTheDocument();
	const element = dial.element();
	if (!(element instanceof HTMLElement)) throw new Error('Missing kind dial');
	return element;
}

/** One click-step (clockwise) or key on the kind dial. */
async function turn(key: 'click' | 'ArrowLeft' | 'Home' = 'click') {
	const dial = await kindDial();
	dial.dispatchEvent(
		key === 'click'
			? new MouseEvent('click', { bubbles: true })
			: new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
	);
	await tick();
	return dial;
}

function deferred<T>() {
	let resolve: (value: T) => void = () => {
		throw new Error('Deferred response not initialised');
	};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test('fresh-profile chrome stays clear despite unknown cable contents, then follows unsaved edits', async () => {
	const { app, screen } = await setup('ouvir', null);
	expect(app.state.curve.dirty).toBe(true);
	expect(app.state.curve.unsaved).toBe(false);
	expect(screen.container.querySelector('.np-dirty')).toBeNull();
	expect(screen.container.querySelector('.ps-res .dirty')?.textContent).toContain(m.curva_saved());
	expect(screen.container.textContent).not.toContain(m.curva_unsaved());

	expect(app.state.curve.update({ preampDb: -1 })).toBe(true);
	await tick();
	expect(app.state.curve.unsaved).toBe(true);
	expect(screen.container.querySelector('.np-dirty')?.textContent).toBe(m.curva_unsaved());
	expect(screen.container.querySelector('.ps-res .dirty.on')?.textContent).toContain(
		m.curva_unsaved()
	);

	// Model a successful real write; neither indicator should remain on.
	expect(app.state.curve.markWritten()).toBe(true);
	await tick();
	expect(app.state.curve.dirty).toBe(false);
	expect(app.state.curve.unsaved).toBe(false);
	expect(screen.container.querySelector('.np-dirty')).toBeNull();
	expect(screen.container.querySelector('.ps-res .dirty.on')).toBeNull();
	expect(screen.container.querySelector('.ps-res .dirty')?.textContent).toContain(m.curva_saved());
	expect(app.pendingWrite).toBeNull();
});

test('presets, undo/redo, neutral/default and rescue change only the editor or checklist', async () => {
	const { app } = await setup('ouvir');
	const preset = OFFICIAL_PRESETS.find((item) => item.id !== PADRAO_AURI.id);
	if (!preset) throw new Error('Missing preset');
	await page.getByRole('button', { name: preset.label, exact: true }).click();
	expect(app.state.curve.current.source).toBe(`preset:${preset.id}`);
	expect(app.state.curve.current.bands).toEqual(preset.bands);
	await page.getByRole('button', { name: m.curva_undo(), exact: true }).click();
	expect(app.state.curve.current.name).toBe('Editor');
	await page.getByRole('button', { name: m.curva_redo(), exact: true }).click();
	expect(app.state.curve.current.bands).toEqual(preset.bands);
	await page.getByRole('button', { name: m.curva_rescue_neutral(), exact: true }).click();
	expect(app.state.curve.current.bands).toEqual(NEUTRO.bands);
	await page.getByRole('button', { name: m.curva_rescue_default(), exact: true }).click();
	expect(app.state.curve.current.bands).toEqual(PADRAO_AURI.bands);
	expect(app.pendingWrite).toBeNull();
	const request = vi.spyOn(app, 'requestRescue');
	await page.getByRole('button', { name: m.curva_rescue_cable(), exact: true }).click();
	expect(request).toHaveBeenCalledOnce();
	expect(app.pendingWrite?.bands).toEqual(NEUTRO.bands);
});

test('valid file import is undoable and bad JSON/TXT and oversized files preserve the editor', async () => {
	const { app, screen } = await setup();
	const before = app.state.curve.current;
	const notify = vi.spyOn(app.toasts, 'push');
	let failures = 0;
	for (const [text, name] of [
		['{"format":', 'bad.json'],
		['Filter 1: ON PK Fc abc Hz Gain 1 dB Q 1', 'bad.txt'],
		['x'.repeat(65537), 'large.txt'],
		['Preamp: -1 dB\nFilter 1: ON HS Fc 8000 Hz Gain -3 dB Q 0.7', 'hs.txt']
	]) {
		importFile(screen.container, text, name);
		failures += 1;
		await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(failures));
		expect(screen.container.textContent).toContain('Nada foi carregado no editor:');
		expect(app.state.curve.current).toEqual(before);
	}
	importFile(screen.container, 'Preamp: -1 dB\nFilter 1: ON PK Fc 1000 Hz Gain -6 dB Q 1\n');
	await vi.waitFor(() => expect(app.state.curve.current.source).toBe('import'));
	expect(app.state.curve.current.bands[0]).toEqual(cut);
	expect(app.state.curve.current.name).toBe(m.curva_name_imported());
	expect(app.state.curve.current.preampDb).toBe(-1);
	expect(app.pendingWrite).toBeNull();
	await page.getByRole('button', { name: m.curva_undo(), exact: true }).click();
	expect(app.state.curve.current).toMatchObject({
		name: before.name,
		source: before.source,
		bands: before.bands,
		preampDb: before.preampDb
	});
});

test('each new link loads once while Curva stays mounted, without navigating or writing', async () => {
	const linked: Curve = { bands: pad([cut]), preampDb: -1 };
	const hash = linkHash(linked, 'ajustar');
	if (!hash.ok) throw new Error('Invalid linked fixture');
	const { app, screen, clearLinkHash } = await setup('ajustar', neutral, hash.value);
	const notify = vi.spyOn(app.toasts, 'push');
	await vi.waitFor(() => expect(app.state.curve.current.source).toBe('import'));
	expect(app.state.curve.current.bands).toEqual(linked.bands);
	expect(app.state.curve.current.name).toBe(m.curva_name_link());
	// The consumed link leaves the address bar, so a reload does not apply it again.
	expect(clearLinkHash).toHaveBeenCalledOnce();
	notify.mockClear();
	await screen.rerender({ hash: '' });
	await screen.rerender({ hash: hash.value, layer: 'engenharia' });
	await tick();
	expect(clearLinkHash).toHaveBeenCalledOnce();

	const second: Curve = { bands: pad([{ ...cut, gainDb: -3 }]), preampDb: -2 };
	const secondHash = linkHash(second, 'ajustar');
	if (!secondHash.ok) throw new Error('Invalid second linked fixture');
	await screen.rerender({ hash: secondHash.value });
	await vi.waitFor(() => expect(app.state.curve.current.bands).toEqual(second.bands));
	expect(app.state.curve.current.preampDb).toBe(second.preampDb);
	expect(clearLinkHash).toHaveBeenCalledTimes(2);
	expect(notify).toHaveBeenCalledWith(m.curva_link_loaded(), { tone: 'info' });

	// Rerendering or changing layers must not reload a consumed link over a later edit.
	app.state.curve.update({ preampDb: -3 });
	await screen.rerender({ hash: '' });
	await screen.rerender({ hash: secondHash.value, layer: 'ajustar' });
	await tick();
	expect(app.state.curve.current.preampDb).toBe(-3);
	expect(clearLinkHash).toHaveBeenCalledTimes(2);
	const beforeRefusal = app.state.curve.current;
	await screen.rerender({ hash: '#p=broken' });
	await vi.waitFor(() => expect(clearLinkHash).toHaveBeenCalledTimes(3));
	expect(app.state.curve.current).toEqual(beforeRefusal);
	expect(screen.container.textContent).toContain(
		m.curva_link_refused({ reason: m.curva_io_error_link() })
	);
	await screen.rerender({ hash: '#section' });
	await screen.rerender({ hash: '#p=broken', layer: 'engenharia' });
	await tick();
	expect(clearLinkHash).toHaveBeenCalledTimes(3);
	expect(notify).toHaveBeenCalledTimes(2);
	expect(app.pendingWrite).toBeNull();
});

test('empty and unrelated hashes do not prevent a later link from loading', async () => {
	const { app, screen, clearLinkHash } = await setup('ajustar', neutral, '');
	await app.state.ready;
	await screen.rerender({ hash: '#section' });
	await tick();
	expect(clearLinkHash).not.toHaveBeenCalled();
	expect(app.state.curve.current.source).toBe('custom');
	const linked: Curve = { bands: pad([cut]), preampDb: -1 };
	const hash = linkHash(linked, 'ajustar');
	if (!hash.ok) throw new Error('Invalid linked fixture');
	await screen.rerender({ hash: hash.value });
	await vi.waitFor(() => expect(app.state.curve.current.source).toBe('import'));
	expect(app.state.curve.current.bands).toEqual(linked.bands);
	expect(clearLinkHash).toHaveBeenCalledOnce();
});

test('by default the consumed link is removed with history.replaceState, keeping path, query and state', async () => {
	const original = window.location.href;
	const state = window.history.state;
	const linked: Curve = { bands: pad([cut]), preampDb: -1 };
	const hash = linkHash(linked, 'ajustar');
	if (!hash.ok) throw new Error('Invalid linked fixture');
	const address = new URL(window.location.href);
	address.hash = hash.value;
	window.history.replaceState(state, '', address.href);
	const replace = vi.spyOn(window.history, 'replaceState');
	try {
		const { app } = await setup('ajustar', neutral, hash.value, gateClient(), null);
		await vi.waitFor(() => expect(app.state.curve.current.source).toBe('import'));
		expect(window.location.hash).toBe('');
		expect(window.location.pathname + window.location.search).toBe(
			address.pathname + address.search
		);
		expect(replace).toHaveBeenCalledExactlyOnceWith(state, '', address.pathname + address.search);
	} finally {
		replace.mockRestore();
		window.history.replaceState(state, '', original);
	}
});

test.each(['#p=broken', '#p='])(
	'broken link %s is announced without replacing the current curve',
	async (hash) => {
		const { app, screen, clearLinkHash } = await setup('ajustar', neutral, hash);
		await vi.waitFor(() =>
			expect(screen.container.textContent).toContain(
				m.curva_link_refused({ reason: m.curva_io_error_link() })
			)
		);
		expect(app.state.curve.current.source).toBe('custom');
		expect(app.state.curve.current.bands).toEqual(NEUTRO.bands);
		// A refused link is reported once, then removed too.
		expect(clearLinkHash).toHaveBeenCalledOnce();
	}
);

test('macros accumulate against one base and reset their readouts after undo', async () => {
	const { app } = await setup('ouvir');
	const bass = page.getByRole('slider', { name: /Grave/ });
	changeRange(bass.element(), -1);
	await tick();
	expect(app.state.curve.current.bands[0]).toMatchObject({ kind: 'LS', gainDb: -1 });
	changeRange(bass.element(), -2);
	await tick();
	expect(app.state.curve.current.bands[0]).toMatchObject({ gainDb: -2 });
	changeRange(page.getByRole('slider', { name: /Corpo/ }).element(), -1);
	await tick();
	expect(app.state.curve.current.bands[0]).toMatchObject({ gainDb: -2 });
	expect(app.state.curve.current.bands[1]).toMatchObject({ kind: 'PK', freqHz: 500, gainDb: -1 });
	await page.getByRole('button', { name: m.curva_undo(), exact: true }).click();
	await expect.element(bass).toHaveAttribute('aria-valuetext', '0,0 dB');
	expect(app.pendingWrite).toBeNull();
});

test('a bounded macro reports why it could not reach the requested boost', async () => {
	const { app, screen } = await setup('ouvir', {
		bands: pad([{ kind: 'PK', freqHz: 15000, gainDb: 3, qFactor: 1 }]),
		preampDb: -6
	});
	changeRange(page.getByRole('slider', { name: /Brilho/ }).element(), 6);
	await vi.waitFor(() => expect(screen.container.textContent).toContain('Brilho parou em'));
	const first = app.state.curve.current.bands[0];
	if (first?.kind !== 'PK') throw new Error('Expected PK band');
	expect(first.gainDb).toBeGreaterThan(3);
	expect(first.gainDb).toBeLessThan(9);
});

test('bank kind changes, typed gate-bounded edits and restoring default order are undoable', async () => {
	const { app } = await setup('ajustar', { bands: pad([cut]), preampDb: -1 });
	// Ajustar's dial steps clockwise PK → LS → OFF → PK, each stop through the gate.
	await turn();
	await vi.waitFor(() => expect(app.state.curve.current.bands[0]).toMatchObject({ kind: 'LS' }));
	await turn();
	await vi.waitFor(() => expect(app.state.curve.current.bands[0]).toEqual({ kind: 'OFF' }));
	await turn();
	await vi.waitFor(() => expect(app.state.curve.current.bands[0]).toMatchObject({ kind: 'PK' }));
	const frequency = page
		.getByRole('spinbutton', { name: 'Freq (Hz)', exact: true })
		.first()
		.element();
	if (!(frequency instanceof HTMLInputElement)) throw new Error('Missing frequency field');
	frequency.valueAsNumber = 1500;
	frequency.dispatchEvent(new Event('change', { bubbles: true }));
	await vi.waitFor(() => expect(app.state.curve.current.bands[0]).toMatchObject({ freqHz: 1500 }));
	await page.getByRole('button', { name: m.curva_order_reset(), exact: true }).click();
	expect(app.state.curve.canUndo).toBe(true);
});

test.each([
	['gesture', 'curva_preview_error_gesture'],
	['suspended', 'curva_preview_error_suspended'],
	['unsupported', 'curva_preview_error_unsupported'],
	['invalid-file', 'curva_preview_error_failed']
] as const satisfies readonly (readonly [AudioErrorCode, keyof typeof m])[])(
	'page translates preview failure %s',
	async (code, key) => {
		const { app } = await setup('ouvir');
		vi.spyOn(app.audio, 'createAB').mockImplementationOnce(() => {
			throw new AudioEngineError(code);
		});
		await page.getByRole('button', { name: m.curva_preview(), exact: true }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(m[key]());
		await expect
			.element(page.getByRole('button', { name: m.curva_preview(), exact: true }))
			.toHaveAttribute('aria-pressed', 'false');
	}
);

test('worker errors are reported, whereas aborted edits leave the curve untouched without an error', async () => {
	const client = gateClient();
	const commit = vi.spyOn(client, 'commit');
	const { app, screen } = await setup('ajustar', { bands: pad([cut]), preampDb: -1 }, '', client);
	const error = new Error('worker unavailable');
	const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	commit.mockRejectedValueOnce(error);
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
	await vi.waitFor(() => expect(screen.container.textContent).toContain(m.curva_gate_error()));
	expect(log).toHaveBeenCalledWith('Gate worker failed', error);
	expect(app.state.curve.current.bands[0]).toEqual(cut);
	log.mockClear();
	commit.mockRejectedValueOnce(new DOMException('superseded', 'AbortError'));
	handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
	await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
	await tick();
	expect(log).not.toHaveBeenCalled();
	expect(app.state.curve.current.bands[0]).toEqual(cut);
});

test('layer shortcuts yield to modal dialogs', async () => {
	const { screen, onlayer } = await setup();
	const modal = document.createElement('div');
	modal.setAttribute('role', 'dialog');
	modal.setAttribute('aria-modal', 'true');
	screen.container.append(modal);
	window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
	expect(onlayer).not.toHaveBeenCalled();
	modal.remove();
	window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
	expect(onlayer).toHaveBeenCalledExactlyOnceWith('ouvir');
});

test('before client mount the neutral page is readable and write/preview/import are disabled', async () => {
	await render(CurvaPage, {
		app: null,
		layer: 'ouvir',
		hash: '',
		pageUrl: new URL('https://example.test/'),
		onlayer: vi.fn(),
		gateClient: gateClient()
	});
	await expect.element(page.getByRole('heading', { name: 'Curva', exact: true })).toBeVisible();
	// Unavailable, focusable and saying why (T8): the editor is still loading.
	for (const name of [m.curva_write(), m.curva_export_txt(), m.curva_rescue_neutral()]) {
		const button = page.getByRole('button', { name, exact: true });
		await expect.element(button).toHaveAttribute('aria-disabled', 'true');
		await expect.element(button).toHaveAccessibleDescription(m.curva_v2_loading_reason());
	}
	const lever = page.getByRole('button', { name: m.curva_preview(), exact: true });
	await expect.element(lever).toHaveAttribute('aria-disabled', 'true');
	await expect.element(lever).toHaveAccessibleDescription(m.curva_v2_preview_unavailable());
});

test('named S5 imports preserve metadata and report editor refusal', async () => {
	const { app, screen } = await setup();
	const result = exportS5(
		{ bands: pad([cut]), preampDb: -1 },
		{ name: 'Named import', source: 'custom', lang: 'pt-BR', now: 0 },
		'ajustar'
	);
	if (!result.ok) throw new Error('Invalid named import fixture');
	importFile(screen.container, result.value, 'named.json');
	await vi.waitFor(() => expect(app.state.curve.current.name).toBe('Named import'));
	expect(app.state.curve.current.source).toBe('import');
	const before = app.state.curve.current;
	const set = vi.spyOn(app.state.curve, 'set').mockReturnValueOnce(false);
	importFile(screen.container, 'Preamp: -0.5 dB\n');
	await vi.waitFor(() =>
		expect(screen.container.textContent).toContain(
			m.curva_import_refused({ reason: m.curva_io_error_format() })
		)
	);
	expect(set).toHaveBeenCalledOnce();
	expect(app.state.curve.current).toEqual(before);
});

test('the engineering sequencer stays disabled with the loading or writing reason exposed', async () => {
	const { app, screen } = await setup('engenharia');
	const request = vi.spyOn(app, 'requestWrite');
	const send = page.getByRole('button', { name: m.curva_seq_send(), exact: true });
	const sequencer = page.getByRole('group', { name: m.curva_seq_heading(), exact: true });
	/** Re-queried after every rerender: a detached node would swallow the click trivially. */
	const liveSend = (): HTMLButtonElement => {
		const button = send.element();
		if (!(button instanceof HTMLButtonElement)) throw new Error('Missing sequencer send button');
		expect(button.isConnected).toBe(true);
		return button;
	};
	await expect.element(send).not.toBeDisabled();
	await expect.element(sequencer).not.toHaveAttribute('aria-describedby');

	await screen.rerender({ app: null });
	await expect.element(send).toBeDisabled();
	await expect.element(sequencer).toHaveAttribute('disabled');
	await expect.element(sequencer).toHaveAccessibleDescription(m.curva_v2_loading_reason());
	await expect
		.element(sequencer.getByText(m.curva_v2_loading_reason(), { exact: true }))
		.toBeVisible();
	liveSend().click();
	expect(request).not.toHaveBeenCalled();

	const state = vi
		.spyOn(app, 'cableState', 'get')
		.mockReturnValue({ ...app.cableState, writing: true });
	await screen.rerender({ app });
	await expect.element(send).toBeDisabled();
	await expect.element(sequencer).toHaveAttribute('disabled');
	await expect.element(sequencer).toHaveAccessibleDescription(m.curva_v2_writing_reason());
	await expect
		.element(sequencer.getByText(m.curva_v2_writing_reason(), { exact: true }))
		.toBeVisible();
	liveSend().click();
	expect(request).not.toHaveBeenCalled();

	state.mockRestore();
	await screen.rerender({ app: null });
	await screen.rerender({ app });
	await expect.element(send).not.toBeDisabled();
	await expect.element(sequencer).not.toHaveAttribute('aria-describedby');
});

test('removing a compensating cut is gate-refused instead of exposing its boost', async () => {
	const boost: Band = { ...cut, gainDb: 6 };
	const { app } = await setup('ajustar', { bands: pad([cut, boost]), preampDb: -1 });
	const before = app.state.curve.current;
	// The same full-curve gate a write uses refuses the cut's removal (its boost would be exposed).
	const candidate: Curve = { bands: pad([{ kind: 'OFF' }, boost]), preampDb: -1 };
	const refused = verdictFor(candidate);
	expect(refused.ok).toBe(false);
	const reason = firstReasonText(refused.reasons, { bands: candidate.bands, locale: 'pt-BR' });
	// Home asks the dial for OFF: the refusal is pending-invalid on the dial, never applied.
	const dial = await turn('Home');
	await vi.waitFor(() => expect(dial.getAttribute('aria-invalid')).toBe('true'));
	expect(dial.querySelector('.value')?.textContent).toBe('OFF ✕');
	const pending = m.curva_kinddial_pending({ kind: 'OFF', reason });
	expect(dial.getAttribute('aria-valuetext')).toBe(pending);
	expect(dial.parentElement?.querySelector('[role="status"]')?.textContent).toBe(pending);
	expect(app.state.curve.current).toEqual(before);
	expect(dial.closest('li.module')?.querySelector('.mod-badge')?.getAttribute('data-kind')).toBe(
		'PK'
	);
	expect(app.pendingWrite).toBeNull();
});

test("Ajustar's dial never offers HS/LP/HP", async () => {
	const { app } = await setup('ajustar', { bands: pad([cut]), preampDb: -1 });
	const dial = await kindDial();
	// The experimental stops are engraved but dimmed, and the legend says they are Engenharia-only.
	const dimmed = [...dial.querySelectorAll('.mark.dim')].map((mark) => mark.textContent);
	expect(dimmed).toEqual(['HS', 'LP', 'HP']);
	const legend = dial.parentElement?.querySelectorAll('[role="tooltip"] li.dim') ?? [];
	expect([...legend].map((item) => item.querySelector('.kd-k')?.textContent)).toEqual([
		'HS',
		'HP',
		'LP'
	]);
	for (const item of legend) expect(item.textContent).toContain(m.curva_bn_locked());
	// A full turn each way lands only on PK, LS and OFF (clockwise, then backwards).
	const experimental = new Set(['HS', 'LP', 'HP']);
	for (const [key, kind] of [
		['click', 'LS'],
		['click', 'OFF'],
		['click', 'PK'],
		['ArrowLeft', 'OFF'],
		['ArrowLeft', 'LS'],
		['ArrowLeft', 'PK']
	] as const) {
		const turned = await turn(key);
		await vi.waitFor(() => expect(app.state.curve.current.bands[0]?.kind).toBe(kind));
		expect(app.state.curve.current.bands.some((band) => experimental.has(band.kind))).toBe(false);
		expect(turned.getAttribute('aria-valuetext')).not.toMatch(/\b(HS|LP|HP)\b/);
	}
	expect(app.pendingWrite).toBeNull();
});

test('pointer movement previews a draft and release alone commits it to the editor', async () => {
	const client = gateClient();
	const drag = vi.spyOn(client, 'drag');
	const commit = vi.spyOn(client, 'commit');
	const { app, screen } = await setup('ajustar', { bands: pad([cut]), preampDb: -1 }, '', client);
	const pointer = pointerEditor(screen.container);
	const handle = page.getByRole('slider', { name: /^Filtro A,/ });
	pointer('pointerdown');
	pointer('pointermove');
	await vi.waitFor(() => expect(handle.element().getAttribute('aria-valuenow')).not.toBe('1000'));
	expect(drag).toHaveBeenCalled();
	expect(commit).not.toHaveBeenCalled();
	expect(app.state.curve.current.bands[0]).toEqual(cut);
	const frequency = Number(handle.element().getAttribute('aria-valuenow'));
	pointer('pointerup');
	await vi.waitFor(() =>
		expect(app.state.curve.current.bands[0]).toMatchObject({ freqHz: frequency })
	);
	expect(commit).toHaveBeenCalledOnce();
	expect(app.pendingWrite).toBeNull();
});

test('a late advisory response cannot overwrite the newer pointer draft', async () => {
	const client = gateClient();
	const realDrag = client.drag;
	const pending = deferred<Awaited<ReturnType<GateClient['drag']>>>();
	const drag = vi.spyOn(client, 'drag').mockReturnValueOnce(pending.promise);
	const { app, screen } = await setup('ajustar', { bands: pad([cut]), preampDb: -1 }, '', client);
	const pointer = pointerEditor(screen.container);
	const handle = page.getByRole('slider', { name: /^Filtro A,/ });
	pointer('pointerdown');
	pointer('pointermove', 0.35);
	const first = drag.mock.calls[0]?.[0];
	if (!first) throw new Error('Missing first advisory request');
	pointer('pointermove', 0.6);
	await vi.waitFor(() => expect(handle.element().getAttribute('aria-valuenow')).not.toBe('1000'));
	const latest = handle.element().getAttribute('aria-valuenow');
	pending.resolve(await realDrag(first));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await tick();
	expect(handle.element().getAttribute('aria-valuenow')).toBe(latest);
	expect(app.state.curve.current.bands[0]).toEqual(cut);
});

test('a late commit cannot replace a newer keyboard edit', async () => {
	const client = gateClient();
	const realCommit = client.commit;
	const pending = deferred<Awaited<ReturnType<GateClient['commit']>>>();
	const commit = vi.spyOn(client, 'commit').mockReturnValueOnce(pending.promise);
	const { app } = await setup('ajustar', { bands: pad([cut]), preampDb: -1 }, '', client);
	const handle = page.getByRole('slider', { name: /^Filtro A,/ }).element();
	handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
	await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
	const first = commit.mock.calls[0]?.[0];
	if (!first) throw new Error('Missing first commit request');
	handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
	// Mock step: ↑/↓ move the gain by 1 dB.
	await vi.waitFor(() => expect(app.state.curve.current.bands[0]).toMatchObject({ gainDb: -7 }));
	pending.resolve(await realCommit(first));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(app.state.curve.current.bands[0]).toMatchObject({ gainDb: -7 });
	expect(app.pendingWrite).toBeNull();
});

test.each(['abort', 'failure'] as const)('advisory %s preserves the editor', async (kind) => {
	const client = gateClient();
	const cause =
		kind === 'abort' ? new DOMException('superseded', 'AbortError') : new Error('crash');
	const drag = vi.spyOn(client, 'drag').mockRejectedValueOnce(cause);
	const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const { app, screen } = await setup('ajustar', { bands: pad([cut]), preampDb: -1 }, '', client);
	const pointer = pointerEditor(screen.container);
	pointer('pointerdown');
	pointer('pointermove');
	await vi.waitFor(() => expect(drag).toHaveBeenCalledOnce());
	await tick();
	if (kind === 'failure') {
		await vi.waitFor(() => expect(screen.container.textContent).toContain(m.curva_gate_error()));
		expect(log).toHaveBeenCalledWith('Gate worker failed', cause);
	} else {
		expect(log).not.toHaveBeenCalled();
		expect(screen.container.textContent).not.toContain(m.curva_gate_error());
	}
	expect(app.state.curve.current.bands[0]).toEqual(cut);
});
