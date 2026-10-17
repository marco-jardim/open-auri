import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import { explainerHeadings } from '#lib/comprehension/explainer-titles.ts';
import { explainers } from '#lib/comprehension/explainers.ts';
import Explainer from '#lib/components/comprehension/Explainer.svelte';
import TermFixture from './TermFixture.svelte';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

test('term explainer: the visible word is the trigger, in its label type, with no "?" glyph', async () => {
	const screen = await render(TermFixture, { term: 'q', label: 'Q' });
	const trigger = page.getByRole('button', { name: 'Q O que é isso?', exact: true });
	await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
	const button = trigger.element();
	// The children are the only visible content: no glyph, no box.
	expect(button.textContent).toBe('Q');
	expect(button.textContent).not.toContain('?');
	expect(button.querySelector('[aria-hidden="true"]')).toBeNull();
	expect(button.classList.contains('trigger')).toBe(false);
	// It sits flush in the running text: no stray space before the comma.
	const paragraph = screen.container.querySelector('p');
	if (!paragraph) throw new Error('Missing label');
	expect(paragraph.innerText.toLowerCase()).toBe('antes q, depois');
	const label = getComputedStyle(paragraph);
	const style = getComputedStyle(button);
	for (const property of [
		'color',
		'fontFamily',
		'fontSize',
		'fontWeight',
		'letterSpacing',
		'lineHeight',
		'textTransform'
	] as const) {
		expect(style[property], property).toBe(label[property]);
	}
	expect(style.borderTopWidth).toBe('0px');
	expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
	expect(style.paddingLeft).toBe('0px');
	expect(style.cursor).toBe('help');
	// A dotted underline in the label's own colour.
	expect(style.textDecorationLine).toBe('underline');
	expect(style.textDecorationStyle).toBe('dotted');
	expect(style.textDecorationColor).toBe(label.color);
	expect(style.textUnderlineOffset).toBe('3px');
});

test('term explainer: keyboard focus shows a ring and hover or focus turn the underline accent', async () => {
	const screen = await render(TermFixture, { term: 'q', label: 'Q' });
	const trigger = page.getByRole('button', { name: 'Q O que é isso?', exact: true });
	const paragraph = screen.container.querySelector('p');
	if (!paragraph) throw new Error('Missing label');
	const colour = getComputedStyle(paragraph).color;
	await trigger.hover();
	expect(getComputedStyle(trigger.element()).textDecorationColor).not.toBe(colour);
	await page.getByRole('button', { name: 'Fora', exact: true }).hover();
	expect(getComputedStyle(trigger.element()).textDecorationColor).toBe(colour);
	// Give the test frame focus first (a first Tab from an unfocused frame lands outside it),
	// then reach the term by keyboard so it is :focus-visible.
	await page.getByRole('button', { name: 'Fora', exact: true }).click();
	await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
	await expect.element(trigger).toHaveFocus();
	expect(trigger.element().matches(':focus-visible')).toBe(true);
	const focused = getComputedStyle(trigger.element());
	expect(focused.outlineStyle).toBe('solid');
	expect(focused.outlineWidth).not.toBe('0px');
	expect(focused.textDecorationColor).not.toBe(colour);
});

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`term explainer opens from the keyboard and toggles aria-expanded in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		await render(TermFixture, { term: 'gate', label: 'gate' });
		const trigger = page.getByRole('button', {
			name: `gate ${m.fux1_what_is_this()}`,
			exact: true
		});
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
		await expect.element(trigger).toHaveAttribute('aria-haspopup', 'dialog');
		trigger.element().focus();
		await userEvent.keyboard('{Enter}');
		const dialog = page.getByRole('dialog', { name: explainers.gate.title() });
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog).toHaveFocus();
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
		expect(trigger.element().getAttribute('aria-controls')).toBe(dialog.element().id);
		await expect.element(dialog.getByRole('link')).toHaveAttribute('href', '/docs#g-gate');
		await userEvent.keyboard('{Escape}');
		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(trigger).toHaveFocus();
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
		// Space opens it again; a click outside closes it and returns focus.
		await userEvent.keyboard(' ');
		await expect.element(dialog).toBeVisible();
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
		document.body.click();
		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(trigger).toHaveFocus();
		await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
	});
}

test('term explainer without children shows the explainer title', async () => {
	await render(Explainer, { term: 'envelope', variant: 'term' });
	const title = explainerHeadings.envelope.title();
	const trigger = page.getByRole('button', { name: `${title} O que é isso?`, exact: true });
	await expect.element(trigger).toBeInTheDocument();
	expect(trigger.element().textContent).toBe(title);
});

test('the icon variant stays the default "?" button', async () => {
	await render(Explainer, { term: 'q' });
	const name = m.explain_trigger({ term: explainerHeadings.q.title() });
	const trigger = page.getByRole('button', { name, exact: true });
	await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
	expect(trigger.element().classList.contains('trigger')).toBe(true);
	expect(trigger.element().querySelector('span[aria-hidden="true"]')?.textContent).toBe('?');
});
