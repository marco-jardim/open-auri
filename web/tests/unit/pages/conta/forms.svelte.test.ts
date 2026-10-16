// Account area components in a real browser: form targets and field names the actions read,
// private-by-default visibility, "sign out other sessions" ticked by default, pending e-mail
// state, closure without a preselected mode, live feedback regions.
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import BioForm from '#lib/components/account/BioForm.svelte';
import CloseAccountForm from '#lib/components/account/CloseAccountForm.svelte';
import EmailForm from '#lib/components/account/EmailForm.svelte';
import ExportForm from '#lib/components/account/ExportForm.svelte';
import Feedback from '#lib/components/account/Feedback.svelte';
import NicknameForm from '#lib/components/account/NicknameForm.svelte';
import PasswordForm from '#lib/components/account/PasswordForm.svelte';
import Section from '#lib/components/account/Section.svelte';
import SessionList from '#lib/components/account/SessionList.svelte';
import VisibilityForm from '#lib/components/account/VisibilityForm.svelte';
import { deviceLabel, formatDate, formatDateTime } from '#lib/components/account/format.ts';
import type { SessionView } from '#lib/components/account/types.ts';
import { m } from '#lib/paraglide/messages.js';
import { createRawSnippet } from 'svelte';

afterEach(async () => {
	await cleanup();
});

const DAY = 24 * 60 * 60 * 1000;

/** Text of the (always mounted) alert live region; '' when it is empty. */
function alertText(): string {
	return document.querySelector('[role="alert"]')?.textContent?.trim() ?? '';
}

function formOf(element: Element | null): HTMLFormElement {
	const form = element?.closest('form');
	if (!form) throw new Error('no form');
	return form;
}

test('Section renders a labelled region with its fragment id', async () => {
	const children = createRawSnippet(() => ({ render: () => '<p>inside</p>' }));
	await render(Section, { id: 'perfil', title: 'Perfil', description: 'Desc', children });
	const region = page.getByRole('region', { name: 'Perfil' });
	await expect.element(region).toBeVisible();
	await expect.element(region).toHaveAttribute('id', 'perfil');
	await expect.element(page.getByText('inside')).toBeVisible();
});

test('Feedback announces success as status and errors as alert', async () => {
	const screen = await render(Feedback, { feedback: { form: 'bio', ok: true } });
	await expect.element(page.getByRole('status')).toHaveTextContent(m.conta_bio_saved());
	expect(alertText()).toBe('');
	await screen.rerender({ feedback: { form: 'bio', error: 'too-long' } });
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.conta_bio_error_too_long());
});

test('NicknameForm: first choice note, rules and the ?/nickname action', async () => {
	const enhance = vi.fn();
	await render(NicknameForm, {
		current: null,
		emailVerified: true,
		nextChangeAt: null,
		enhance
	});
	await expect.element(page.getByText(m.conta_nickname_first())).toBeVisible();
	await expect.element(page.getByText(m.conta_nickname_clock_first())).toBeVisible();
	const input = page.getByLabelText(m.conta_nickname_label());
	await expect.element(input).toHaveAttribute('name', 'nickname');
	await expect.element(input).toHaveAttribute('maxlength', '24');
	await expect.element(input).toHaveValue('');
	const form = formOf(input.element());
	expect(form.getAttribute('action')).toBe('?/nickname');
	expect(form.method).toBe('post');
	expect(enhance).toHaveBeenCalledTimes(1);
	expect(enhance.mock.calls[0]?.[0]).toBe(form);
	await expect
		.element(page.getByRole('button', { name: m.conta_nickname_submit_first() }))
		.toBeEnabled();
});

