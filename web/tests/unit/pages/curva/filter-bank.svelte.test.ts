import '../../primitives/design-system.ts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import FilterBank from '#lib/components/pages/curva/FilterBank.svelte';
import type { KindCheck } from '#lib/components/pages/curva/KindDial.svelte';
import { bandOfKind, changeKind } from '#lib/components/pages/curva/edit.ts';
import type { Layer } from '#lib/components/pages/curva/layers.ts';
import {
	replaceBand,
	verdictFor,
	type Band,
	type BandKind,
	type Curve
} from '#lib/components/pages/curva/model.ts';
import { firstReasonText } from '#lib/components/pages/curva/reasons.ts';
import { m } from '#lib/paraglide/messages.js';

const cut: Band = { kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 };
const refusal = 'The candidate exceeds the full-curve limit.';
const pad = (bands: Band[]): Band[] => [...bands, ...NEUTRO.bands.slice(bands.length)];
const initial: Curve = { bands: pad([cut]), preampDb: -3 };

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
	await cleanup();
	vi.useRealTimers();
});

async function setup(layer: Layer = 'ajustar', invalid: BandKind[] = ['LS']) {
	const canApplyKind = vi.fn<(index: number, kind: BandKind) => KindCheck>((index, kind) => ({
		ok: !invalid.includes(kind),
		reason: `${index + 1}: ${refusal}`
	}));
	const onkind = vi.fn<(index: number, kind: BandKind) => void>();
	const onmove = vi.fn();
	const ondrag = vi.fn();
	const screen = await render(FilterBank, {
		curve: initial,
		verdict: verdictFor(initial),
		layer,
		locale: 'pt-BR',
		stages: [],
		canApplyKind,
		onkind,
		onmove,
		ondrag,
		onorder: vi.fn()
	});
	const module = screen.container.querySelector('li.module');
	const dial = module?.querySelector<HTMLElement>('.kind-dial [role="spinbutton"]');
	if (!module || !dial) throw new Error('Missing first bank module');
	const value = () => module.querySelector('.value')?.textContent;
	return { screen, module, dial, value, canApplyKind, onkind, onmove, ondrag };
}

async function click(dial: HTMLElement) {
	dial.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await tick();
}

test('pending is dial-only: bank, curve and all commit/preview callbacks stay unchanged', async () => {
	const { screen, module, dial, value, canApplyKind, onkind, onmove, ondrag } = await setup();
	const before = structuredClone(initial);
	const response = module.querySelector('.mini')?.innerHTML;
	const signs = module.querySelector('.signs')?.innerHTML;
	const meters = module.querySelector('.led-row')?.innerHTML;
	const envelope = screen.container.querySelector('.gaterow')?.innerHTML;
	await click(dial);
	expect(canApplyKind).toHaveBeenCalledExactlyOnceWith(0, 'LS');
	expect(value()).toBe('LS ✕');
	expect(module.querySelector('.value.invalid')).not.toBeNull();
	expect(module.querySelector('[role="status"]')?.textContent).toContain(refusal);
	expect(module.querySelector('[role="tooltip"]')?.textContent).toContain(refusal);
	expect(module.querySelector('.mod-badge')?.getAttribute('data-kind')).toBe('PK');
	expect(module.querySelector('.mini')?.innerHTML).toBe(response);
	expect(module.querySelector('.signs')?.innerHTML).toBe(signs);
	expect(module.querySelector('.led-row')?.innerHTML).toBe(meters);
	expect(screen.container.querySelector('.gaterow')?.innerHTML).toBe(envelope);
	expect(initial).toEqual(before);
	expect(onkind).not.toHaveBeenCalled();
	expect(onmove).not.toHaveBeenCalled();
	expect(ondrag).not.toHaveBeenCalled();
	expect(screen.container.querySelector('.bank-foot')?.textContent).toContain(m.curva_bn_kind_foot());
	await vi.advanceTimersByTimeAsync(5000);
	await tick();
	expect(value()).toBe('PK');
	expect(onkind).not.toHaveBeenCalled();
});

