// T4.13 + FUX.P4: "NO AR / Publicar". The lamp lights only after the server approved the
// publication; a GATE_REJECTED answer keeps it dark and lists the reasons with the checklist's gate
// messages. The technical sheet stays collapsed; unavailable publishing says why; the visibility
// default is unchanged.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import OnAir from '#lib/components/pages/comunidade/OnAir.svelte';
import { m } from '#lib/paraglide/messages.js';
import {
	ANONYMOUS,
	NEUTRAL,
	VERIFIED,
	apiError,
	apiWith,
	fakeFetch,
	json,
	type Route
} from './fixtures.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const EDITOR = { preampDb: NEUTRAL.preampDb, bands: NEUTRAL.bands };

function setup(route: Route, session = VERIFIED) {
	const fetch = fakeFetch(route);
	const onpublished = vi.fn();
	return {
		fetch,
		onpublished,
		props: {
			api: apiWith(fetch),
			session,
			editor: EDITOR,
			editorName: 'Minha curva',
			online: true,
			onpublished
		}
	};
}

const lamp = () => page.getByTestId('onair-lamp');

/** The text of everything an element's aria-describedby points to (the Button's reason). */
function reasonOf(element: Element): string {
	const ids = element.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
	return ids
		.map((value) => document.getElementById(value)?.textContent?.trim() ?? '')
		.join(' ')
		.trim();
}

test('the lamp lights only after the server approved the publication', async () => {
	const { props, fetch, onpublished } = setup((url, init) => {
		if (url.pathname === '/api/v1/curves' && init.method === 'POST') {
			return json({ lineageId: 'lin-new', versionId: 'ver-new', curveId: 'cnew' }, 201);
		}
		return undefined;
	});
	await render(OnAir, props);
	await expect.element(lamp()).toHaveAttribute('data-lit', 'false');
	await expect.element(page.getByTestId('onair-s1')).toBeVisible();
	await page.getByRole('button', { name: m.comunidade_onair_publish() }).click();
	await expect.element(lamp()).toHaveAttribute('data-lit', 'true');
	await expect.element(page.getByText(m.comunidade_onair_lit())).toBeVisible();
	const [, init] = fetch.mock.calls[0] ?? [];
	const body: unknown = JSON.parse(String(init?.body));
	expect(body).toMatchObject({
		visibility: 'public',
		envelope: { format: 'open-auri/preset@1', name: 'Minha curva', license: 'CC-BY-4.0' }
	});
	expect(onpublished).toHaveBeenCalledTimes(1);
});

test('GATE_REJECTED keeps the lamp dark and shows the localized gate reasons', async () => {
	const { props, onpublished } = setup((url) => {
		if (url.pathname === '/api/v1/curves') {
			return apiError('GATE_REJECTED', 422, { reasons: ['c:section-peak', 'zz:unknown'] });
		}
		return undefined;
	});
	await render(OnAir, props);
	await page.getByRole('button', { name: m.comunidade_onair_publish() }).click();
	// The alert holds the message plus the reason list: match fragments, not the whole text.
	await expect.element(page.getByRole('alert')).toMatchTextContent(m.comunidade_gate_rejected());
	const reasons = page.getByTestId('gate-reasons');
	await expect.element(reasons).toMatchTextContent(m.cable_reason_c_section_peak());
	await expect.element(reasons).toMatchTextContent(m.cable_reason_unknown());
	expect(page.getByTestId('gate-reasons').getByRole('listitem').elements()).toHaveLength(2);
	await expect.element(lamp()).toHaveAttribute('data-lit', 'false');
	await expect.element(page.getByText(m.comunidade_onair_off())).toBeVisible();
	expect(onpublished).not.toHaveBeenCalled();
});

test('other failures never light the lamp either', async () => {
	const { props } = setup(() => apiError('QUOTA_EXCEEDED', 429));
	await render(OnAir, props);
	await page.getByRole('button', { name: m.comunidade_onair_publish() }).click();
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.comunidade_error_rate());
	await expect.element(lamp()).toHaveAttribute('data-lit', 'false');
});

test('without an account publishing is unavailable and says why (no prompt of its own)', async () => {
	const { props, fetch } = setup(() => undefined, ANONYMOUS);
	await render(OnAir, props);
	// The page's single account card explains accounts (T9); this panel repeats no notice.
	expect(document.querySelector('[data-testid="login-prompt"]')).toBeNull();
	const publish = page.getByRole('button', { name: m.comunidade_onair_publish(), exact: true });
	await expect.element(publish).toHaveAttribute('aria-disabled', 'true');
	expect(reasonOf(publish.element())).toBe(m.comunidade_v2_reason_account());
	// Still focusable (aria-disabled, not disabled) and inert on click (a direct DOM click: the
	// test runner's click waits for an enabled element, which this one is not on purpose).
	const button = publish.element();
	expect(button.hasAttribute('disabled')).toBe(false);
	if (button instanceof HTMLElement) button.click();
	await expect.poll(() => reasonOf(button)).toBe(m.comunidade_v2_reason_account());
	expect(fetch).not.toHaveBeenCalled();
	await expect.element(lamp()).toHaveAttribute('data-lit', 'false');
});

test('the technical sheet is collapsed behind "Ver detalhes técnicos" and opens on demand', async () => {
	const { props } = setup(() => undefined);
	await render(OnAir, props);
	const sheet = page.getByTestId('ficha-tecnica');
	await expect.element(sheet).not.toHaveAttribute('open');
	await expect
		.element(sheet.getByText(m.comunidade_v2_tech_details(), { exact: true }))
		.toBeVisible();
	await expect.element(page.getByTestId('onair-s5')).not.toBeVisible();
	await sheet.getByText(m.comunidade_v2_tech_details(), { exact: true }).click();
	await expect.element(sheet).toHaveAttribute('open');
	await expect.element(page.getByTestId('onair-s5')).toMatchTextContent('open-auri/preset@1');
	// The code of the curve stays in view.
	await expect.element(page.getByTestId('onair-s1')).toBeVisible();
});

test('the visibility default is unchanged ("Pública")', async () => {
	const { props } = setup(() => undefined);
	await render(OnAir, props);
	await expect
		.element(page.getByRole('radio', { name: m.comunidade_visibility_public() }))
		.toBeChecked();
});

test('the gate and the technical terms carry their explainers', async () => {
	const { props } = setup(() => undefined);
	await render(OnAir, props);
	await expect.element(page.getByTestId('onair-s1')).toBeVisible();
	const explainers = document.querySelectorAll('#publicar button[aria-haspopup="dialog"]');
	expect(explainers.length).toBeGreaterThanOrEqual(3);
	expect(document.querySelector('#publicar')?.getAttribute('data-tour')).toBe('comunidade-publish');
});