test('NicknameForm: waiting clock, holds and the too-soon error with the typed value', async () => {
	const next = Date.now() + 10 * DAY;
	const releasedAt = Date.now() + 80 * DAY;
	await render(NicknameForm, {
		current: 'Atual',
		emailVerified: true,
		nextChangeAt: next,
		holds: [{ username: 'antigo', releasedAt }],
		feedback: { form: 'nickname', error: 'too-soon', retryAt: next, value: 'novo' }
	});
	await expect
		.element(page.getByText(m.conta_nickname_clock_wait({ date: formatDate(next) })))
		.toBeVisible();
	await expect.element(page.getByText('antigo')).toBeVisible();
	await expect.element(page.getByLabelText(m.conta_nickname_label())).toHaveValue('novo');
	await expect
		.element(page.getByRole('alert'))
		.toHaveTextContent(m.conta_nickname_error_too_soon({ date: formatDate(next) }));
	// Case-only changes stay possible while waiting: the button is not disabled.
	await expect.element(page.getByRole('button', { name: m.conta_nickname_submit() })).toBeEnabled();
});

test('NicknameForm is disabled until the e-mail is verified', async () => {
	await render(NicknameForm, { current: null, emailVerified: false, nextChangeAt: null });
	await expect.element(page.getByLabelText(m.conta_nickname_label())).toBeDisabled();
	await expect.element(page.getByText(m.conta_nickname_needs_verification())).toBeVisible();
});

test('BioForm counts code points and blocks a bio over the limit', async () => {
	await render(BioForm, { bio: 'oi', emailVerified: true, max: 5 });
	const area = page.getByLabelText(m.conta_bio_label());
	await expect.element(area).toHaveAttribute('name', 'bio');
	await expect.element(page.getByText(m.conta_bio_count({ used: '2', max: '5' }))).toBeVisible();
	await area.fill('🎧🎧🎧🎧🎧');
	await expect.element(page.getByText(m.conta_bio_count({ used: '5', max: '5' }))).toBeVisible();
	const button = page.getByRole('button', { name: m.conta_bio_submit() });
	await expect.element(button).toBeEnabled();
	await area.fill('🎧🎧🎧🎧🎧🎧');
	await expect.element(button).toBeDisabled();
	await expect.element(area).toHaveAttribute('aria-invalid', 'true');
	expect(formOf(area.element()).getAttribute('action')).toBe('?/bio');
});

test('BioForm shows the bio as text, never as markup', async () => {
	await render(BioForm, { bio: '<b>bold</b>', emailVerified: true });
	await expect.element(page.getByLabelText(m.conta_bio_label())).toHaveValue('<b>bold</b>');
	expect(document.querySelector('b')).toBeNull();
});

test('VisibilityForm: both private by default, each with its explanation', async () => {
	await render(VisibilityForm, { library: 'private', activity: 'private', emailVerified: true });
	const library = page.getByRole('checkbox', { name: m.conta_visibility_library_label() });
	const activity = page.getByRole('checkbox', { name: m.conta_visibility_activity_label() });
	await expect.element(library).not.toBeChecked();
	await expect.element(activity).not.toBeChecked();
	await expect.element(library).toHaveAttribute('name', 'library_visibility');
	await expect.element(activity).toHaveAttribute('name', 'activity_visibility');
	await expect.element(library).toHaveAttribute('value', 'public');
	await expect.element(library).toHaveAccessibleDescription(m.conta_visibility_library_help());
	await expect.element(activity).toHaveAccessibleDescription(m.conta_visibility_activity_help());
	await expect.element(page.getByText(m.conta_visibility_default())).toBeVisible();
	expect(formOf(library.element()).getAttribute('action')).toBe('?/visibility');
});

test('VisibilityForm reflects public flags', async () => {
	await render(VisibilityForm, { library: 'public', activity: 'private', emailVerified: true });
	await expect
		.element(page.getByRole('checkbox', { name: m.conta_visibility_library_label() }))
		.toBeChecked();
	await expect
		.element(page.getByRole('checkbox', { name: m.conta_visibility_activity_label() }))
		.not.toBeChecked();
});