test.each([
	['ajustar', ['LS', 'OFF', 'PK']],
	['engenharia', ['LS', 'OFF', 'HS', 'LP', 'HP', 'PK']]
] satisfies [Layer, BandKind[]][])('bank wiring preserves the %s cycle', async (layer, cycle) => {
	const { screen, dial, value, onkind, canApplyKind } = await setup(layer, []);
	let curve = initial;
	for (const kind of cycle) {
		await click(dial);
		expect(onkind).toHaveBeenLastCalledWith(0, kind);
		curve = {
			bands: replaceBand(curve.bands, 0, bandOfKind(curve.bands[0] ?? cut, kind)),
			preampDb: curve.preampDb
		};
		await screen.rerender({ curve });
		expect(value()).toBe(kind);
	}
	expect(canApplyKind.mock.calls.map(([, kind]) => kind)).toEqual(cycle);
});

test('a second click advances pending and only the valid candidate is committed', async () => {
	const { screen, dial, value, canApplyKind, onkind } = await setup();
	await click(dial);
	await vi.advanceTimersByTimeAsync(3000);
	await click(dial);
	expect(canApplyKind.mock.calls).toEqual([
		[0, 'LS'],
		[0, 'OFF']
	]);
	expect(onkind).toHaveBeenCalledExactlyOnceWith(0, 'OFF');
	await screen.rerender({
		curve: { ...initial, bands: replaceBand(initial.bands, 0, { kind: 'OFF' }) }
	});
	expect(value()).toBe('OFF');
	await vi.advanceTimersByTimeAsync(5000);
	expect(value()).toBe('OFF');
});

test('another band edit cancels pending even though the applied kind did not change', async () => {
	const { screen, dial, value, onkind } = await setup();
	await click(dial);
	const curve = { ...initial, bands: replaceBand(initial.bands, 1, cut) };
	await screen.rerender({ curve });
	expect(value()).toBe('PK');
	expect(dial.hasAttribute('aria-invalid')).toBe(false);
	await vi.advanceTimersByTimeAsync(5000);
	expect(value()).toBe('PK');
	expect(onkind).not.toHaveBeenCalled();
});

test('focus may move inside the bank; leaving it from another control cancels pending', async () => {
	const { module, dial, value, onkind } = await setup();
	await click(dial);
	const field = module.querySelector('input');
	if (!field) throw new Error('Missing frequency input');
	dial.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: field }));
	await tick();
	expect(value()).toBe('LS ✕');
	field.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
	await tick();
	expect(value()).toBe('PK');
	expect(onkind).not.toHaveBeenCalled();
});

test.each(['layer', 'profile', 'Escape'] as const)('%s cancels bank pending', async (change) => {
	const { screen, dial, value, onkind } = await setup('engenharia');
	await click(dial);
	if (change === 'layer') await screen.rerender({ layer: 'ajustar' });
	if (change === 'profile') await screen.rerender({ kindContext: 'yolo' });
	if (change === 'Escape') {
		dial.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await tick();
	}
	expect(value()).toBe('PK');
	expect(onkind).not.toHaveBeenCalled();
});

test('Escape in the rename field cancels rename without cancelling a pending dial', async () => {
	const { module, dial, value, onkind } = await setup();
	await click(dial);
	const before = module.querySelector('.mod-name')?.textContent;
	const rename = module.querySelector<HTMLButtonElement>('[data-rename="0"]');
	if (!rename) throw new Error('Missing rename button');
	await click(rename);
	const field = module.querySelector<HTMLInputElement>('input.mod-input');
	if (!field) throw new Error('Missing rename field');
	field.value = 'Discard this';
	field.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
	);
	await tick();
	expect(module.querySelector('input.mod-input')).toBeNull();
	expect(module.querySelector('.mod-name')?.textContent).toBe(before);
	expect(value()).toBe('LS ✕');
	expect(onkind).not.toHaveBeenCalled();
});

