// QA1 m3: the bank's inline rename checks the name with the strict S5 label rules (core
// `normalizeLabels`) on commit. A refused name keeps the field open with a plain-language reason
// (env:url, env:url-like, env:length, env:pattern) and is never stored, cut or silently replaced by
// the automatic name. One limit everywhere: LABEL_MAX, 24 code points, counted in code (no
// `maxlength`, which counts UTF-16 units).
import '../../primitives/design-system.ts';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { NEUTRO } from 'open-auri/catalog';
import { LABEL_MAX } from 'open-auri/share';
import FilterBank from '#lib/components/pages/curva/FilterBank.svelte';
import { verdictFor, type Band, type Curve } from '#lib/components/pages/curva/model.ts';
import { m } from '#lib/paraglide/messages.js';

const cut: Band = { kind: 'PK', freqHz: 1000, gainDb: -6, qFactor: 1 };
const initial: Curve = { bands: [cut, ...NEUTRO.bands.slice(1)], preampDb: -3 };

afterEach(async () => {
	await cleanup();
});

async function setup() {
	const screen = await render(FilterBank, {
		curve: initial,
		verdict: verdictFor(initial),
		layer: 'ajustar',
		locale: 'pt-BR',
		stages: [],
		onkind: vi.fn(),
		onmove: vi.fn(),
		ondrag: vi.fn(),
		onorder: vi.fn()
	});
	const found = screen.container.querySelector<HTMLElement>('li.module');
	if (!found) throw new Error('Missing first bank module');
	const module: HTMLElement = found;
	const shown = () => module.querySelector('.mod-name')?.textContent ?? null;
	const field = () => module.querySelector<HTMLInputElement>('input.mod-input');
	const issue = () => module.querySelector('.mod-issue')?.textContent?.trim() ?? '';
	async function open(): Promise<HTMLInputElement> {
		const button = module.querySelector<HTMLButtonElement>('[data-rename="0"]');
		if (!button) throw new Error('Missing rename button');
		button.click();
		await tick();
		const input = field();
		if (!input) throw new Error('Missing rename field');
		return input;
	}
	async function type(input: HTMLInputElement, value: string): Promise<void> {
		input.value = value;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await tick();
	}
	async function press(input: HTMLInputElement, key: 'Enter' | 'Escape'): Promise<void> {
		input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
		await tick();
	}
	return { module, shown, field, issue, open, type, press };
}

test('the field has no maxlength: the 24 code-point limit is the core LABEL_MAX', async () => {
	const { open } = await setup();
	const input = await open();
	expect(LABEL_MAX).toBe(24);
	expect(input.hasAttribute('maxlength')).toBe(false);
	expect(input.title).toBe(m.curva_bn_rename_hint_max({ max: LABEL_MAX }));
});

test('a name of 24 code points (emoji included) is stored whole, not cut', async () => {
	const { open, type, press, shown, field } = await setup();
	const before = shown();
	// 24 code points, 28 UTF-16 units: a maxlength of 24 would have refused the last emoji.
	const name = `${'🎧'.repeat(4)}${'x'.repeat(20)}`;
	expect(name.length).toBe(28);
	const input = await open();
	await type(input, name);
	expect(input.getAttribute('aria-invalid')).toBeNull();
	await press(input, 'Enter');
	expect(field()).toBeNull();
	expect(shown()).toBe(name);
	expect(shown()).not.toBe(before);
	// 17 to 24 characters were cut at 16 before: a whole longer label stays whole.
	const again = await open();
	expect(again.value).toBe(name);
	await type(again, 'Corpo do violão quente');
	await press(again, 'Enter');
	expect(shown()).toBe('Corpo do violão quente');
});

test('a link-like name stays in the open field with the reason and is never stored', async () => {
	const { open, type, press, shown, field, issue } = await setup();
	const automatic = shown();
	const input = await open();
	await type(input, 'Sr.João');
	// Only the length is checked while typing.
	expect(issue()).toBe('');
	await press(input, 'Enter');
	expect(field()).toBe(input);
	expect(input.getAttribute('aria-invalid')).toBe('true');
	expect(issue()).toBe(m.curva_bn_rename_url_like());
	expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(
		input.closest('li')?.querySelector('.mod-issue')?.id
	);
	// Leaving the field does not drop the typed name either: it stays open with its reason.
	input.dispatchEvent(new FocusEvent('blur'));
	await tick();
	expect(field()).toBe(input);
	expect(issue()).toBe(m.curva_bn_rename_url_like());
	await type(input, 'evil.com');
	await press(input, 'Enter');
	expect(issue()).toBe(m.curva_bn_rename_url());
	// The fix is accepted: a space after the period.
	await type(input, 'Sr. João');
	expect(issue()).toBe('');
	expect(input.getAttribute('aria-invalid')).toBeNull();
	await press(input, 'Enter');
	expect(field()).toBeNull();
	expect(shown()).toBe('Sr. João');
	expect(shown()).not.toBe(automatic);
});

test('more than 24 code points is reported while typing and on Enter, never cut', async () => {
	const { open, type, press, shown, field, issue } = await setup();
	const automatic = shown();
	const input = await open();
	await type(input, 'x'.repeat(25));
	expect(issue()).toBe(m.curva_bn_rename_length({ max: LABEL_MAX }));
	expect(input.getAttribute('aria-invalid')).toBe('true');
	await press(input, 'Enter');
	expect(field()).toBe(input);
	expect(input.value).toBe('x'.repeat(25));
	// NFKC expansion counts too (ﬃ is three code points once normalized).
	await type(input, 'ﬃ'.repeat(9));
	expect(issue()).toBe(m.curva_bn_rename_length({ max: LABEL_MAX }));
	await type(input, 'x'.repeat(24));
	expect(issue()).toBe('');
	await press(input, 'Escape');
	expect(field()).toBeNull();
	expect(shown()).toBe(automatic);
});

test('controls and ill-formed text are env:pattern; Escape cancels and clears the reason', async () => {
	const { open, type, press, shown, field, issue } = await setup();
	const automatic = shown();
	const input = await open();
	for (const text of ['a\tb', 'a\ud83db']) {
		await type(input, text);
		await press(input, 'Enter');
		expect(field()).toBe(input);
		expect(issue()).toBe(m.curva_bn_rename_pattern());
	}
	await press(input, 'Escape');
	expect(field()).toBeNull();
	expect(shown()).toBe(automatic);
	const reopened = await open();
	expect(issue()).toBe('');
	expect(reopened.getAttribute('aria-invalid')).toBeNull();
	// Empty goes back to the automatic name.
	await type(reopened, '   ');
	await press(reopened, 'Enter');
	expect(field()).toBeNull();
	expect(shown()).toBe(automatic);
});
