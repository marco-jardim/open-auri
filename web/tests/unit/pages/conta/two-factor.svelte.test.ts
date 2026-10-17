// TwoFactorForm (/conta, FX3.4) in a real browser: the three states (off, pending, on), the form
// targets and field names the actions read, the QR + manual key + otpauth URI of a setup, the
// backup codes shown only with the start result, labels, live regions and focus.
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import TwoFactorForm from '#lib/components/account/TwoFactorForm.svelte';
import type { FormFeedback } from '#lib/components/account/types.ts';
import { m } from '#lib/paraglide/messages.js';

afterEach(async () => {
	vi.restoreAllMocks();
	await cleanup();
});

const SECRET = 'JBSWY3DPEHPK3PXP';
const URI =
	`otpauth://totp/open-auri:pessoa%40example.com?secret=${SECRET}` +
	'&issuer=open-auri&digits=6&period=30';
const CODES = ['aB3dE-fG4hI', 'jK5lM-nO6pQ', 'rS7tU-vW8xY'];

const started: FormFeedback = {
	form: 'twoFactor',
	ok: true,
	detail: 'started',
	enrolment: { totpURI: URI, backupCodes: CODES }
};

function formByAction(action: string): HTMLFormElement | null {
	return document.querySelector(`form[action="${action}"]`);
}

function statusText(): string {
	return document.querySelector('[data-testid="two-factor-status"]')?.textContent ?? '';
}

function alertText(): string {
	return document.querySelector('[role="alert"]')?.textContent?.trim() ?? '';
}

test('off: status, the start form (password) and nothing else', async () => {
	const enhance = vi.fn();
	await render(TwoFactorForm, { status: 'off', enhance });
	expect(statusText()).toContain(m.conta_2fa_status_off());
	const password = page.getByLabelText(m.conta_2fa_password());
	await expect.element(password).toHaveAttribute('name', 'password');
	await expect.element(password).toHaveAttribute('type', 'password');
	await expect.element(password).toHaveAttribute('autocomplete', 'current-password');
	await expect.element(password).toBeRequired();
	const form = password.element().closest('form');
	expect(form?.getAttribute('action')).toBe('?/twoFactorStart');
	expect(form?.method).toBe('post');
	await expect
		.element(page.getByRole('button', { name: m.conta_2fa_start_submit() }))
		.toBeVisible();
	expect(formByAction('?/twoFactorConfirm')).toBeNull();
	expect(formByAction('?/twoFactorDisable')).toBeNull();
	expect(document.querySelector('img')).toBeNull();
	expect(enhance).toHaveBeenCalledTimes(1);
	expect(enhance.mock.calls[0]?.[0]).toBe(form);
	expect(document.body.textContent).not.toContain(m.conta_2fa_admin_note());
});

test('pending with the start result: QR, manual key, URI, codes once, confirm and cancel', async () => {
	await render(TwoFactorForm, { status: 'pending', feedback: started });
	expect(statusText()).toContain(m.conta_2fa_status_pending());

	const qr = page.getByRole('img', { name: m.conta_2fa_qr_alt() });
	await expect.element(qr).toBeVisible();
	const src = qr.element().getAttribute('src') ?? '';
	expect(src.startsWith('data:image/svg+xml,')).toBe(true);
	expect(decodeURIComponent(src)).toContain('<svg');

	await expect.element(page.getByText(m.conta_2fa_manual_label())).toBeVisible();
	expect(document.querySelector('[data-testid="two-factor-key"]')?.textContent).toBe(
		'JBSW Y3DP EHPK 3PXP'
	);
	expect(document.querySelector('[data-testid="two-factor-uri"]')?.textContent).toBe(URI);

	const list = page.getByRole('list', { name: m.conta_2fa_codes_title() });
	await expect.element(list).toBeVisible();
	for (const code of CODES) await expect.element(list.getByText(code)).toBeVisible();
	await expect.element(page.getByText(m.conta_2fa_codes_help())).toBeVisible();
	const download = page.getByRole('link', { name: m.conta_2fa_codes_download() });
	await expect.element(download).toHaveAttribute('download', 'open-auri-recovery-codes.txt');
	const href = download.element().getAttribute('href') ?? '';
	expect(href.startsWith('data:text/plain')).toBe(true);
	expect(decodeURIComponent(href)).toContain(CODES.join('\n'));

	// The setup heading takes the focus so the steps are read next.
	await expect.element(page.getByRole('heading', { name: m.conta_2fa_scan_title() })).toHaveFocus();

	const code = page.getByLabelText(m.conta_2fa_code_label());
	await expect.element(code).toHaveAttribute('name', 'code');
	await expect.element(code).toHaveAttribute('inputmode', 'numeric');
	await expect.element(code).toHaveAttribute('autocomplete', 'one-time-code');
	await expect.element(code).toHaveAccessibleDescription(m.conta_2fa_code_hint());
	expect(code.element().closest('form')?.getAttribute('action')).toBe('?/twoFactorConfirm');

	// No second start form while the setup is on screen; the cancel form needs the password.
	expect(formByAction('?/twoFactorStart')).toBeNull();
	const cancel = page.getByLabelText(m.conta_2fa_disable_password());
	expect(cancel.element().closest('form')?.getAttribute('action')).toBe('?/twoFactorDisable');
	await expect
		.element(page.getByRole('button', { name: m.conta_2fa_cancel_submit() }))
		.toBeVisible();

	await expect.element(page.getByText(m.conta_2fa_started())).toBeVisible();
	expect(alertText()).toBe('');
});