test('Enter in the rename field keeps a pending dial; leaving the bank still cancels it', async () => {
	const { module, dial, value, onkind } = await setup();
	await click(dial);
	const rename = module.querySelector<HTMLButtonElement>('[data-rename="0"]');
	if (!rename) throw new Error('Missing rename button');
	await click(rename);
	const field = module.querySelector<HTMLInputElement>('input.mod-input');
	if (!field) throw new Error('Missing rename field');
	expect(document.activeElement).toBe(field);
	field.value = 'Grave';
	field.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
	);
	await tick();
	await tick();
	expect(module.querySelector('input.mod-input')).toBeNull();
	expect(module.querySelector('.mod-name')?.textContent).toBe('Grave');
	const button = module.querySelector<HTMLButtonElement>('[data-rename="0"]');
	if (!button) throw new Error('Missing restored rename button');
	expect(document.activeElement).toBe(button);
	expect(value()).toBe('LS ✕');
	button.blur();
	await tick();
	expect(value()).toBe('PK');
	expect(onkind).not.toHaveBeenCalled();
});

test('an external curve change also invalidates an in-flight bank preflight', async () => {
	const { screen, dial, value, onkind } = await setup();
	let answer: ((check: KindCheck) => void) | undefined;
	await screen.rerender({
		canApplyKind: () =>
			new Promise<KindCheck>((resolve) => {
				answer = resolve;
			})
	});
	await click(dial);
	await screen.rerender({ curve: { ...initial, preampDb: -4 } });
	answer?.({ ok: true });
	await tick();
	expect(value()).toBe('PK');
	expect(onkind).not.toHaveBeenCalled();
});

test('an applied experimental kind can leave through unlocked stops in Ajustar', async () => {
	const { screen, dial, onkind, canApplyKind } = await setup('ajustar', []);
	const hs = bandOfKind(cut, 'HS');
	await screen.rerender({ curve: { ...initial, bands: replaceBand(initial.bands, 0, hs) } });
	await click(dial);
	expect(canApplyKind).toHaveBeenCalledExactlyOnceWith(0, 'PK');
	expect(onkind).toHaveBeenCalledExactlyOnceWith(0, 'PK');
});

test('an unavailable editor is disabled, not a gate-invalid pending kind', async () => {
	const { screen, dial, value, onkind, canApplyKind } = await setup();
	await screen.rerender({ kindDisabledReason: m.curva_v2_loading_reason() });
	await click(dial);
	expect(dial.getAttribute('aria-disabled')).toBe('true');
	expect(value()).toBe('PK');
	expect(dial.hasAttribute('aria-invalid')).toBe(false);
	expect(canApplyKind).not.toHaveBeenCalled();
	expect(onkind).not.toHaveBeenCalled();
});

test('without an injected fake the bank asks the actual discrete-edit gate', async () => {
	const { screen, module, dial, value, onkind } = await setup();
	const curve: Curve = {
		bands: pad([cut, { ...cut, gainDb: 6 }]),
		preampDb: -0.5
	};
	expect(verdictFor(curve).ok).toBe(true);
	const refused = changeKind(curve, 0, 'LS');
	expect(refused.ok).toBe(false);
	if (refused.ok) throw new Error('Expected the full-curve gate to refuse LS');
	await screen.rerender({ curve, verdict: verdictFor(curve), canApplyKind: undefined });
	await click(dial);
	expect(value()).toBe('LS ✕');
	expect(module.querySelector('[role="status"]')?.textContent).toContain(
		firstReasonText(refused.reasons, { bands: curve.bands, locale: 'pt-BR' })
	);
	expect(dial.getAttribute('aria-valuetext')).toBe(`${m.curva_kinddial_ls_name()} (LS)`);
	expect(onkind).not.toHaveBeenCalled();
});

test('the editor-supplied YOLO preflight is used instead of a second standard-profile check', async () => {
	const { screen, dial, value, onkind } = await setup('engenharia');
	let yolo = false;
	const profiles: string[] = [];
	const canApplyKind = vi.fn(() => {
		profiles.push(yolo ? 'yolo' : 'standard');
		return { ok: yolo, reason: refusal };
	});
	await screen.rerender({ canApplyKind, kindContext: 'standard' });
	await click(dial);
	expect(value()).toBe('LS ✕');
	expect(onkind).not.toHaveBeenCalled();
	yolo = true;
	await screen.rerender({ kindContext: 'yolo' });
	expect(value()).toBe('PK');
	await click(dial);
	expect(onkind).toHaveBeenCalledExactlyOnceWith(0, 'LS');
	expect(profiles).toEqual(['standard', 'yolo']);
});
