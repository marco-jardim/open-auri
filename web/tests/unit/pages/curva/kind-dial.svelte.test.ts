import '../../primitives/design-system.ts';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import KindDial, { type KindCheck } from '#lib/components/pages/curva/KindDial.svelte';
import type { BandKind } from '#lib/components/pages/curva/model.ts';
import type { Layer } from '#lib/components/pages/curva/layers.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { blockRealPointerHover } from './real-pointer.ts';

const refusal = 'The full-curve gate refused this candidate.';
/** Hover is driven by dispatched events only: the runner's real mouse must not pause a dial. */
let restorePointer: () => void = () => undefined;

beforeEach(() => {
	restorePointer = blockRealPointerHover();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
	await cleanup();
	restorePointer();
	vi.useRealTimers();
	await setLocale('pt-BR', { reload: false });
});

async function setup(kind: BandKind = 'PK', layer: Layer = 'engenharia', invalid: BandKind[] = []) {
	const canApply = vi.fn<(kind: BandKind) => KindCheck>((candidate) => ({
		ok: !invalid.includes(candidate),
		reason: refusal
	}));
	const onkind = vi.fn<(kind: BandKind) => void>();
	const screen = await render(KindDial, { kind, layer, canApply, onkind });
	const dial = screen.container.querySelector<HTMLElement>('[role="spinbutton"]');
	if (!dial) throw new Error('Missing kind dial');
	const value = () => screen.container.querySelector('.value')?.textContent;
	return { screen, dial, value, canApply, onkind };
}

async function click(dial: HTMLElement, shiftKey = false) {
	dial.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
	await tick();
}

async function key(dial: HTMLElement, name: string) {
	dial.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
	await tick();
}

test.each([
	['ajustar', ['LS', 'OFF', 'PK']],
	['engenharia', ['LS', 'OFF', 'HS', 'LP', 'HP', 'PK']]
] satisfies [Layer, BandKind[]][])(
	'%s follows its clockwise cycle and skips locked kinds',
	async (layer, cycle) => {
		const { screen, dial, value, onkind, canApply } = await setup('PK', layer);
		for (const kind of cycle) {
			await click(dial);
			expect(onkind).toHaveBeenLastCalledWith(kind);
			await screen.rerender({ kind });
			expect(value()).toBe(kind);
		}
		expect(canApply.mock.calls.map(([kind]) => kind)).toEqual(cycle);
	}
);

test.each(['pt-BR', 'en-US'] as const)('red, marked and announced refusal in %s', async (locale) => {
	await setLocale(locale, { reload: false });
	const { screen, dial, value, onkind } = await setup('PK', 'ajustar', ['LS']);
	await click(dial);
	expect(value()).toBe('LS ✕');
	expect(dial.getAttribute('aria-invalid')).toBe('true');
	expect(dial.getAttribute('aria-valuenow')).toBe('1');
	expect(dial.getAttribute('aria-valuetext')).toBe(`${m.curva_kinddial_ls_name()} (LS)`);
	const live = screen.container.querySelector('[role="status"]');
	expect(live?.getAttribute('aria-live')).toBe('polite');
	expect(live?.textContent).toBe(m.curva_kinddial_pending({ kind: 'LS', reason: refusal }));
	const valueElement = screen.container.querySelector('.value.invalid');
	if (!valueElement) throw new Error('Missing invalid acronym');
	const probe = document.createElement('span');
	probe.style.color = 'var(--danger)';
	screen.container.append(probe);
	expect(getComputedStyle(valueElement).fill).toBe(getComputedStyle(probe).color);
	expect(screen.container.querySelector('.cap')?.getAttribute('style')).toContain('0deg');
	dial.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
	await tick();
	const tooltip = screen.container.querySelector('[role="tooltip"]');
	expect(tooltip?.matches(':popover-open')).toBe(true);
	expect(tooltip?.textContent).toContain(refusal);
	expect(tooltip?.textContent).toContain(m.curva_bn_kind_foot());
	expect(onkind).not.toHaveBeenCalled();
});

test('a click within five seconds advances from pending and applies a valid kind immediately', async () => {
	const { screen, dial, value, onkind, canApply } = await setup('PK', 'ajustar', ['LS']);
	await click(dial);
	await vi.advanceTimersByTimeAsync(4999);
	expect(value()).toBe('LS ✕');
	await click(dial);
	expect(canApply.mock.calls.map(([kind]) => kind)).toEqual(['LS', 'OFF']);
	expect(onkind).toHaveBeenCalledExactlyOnceWith('OFF');
	await screen.rerender({ kind: 'OFF' });
	expect(value()).toBe('OFF');
	expect(dial.hasAttribute('aria-invalid')).toBe(false);
	await vi.advanceTimersByTimeAsync(5000);
	expect(value()).toBe('OFF');
});