test('codes are shown once: a pending setup loaded without the start result shows none', async () => {
	await render(TwoFactorForm, { status: 'pending' });
	expect(document.querySelector('img')).toBeNull();
	expect(document.querySelector('[data-testid="two-factor-key"]')).toBeNull();
	for (const code of CODES) expect(document.body.textContent).not.toContain(code);
	expect(document.body.textContent).not.toContain(SECRET);
	// Confirm (app already has the key), start over (new key and codes) or cancel.
	expect(formByAction('?/twoFactorConfirm')).not.toBeNull();
	await expect.element(page.getByText(m.conta_2fa_pending_hint())).toBeVisible();
	await expect
		.element(page.getByRole('button', { name: m.conta_2fa_restart_submit() }))
		.toBeVisible();
	expect(formByAction('?/twoFactorStart')).not.toBeNull();
	expect(formByAction('?/twoFactorDisable')).not.toBeNull();
});

test('a mistyped code keeps the setup on screen; confirming removes it', async () => {
	const screen = await render(TwoFactorForm, { status: 'pending', feedback: started });
	await expect.element(page.getByText(CODES[0] ?? '')).toBeVisible();

	await screen.rerender({
		status: 'pending',
		feedback: { form: 'twoFactor', error: 'invalid-code' }
	});
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.conta_2fa_error_code());
	await expect.element(page.getByText(CODES[0] ?? '')).toBeVisible();

	await screen.rerender({
		status: 'on',
		feedback: { form: 'twoFactor', ok: true, detail: 'enabled' }
	});
	await expect.element(page.getByText(m.conta_2fa_enabled())).toBeVisible();
	for (const code of CODES) expect(document.body.textContent).not.toContain(code);
	expect(document.querySelector('img')).toBeNull();
	expect(statusText()).toContain(m.conta_2fa_status_on());
	// The status line takes the focus when the state changes.
	expect(document.activeElement?.getAttribute('data-testid')).toBe('two-factor-status');
});

test('on: only the disable form, with the password; admin note for admins', async () => {
	await render(TwoFactorForm, { status: 'on', admin: true });
	expect(statusText()).toContain(m.conta_2fa_status_on());
	await expect.element(page.getByText(m.conta_2fa_admin_note())).toBeVisible();
	await expect.element(page.getByText(m.conta_2fa_disable_help())).toBeVisible();
	const password = page.getByLabelText(m.conta_2fa_disable_password());
	await expect.element(password).toHaveAttribute('name', 'password');
	await expect.element(password).toBeRequired();
	expect(password.element().closest('form')?.getAttribute('action')).toBe('?/twoFactorDisable');
	// The second factor too: one field for an app code or a backup code, in the same form.
	const code = page.getByLabelText(m.conta_2fa_disable_code_label());
	await expect.element(code).toHaveAttribute('name', 'code');
	await expect.element(code).toHaveAttribute('type', 'text');
	await expect.element(code).toHaveAttribute('autocomplete', 'one-time-code');
	await expect.element(code).toBeRequired();
	await expect.element(code).toHaveAccessibleDescription(m.conta_2fa_disable_code_hint());
	expect(code.element().closest('form')).toBe(password.element().closest('form'));
	await expect
		.element(page.getByRole('button', { name: m.conta_2fa_disable_submit() }))
		.toBeVisible();
	expect(formByAction('?/twoFactorStart')).toBeNull();
	expect(formByAction('?/twoFactorConfirm')).toBeNull();
});

test('cancelling a pending setup asks for the password only', async () => {
	await render(TwoFactorForm, { status: 'pending' });
	const cancel = formByAction('?/twoFactorDisable');
	expect(cancel?.querySelector('input[name="password"]')).not.toBeNull();
	expect(cancel?.querySelector('input[name="code"]')).toBeNull();
});

test('a refused disable gets one message that names neither factor; success is announced', async () => {
	const screen = await render(TwoFactorForm, {
		status: 'on',
		feedback: { form: 'twoFactor', error: 'wrong-password-or-code' }
	});
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.conta_2fa_error_disable());
	expect(alertText()).not.toContain(m.conta_error_wrong_password());
	expect(alertText()).not.toContain(m.conta_2fa_error_code());
	// The notice the page builds from the redirect's ?2fa=desativada.
	await screen.rerender({
		status: 'off',
		feedback: { form: 'twoFactor', ok: true, detail: 'disabled' }
	});
	await expect.element(page.getByRole('status')).toHaveTextContent(m.conta_2fa_disabled());
	expect(alertText()).toBe('');
});

test('errors are announced: admin without the 2FA marker, wrong password, rate limit', async () => {
	const screen = await render(TwoFactorForm, {
		status: 'on',
		admin: true,
		feedback: { form: 'twoFactor', error: 'two-factor-required' }
	});
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.conta_2fa_error_marker());
	await screen.rerender({
		status: 'on',
		admin: true,
		feedback: { form: 'twoFactor', error: 'wrong-password' }
	});
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.conta_error_wrong_password());
	await screen.rerender({
		status: 'on',
		admin: true,
		feedback: { form: 'twoFactor', error: 'RATE_LIMITED', retryAfter: 42 }
	});
	await expect
		.element(page.getByRole('alert'))
		.toHaveTextContent(m.conta_error_rate_limited_wait({ seconds: '42' }));
	// Feedback of another form is not shown here.
	await screen.rerender({ status: 'on', feedback: { form: 'bio', error: 'too-long' } });
	expect(alertText()).toBe('');
});

test('the copy button copies the codes and says so', async () => {
	const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
	await render(TwoFactorForm, { status: 'pending', feedback: started });
	await userEvent.click(page.getByRole('button', { name: m.conta_2fa_codes_copy() }));
	expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
	await expect.element(page.getByText(m.conta_2fa_codes_copied())).toBeVisible();
});