test('PasswordForm: "sign out other sessions" is ticked by default', async () => {
	await render(PasswordForm, {});
	const revoke = page.getByRole('checkbox', { name: m.conta_password_revoke_label() });
	await expect.element(revoke).toBeChecked();
	await expect.element(revoke).toHaveAttribute('name', 'revokeOtherSessions');
	const current = page.getByLabelText(m.conta_password_current());
	await expect.element(current).toHaveAttribute('autocomplete', 'current-password');
	await expect.element(current).toHaveAttribute('name', 'currentPassword');
	await expect
		.element(page.getByLabelText(m.conta_password_new()))
		.toHaveAttribute('autocomplete', 'new-password');
	await expect
		.element(page.getByLabelText(m.conta_password_confirm()))
		.toHaveAttribute('name', 'confirmPassword');
	expect(formOf(current.element()).getAttribute('action')).toBe('?/password');
});

function session(id: string, overrides: Partial<SessionView> = {}): SessionView {
	return {
		id,
		browser: 'Firefox',
		os: 'Linux',
		createdAt: Date.now() - DAY,
		lastActiveAt: Date.now() - 60_000,
		expiresAt: Date.now() + 7 * DAY,
		current: false,
		impersonated: false,
		...overrides
	};
}

test('SessionList: device, last activity and a revoke form for each other session', async () => {
	const current = session('s-current', { current: true });
	const other = session('s-other', { browser: 'Safari', os: 'iOS' });
	await render(SessionList, { sessions: [current, other] });
	await expect.element(page.getByText(m.conta_sessions_current())).toBeVisible();
	const lastActive = m.conta_sessions_last_active({ date: formatDateTime(other.lastActiveAt) });
	await expect
		.element(page.getByRole('listitem').filter({ hasText: deviceLabel(other) }))
		.toMatchTextContent(new RegExp(lastActive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	const revoke = page.getByRole('button', {
		name: m.conta_sessions_revoke_aria({ device: deviceLabel(other) })
	});
	await expect.element(revoke).toBeVisible();
	const form = formOf(revoke.element());
	expect(form.getAttribute('action')).toBe('?/revokeSession');
	expect((form.elements.namedItem('sessionId') as HTMLInputElement).value).toBe('s-other');
	// No revoke button for the current session.
	const currentRevoke = page.getByRole('button', {
		name: m.conta_sessions_revoke_aria({ device: deviceLabel(current) })
	});
	expect(currentRevoke.elements()).toHaveLength(0);
	expect(document.querySelectorAll('input[name="sessionId"]')).toHaveLength(1);
	const others = page.getByRole('button', { name: m.conta_sessions_revoke_others() });
	await expect.element(others).toBeEnabled();
	expect(formOf(others.element()).getAttribute('action')).toBe('?/revokeOthers');
});

test('SessionList: nothing to revoke when this is the only session', async () => {
	await render(SessionList, {
		sessions: [session('only', { current: true, impersonated: false })]
	});
	await expect
		.element(page.getByRole('button', { name: m.conta_sessions_revoke_others() }))
		.toBeDisabled();
	await expect.element(page.getByText(m.conta_sessions_none_other())).toBeVisible();
	expect(page.getByRole('button', { name: m.conta_sessions_revoke() }).elements()).toHaveLength(0);
});

test('SessionList flags a support (impersonation) session', async () => {
	await render(SessionList, {
		sessions: [session('me', { current: true }), session('support', { impersonated: true })]
	});
	await expect.element(page.getByText(m.conta_sessions_impersonated())).toBeVisible();
});

test('EmailForm: current address, pending change and no password on a fresh session', async () => {
	const pending = {
		newEmail: 'novo@example.org',
		requestedAt: Date.now(),
		expiresAt: Date.now() + 2 * 60 * 60 * 1000
	};
	await render(EmailForm, { email: 'atual@example.org', pending, fresh: true, siteKey: '' });
	await expect.element(page.getByText('atual@example.org')).toBeVisible();
	await expect.element(page.getByText(m.conta_email_pending_title())).toBeVisible();
	await expect
		.element(
			page.getByText(
				m.conta_email_pending_body({
					email: pending.newEmail,
					date: formatDateTime(pending.expiresAt)
				})
			)
		)
		.toBeVisible();
	const input = page.getByLabelText(m.conta_email_new());
	await expect.element(input).toHaveAttribute('type', 'email');
	await expect.element(input).toHaveAttribute('name', 'newEmail');
	expect(document.querySelector('input[name="password"]')).toBeNull();
	expect(formOf(input.element()).getAttribute('action')).toBe('?/email');
});

test('EmailForm asks for the password on a stale session and keeps the typed address on error', async () => {
	await render(EmailForm, {
		email: 'atual@example.org',
		pending: null,
		fresh: false,
		siteKey: '',
		feedback: { form: 'email', error: 'reauth-required', value: 'novo@example.org' }
	});
	const password = page.getByLabelText(m.conta_email_password());
	await expect.element(password).toHaveAttribute('autocomplete', 'current-password');
	await expect.element(page.getByLabelText(m.conta_email_new())).toHaveValue('novo@example.org');
	await expect.element(page.getByRole('alert')).toHaveTextContent(m.conta_email_error_reauth());
	expect(document.querySelector('[data-testid="email-pending"]')).toBeNull();
});

test('EmailForm confirms a completed change', async () => {
	await render(EmailForm, {
		email: 'novo@example.org',
		pending: null,
		fresh: true,
		siteKey: '',
		changed: true
	});
	await expect.element(page.getByText(m.conta_email_changed())).toBeVisible();
});

test('ExportForm posts straight to /conta/exportar (browser download, no enhance)', async () => {
	await render(ExportForm, {});
	const button = page.getByRole('button', { name: m.conta_export_submit() });
	const form = formOf(button.element());
	expect(form.method).toBe('post');
	expect(form.getAttribute('action')).toBe('/conta/exportar');
	expect(form.hasAttribute('data-sveltekit-reload')).toBe(true);
});

test('CloseAccountForm: no preselected mode, both effects explained, required checks', async () => {
	await render(CloseAccountForm, {});
	const anonymize = page.getByRole('radio', { name: m.conta_close_mode_anonymize() });
	const deleteAll = page.getByRole('radio', { name: m.conta_close_mode_delete() });
	await expect.element(anonymize).not.toBeChecked();
	await expect.element(deleteAll).not.toBeChecked();
	await expect.element(anonymize).toHaveAccessibleDescription(m.conta_close_mode_anonymize_help());
	await expect.element(deleteAll).toHaveAccessibleDescription(m.conta_close_mode_delete_help());
	await expect.element(page.getByText(m.conta_close_always())).toBeVisible();
	await expect.element(anonymize).toBeRequired();
	await expect.element(page.getByRole('checkbox', { name: m.conta_close_ack() })).toBeRequired();
	await expect.element(page.getByLabelText(m.conta_close_password())).toBeRequired();

	await userEvent.click(anonymize);
	await expect.element(page.getByText(m.conta_close_effect_anonymize())).toBeVisible();
	await userEvent.click(deleteAll);
	await expect.element(page.getByText(m.conta_close_effect_delete())).toBeVisible();
	await expect.element(deleteAll).toHaveAttribute('value', 'delete-all');

	const submit = page.getByRole('button', { name: m.conta_close_submit() });
	// Not disabled: native validation does the checking, also without JavaScript.
	await expect.element(submit).toBeEnabled();
	expect(formOf(submit.element()).getAttribute('action')).toBe('?/close');
});

test('CloseAccountForm shows a pending closure and the result of the request', async () => {
	const requestedAt = Date.now() - 60_000;
	await render(CloseAccountForm, {
		pending: { mode: 'anonymize', requestedAt },
		feedback: { form: 'close', ok: true }
	});
	await expect
		.element(page.getByText(m.conta_close_pending({ date: formatDateTime(requestedAt) })))
		.toBeVisible();
	await expect.element(page.getByRole('status')).toHaveTextContent(m.conta_close_requested());
});

test('feedback of one form does not show in another', async () => {
	await render(PasswordForm, { feedback: { form: 'bio', error: 'too-long' } });
	expect(alertText()).toBe('');
});