test.each(['pt-BR', 'en-US'] as const)(
	'five idle seconds restore and announce the applied kind in %s',
	async (locale) => {
		await setLocale(locale, { reload: false });
		const { screen, dial, value, onkind } = await setup('PK', 'ajustar', ['LS']);
		await click(dial);
		await vi.advanceTimersByTimeAsync(4999);
		expect(value()).toBe('LS ✕');
		await vi.advanceTimersByTimeAsync(1);
		await tick();
		expect(value()).toBe('PK');
		expect(screen.container.querySelector('.cap')?.getAttribute('style')).toContain('-60deg');
		expect(screen.container.querySelector('[role="status"]')?.textContent).toBe(
			locale === 'pt-BR' ? 'Voltou para PK' : 'Back to PK'
		);
		expect(onkind).not.toHaveBeenCalled();
	}
);

/** Fake time only, then a flush, so every timer callback has rendered before the next check. */
async function advance(ms: number) {
	await vi.advanceTimersByTimeAsync(ms);
	await tick();
}

test('keyboard focus pauses pending until five seconds after blur', async () => {
	const { screen, dial, value, onkind } = await setup('PK', 'ajustar', ['LS']);
	const legend = screen.container.querySelector('[role="tooltip"]');
	if (!legend) throw new Error('Missing dial legend');
	dial.focus();
	await tick();
	expect(document.activeElement).toBe(dial);
	// The focusin reached the dial: keyboard focus opens its legend at once.
	expect(legend.matches(':popover-open')).toBe(true);
	await key(dial, 'ArrowRight');
	await advance(30000);
	expect(value()).toBe('LS ✕');
	dial.blur();
	await tick();
	expect(document.activeElement).not.toBe(dial);
	// The focusout reached the dial too: its legend closed.
	expect(legend.matches(':popover-open')).toBe(false);
	await advance(4999);
	expect(value()).toBe('LS ✕');
	await advance(1);
	expect(value()).toBe('PK');
	expect(onkind).not.toHaveBeenCalled();
});

test.each(['before', 'after'] as const)(
	'hover %s refusal pauses pending; leaving starts five new idle seconds',
	async (when) => {
		const { dial, value, onkind } = await setup('PK', 'ajustar', ['LS']);
		const pointer = async (type: 'pointerenter' | 'pointerleave') => {
			dial.dispatchEvent(new PointerEvent(type, { pointerType: 'mouse' }));
			await tick();
		};
		// Hover alone pauses here: the dial never has keyboard focus.
		expect(document.activeElement).not.toBe(dial);
		if (when === 'before') await pointer('pointerenter');
		await click(dial);
		await advance(4000);
		if (when === 'after') await pointer('pointerenter');
		await advance(30000);
		expect(value()).toBe('LS ✕');
		await pointer('pointerleave');
		expect(document.activeElement).not.toBe(dial);
		await advance(4999);
		expect(value()).toBe('LS ✕');
		await advance(1);
		expect(value()).toBe('PK');
		expect(onkind).not.toHaveBeenCalled();
	}
);

test('leaving hover does not resume while focused, and the legend also pauses pending', async () => {
	const { screen, dial, value } = await setup('PK', 'ajustar', ['LS']);
	dial.focus();
	dial.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
	await click(dial);
	dial.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
	await vi.advanceTimersByTimeAsync(10000);
	expect(value()).toBe('LS ✕');
	const legend = screen.container.querySelector<HTMLElement>('[role="tooltip"]');
	if (!legend) throw new Error('Missing dial legend');
	legend.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
	dial.blur();
	await vi.advanceTimersByTimeAsync(10000);
	expect(value()).toBe('LS ✕');
	legend.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
	await vi.advanceTimersByTimeAsync(5000);
	await tick();
	expect(value()).toBe('PK');
});

test('two invalid candidates restart the timer and revert to the last applied kind', async () => {
	const { screen, dial, value, onkind } = await setup('LS', 'engenharia', ['HS', 'LP']);
	await click(dial);
	expect(onkind).toHaveBeenCalledExactlyOnceWith('OFF');
	await screen.rerender({ kind: 'OFF' });
	await click(dial);
	expect(value()).toBe('HS ✕');
	await vi.advanceTimersByTimeAsync(4000);
	await click(dial);
	expect(value()).toBe('LP ✕');
	await vi.advanceTimersByTimeAsync(1000);
	expect(value()).toBe('LP ✕');
	await vi.advanceTimersByTimeAsync(3999);
	expect(value()).toBe('LP ✕');
	await vi.advanceTimersByTimeAsync(1);
	await tick();
	expect(value()).toBe('OFF');
	expect(onkind).toHaveBeenCalledOnce();
});

test.each(['Shift+click', 'ArrowLeft', 'ArrowDown'])(
	'%s reverses from a pending candidate',
	async (action) => {
		const { screen, dial, value, onkind } = await setup('PK', 'engenharia', ['HP']);
		if (action === 'Shift+click') await click(dial, true);
		else await key(dial, action);
		expect(value()).toBe('HP ✕');
		expect(onkind).not.toHaveBeenCalled();
		if (action === 'Shift+click') await click(dial, true);
		else await key(dial, action);
		expect(onkind).toHaveBeenCalledExactlyOnceWith('LP');
		await screen.rerender({ kind: 'LP' });
		expect(value()).toBe('LP');
	}
);

test('backwards in Ajustar skips experimental kinds, and Home applies OFF from pending', async () => {
	const { screen, dial, value, onkind, canApply } = await setup('PK', 'ajustar', ['LS']);
	await key(dial, 'ArrowDown');
	expect(onkind).toHaveBeenCalledExactlyOnceWith('OFF');
	await screen.rerender({ kind: 'OFF' });
	await key(dial, 'ArrowLeft');
	expect(value()).toBe('LS ✕');
	await key(dial, 'Home');
	expect(value()).toBe('OFF');
	expect(canApply.mock.calls.map(([kind]) => kind)).toEqual(['OFF', 'LS']);
	expect(onkind).toHaveBeenCalledOnce();
});

test('Home applies OFF immediately when a different applied kind is pending', async () => {
	const { screen, dial, value, onkind } = await setup('PK', 'ajustar', ['LS']);
	await click(dial);
	await key(dial, 'Home');
	expect(onkind).toHaveBeenCalledExactlyOnceWith('OFF');
	await screen.rerender({ kind: 'OFF' });
	expect(value()).toBe('OFF');
});

test('Escape cancels pending even when the tooltip is closed', async () => {
	const { dial, value, onkind } = await setup('PK', 'ajustar', ['LS']);
	await click(dial);
	await key(dial, 'Escape');
	expect(value()).toBe('PK');
	expect(dial.hasAttribute('aria-invalid')).toBe(false);
	await vi.advanceTimersByTimeAsync(5000);
	expect(value()).toBe('PK');
	expect(onkind).not.toHaveBeenCalled();
});

test('Escape inside the legend cancels only its own dial', async () => {
	const first = await setup('PK', 'ajustar', ['LS']);
	const second = await setup('PK', 'ajustar', ['LS']);
	await click(first.dial);
	await click(second.dial);
	const legend = first.screen.container.querySelector<HTMLElement>('.kd-legend b');
	if (!legend) throw new Error('Missing legend content');
	await key(legend, 'Escape');
	expect(first.value()).toBe('PK');
	expect(second.value()).toBe('LS ✕');
	expect(first.onkind).not.toHaveBeenCalled();
	expect(second.onkind).not.toHaveBeenCalled();
});

test.each(['layer', 'curve', 'kind', 'disabled'] as const)(
	'%s change cancels pending',
	async (change) => {
		const { screen, dial, value, onkind } = await setup('PK', 'engenharia', ['LS']);
		await click(dial);
		if (change === 'layer') await screen.rerender({ layer: 'ajustar' });
		if (change === 'curve') await screen.rerender({ resetKey: {} });
		if (change === 'kind') await screen.rerender({ kind: 'OFF' });
		if (change === 'disabled') await screen.rerender({ disabledReason: 'Writing' });
		expect(value()).toBe(change === 'kind' ? 'OFF' : 'PK');
		expect(dial.hasAttribute('aria-invalid')).toBe(false);
		expect(onkind).not.toHaveBeenCalled();
	}
);

test('Ouvir is read-only for clicks and keys', async () => {
	const { dial, onkind, canApply } = await setup('PK', 'ouvir');
	await click(dial);
	await key(dial, 'ArrowLeft');
	await key(dial, 'Home');
	expect(dial.getAttribute('aria-disabled')).toBe('true');
	expect(canApply).not.toHaveBeenCalled();
	expect(onkind).not.toHaveBeenCalled();
});

test('rapid clicks advance the requested cursor but never commit a stale gate answer', async () => {
	const { screen, dial, value, onkind } = await setup();
	const answers = new Map<BandKind, (check: KindCheck) => void>();
	const canApply = vi.fn(
		(kind: BandKind) => new Promise<KindCheck>((resolve) => answers.set(kind, resolve))
	);
	await screen.rerender({ canApply });
	await click(dial);
	await click(dial);
	expect(canApply.mock.calls.map(([kind]) => kind)).toEqual(['LS', 'OFF']);
	answers.get('OFF')?.({ ok: true });
	await tick();
	expect(onkind).toHaveBeenCalledExactlyOnceWith('OFF');
	await screen.rerender({ kind: 'OFF' });
	answers.get('LS')?.({ ok: true });
	await tick();
	expect(onkind).toHaveBeenCalledOnce();
	expect(value()).toBe('OFF');
});

test('Escape invalidates an in-flight preflight', async () => {
	const { screen, dial, value, onkind } = await setup();
	let answer: ((check: KindCheck) => void) | undefined;
	await screen.rerender({
		canApply: () =>
			new Promise<KindCheck>((resolve) => {
				answer = resolve;
			})
	});
	await click(dial);
	await key(dial, 'Escape');
	answer?.({ ok: true });
	await tick();
	expect(value()).toBe('PK');
	expect(onkind).not.toHaveBeenCalled();
});

test('destroy clears the pending timer', async () => {
	const { dial, onkind } = await setup('PK', 'ajustar', ['LS']);
	const before = vi.getTimerCount();
	await click(dial);
	expect(vi.getTimerCount()).toBe(before + 1);
	await cleanup();
	expect(vi.getTimerCount()).toBe(before);
	await vi.advanceTimersByTimeAsync(5000);
	expect(onkind).not.toHaveBeenCalled();
});
