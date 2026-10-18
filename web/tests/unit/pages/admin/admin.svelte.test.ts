// Admin components (AdminNav, ReauthPrompt, UserModeration, AuditTable) in both locales. The
// forms are rendered as plain HTML forms; `use:enhance` only upgrades them.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// Kit's client runtime is not booted in component tests (the auth forms avoid it the same way):
// `use:enhance` becomes a no-op and the forms stay plain HTML forms.
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }));
import { cleanup, render } from 'vitest-browser-svelte';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import AdminNav from '#lib/components/admin/AdminNav.svelte';
import AuditTable from '#lib/components/admin/AuditTable.svelte';
import ReauthPrompt from '#lib/components/admin/ReauthPrompt.svelte';
import UserModeration from '#lib/components/admin/UserModeration.svelte';
import { detailText, formatWhen, type AuditTableRow } from '#lib/components/admin/format.ts';

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

function only<T extends Element>(container: HTMLElement, selector: string): T {
	const found = container.querySelectorAll<T>(selector);
	expect(found, selector).toHaveLength(1);
	return found[0]!;
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	describe(`admin components in ${locale}`, () => {
		test('AdminNav marks only the exact current page', async () => {
			await setLocale(locale, { reload: false });
			const screen = await render(AdminNav, { currentPath: '/admin/usuarios' });
			const nav = page.getByRole('navigation', { name: m.admin_nav_label() });
			await expect.element(nav).toBeInTheDocument();
			const links = [...screen.container.querySelectorAll('a')];
			expect(links.map((link) => link.getAttribute('href'))).toEqual([
				'/admin',
				'/admin/usuarios',
				'/admin/moderacao',
				'/admin/auditoria'
			]);
			expect(links.map((link) => link.textContent)).toEqual([
				m.admin_nav_dashboard(),
				m.admin_nav_users(),
				m.admin_nav_moderation(),
				m.admin_nav_audit()
			]);
			expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([
				null,
				'page',
				null,
				null
			]);
		});

		test('ReauthPrompt with 2FA posts the code to ?/reauth, without an error at first', async () => {
			await setLocale(locale, { reload: false });
			const screen = await render(ReauthPrompt, { twoFactorEnabled: true });
			await expect
				.element(page.getByRole('region', { name: m.admin_reauth_heading() }))
				.toBeInTheDocument();
			expect(screen.container.textContent).toContain(m.admin_reauth_body());
			const form = only<HTMLFormElement>(screen.container, 'form');
			expect(form.getAttribute('method')).toBe('POST');
			expect(form.getAttribute('action')).toBe('?/reauth');
			const input = page.getByLabelText(m.admin_reauth_code_label());
			await expect.element(input).toHaveAttribute('name', 'code');
			await expect.element(input).toHaveAttribute('autocomplete', 'one-time-code');
			await expect.element(input).toHaveAttribute('inputmode', 'numeric');
			await expect.element(input).toBeRequired();
			await expect.element(input).not.toHaveAttribute('aria-invalid');
			await expect.element(input).not.toHaveAttribute('aria-describedby');
			await expect
				.element(page.getByRole('button', { name: m.admin_reauth_submit() }))
				.toHaveAttribute('type', 'submit');
			expect(page.getByRole('alert').elements()).toHaveLength(0);
		});

		for (const [error, message] of [
			['INVALID_CODE', () => m.admin_reauth_invalid()],
			['RATE_LIMITED', () => m.admin_reauth_rate_limited()],
			['NO_SECOND_FACTOR', () => m.admin_reauth_no_2fa()]
		] as const) {
			test(`ReauthPrompt announces ${error} and ties it to the code field`, async () => {
				await setLocale(locale, { reload: false });
				await render(ReauthPrompt, { twoFactorEnabled: true, error });
				const alert = page.getByRole('alert');
				await expect.element(alert).toHaveTextContent(message());
				const input = page.getByLabelText(m.admin_reauth_code_label());
				await expect.element(input).toHaveAttribute('aria-invalid', 'true');
				await expect
					.element(input)
					.toHaveAttribute('aria-describedby', alert.element().getAttribute('id') ?? '');
				await expect.element(input).toHaveAccessibleDescription(message());
			});
		}

		test('ReauthPrompt without 2FA has no form and says to sign in again', async () => {
			await setLocale(locale, { reload: false });
			const screen = await render(ReauthPrompt, { twoFactorEnabled: false });
			expect(screen.container.querySelector('form')).toBeNull();
			expect(screen.container.textContent).toContain(m.admin_reauth_no_2fa());
			expect(page.getByRole('alert').elements()).toHaveLength(0);
		});

		test('ReauthPrompt without 2FA still announces a refused attempt', async () => {
			await setLocale(locale, { reload: false });
			const screen = await render(ReauthPrompt, {
				twoFactorEnabled: false,
				error: 'RATE_LIMITED'
			});
			expect(screen.container.querySelector('form')).toBeNull();
			await expect
				.element(page.getByRole('alert'))
				.toHaveTextContent(m.admin_reauth_rate_limited());
		});

		test('UserModeration: an active user gets the ban form, 7 days preselected', async () => {
			await setLocale(locale, { reload: false });
			const screen = await render(UserModeration, {
				userId: 'u-1',
				banned: false,
				label: 'ana'
			});
			const summary = only<HTMLElement>(screen.container, 'summary');
			expect(summary.textContent?.trim()).toBe(m.admin_ban_summary({ user: 'ana' }));
			await summary.click();
			const form = only<HTMLFormElement>(screen.container, 'form');
			expect(form.getAttribute('method')).toBe('POST');
			expect(form.getAttribute('action')).toBe('?/ban');
			expect(form.querySelector<HTMLInputElement>('input[name="userId"]')?.value).toBe('u-1');
			const reason = page.getByLabelText(m.admin_reason_label());
			await expect.element(reason).toBeRequired();
			await expect.element(reason).toHaveAttribute('minlength', '3');
			await expect.element(reason).toHaveAttribute('maxlength', '500');
			const duration = page.getByLabelText(m.admin_ban_duration_label());
			await expect.element(duration).toHaveValue('7');
			const options = [...form.querySelectorAll('option')];
			expect(options.map((option) => option.value)).toEqual([
				'1',
				'7',
				'30',
				'90',
				'365',
				'permanent'
			]);
			expect(options.map((option) => option.textContent)).toEqual([
				m.admin_duration_1(),
				m.admin_duration_7(),
				m.admin_duration_30(),
				m.admin_duration_90(),
				m.admin_duration_365(),
				m.admin_duration_permanent()
			]);
			await expect
				.element(page.getByRole('button', { name: m.admin_ban_submit() }))
				.toHaveAttribute('type', 'submit');
		});

		test('UserModeration: a banned user gets the unban form, no duration', async () => {
			await setLocale(locale, { reload: false });
			const screen = await render(UserModeration, {
				userId: 'u/2 x',
				banned: true,
				label: 'bia'
			});
			const summary = only<HTMLElement>(screen.container, 'summary');
			expect(summary.textContent?.trim()).toBe(m.admin_unban_summary({ user: 'bia' }));
			await summary.click();
			const form = only<HTMLFormElement>(screen.container, 'form');
			expect(form.getAttribute('action')).toBe('?/unban');
			expect(form.querySelector<HTMLInputElement>('input[name="userId"]')?.value).toBe('u/2 x');
			expect(form.querySelector('select')).toBeNull();
			await expect.element(page.getByLabelText(m.admin_reason_label())).toBeRequired();
			await expect
				.element(page.getByRole('button', { name: m.admin_unban_submit() }))
				.toBeInTheDocument();
		});

		test('AuditTable: no rows, no table', async () => {
			await setLocale(locale, { reload: false });
			const screen = await render(AuditTable, { rows: [], locale });
			expect(screen.container.querySelector('table')).toBeNull();
			expect(screen.container.textContent).toContain(m.admin_audit_empty());
		});

		test('AuditTable: actors, targets and details as text, in a focusable region', async () => {
			await setLocale(locale, { reload: false });
			const createdAt = Date.UTC(2026, 9, 16, 14, 5);
			const rows: AuditTableRow[] = [
				{
					id: 'a1',
					actorId: 'admin-7',
					actorKind: 'admin',
					action: 'user.ban',
					targetKind: 'user',
					targetId: 'u 1/2',
					detail: { reason: '<b>spam</b>', days: 7 },
					createdAt
				},
				{
					id: 'a2',
					actorId: null,
					actorKind: 'operator',
					action: 'flag.set',
					targetKind: null,
					targetId: 'f1',
					detail: null,
					createdAt
				},
				{
					id: 'a3',
					actorId: null,
					actorKind: 'system',
					action: 'ban.expire',
					targetKind: null,
					targetId: null,
					detail: { note: 'auto' },
					createdAt
				}
			];
			const screen = await render(AuditTable, { rows, locale });
			const region = page.getByRole('region', { name: m.admin_audit_heading() });
			await expect.element(region).toHaveAttribute('tabindex', '0');
			const headers = [...screen.container.querySelectorAll('th')].map((th) => th.textContent);
			expect(headers).toEqual([
				m.admin_audit_col_when(),
				m.admin_audit_col_actor(),
				m.admin_audit_col_action(),
				m.admin_audit_col_target(),
				m.admin_audit_col_detail()
			]);
			const body = [...screen.container.querySelectorAll('tbody tr')];
			expect(body).toHaveLength(3);
			const cells = body.map((row) => [...row.querySelectorAll('td')]);

			const time = cells[0]![0]!.querySelector('time');
			expect(time?.getAttribute('datetime')).toBe(new Date(createdAt).toISOString());
			expect(time?.textContent).toBe(formatWhen(createdAt, locale));

			expect(cells[0]![1]!.textContent).toBe(`${m.admin_actor_admin()} admin-7`);
			expect(cells[1]![1]!.textContent).toBe(m.admin_actor_operator());
			expect(cells[2]![1]!.textContent).toBe(m.admin_actor_system());

			expect(cells[0]![2]!.querySelector('code')?.textContent).toBe('user.ban');

			const first = cells[0]![3]!.querySelector('a');
			expect(first?.getAttribute('href')).toBe('/admin/auditoria?target=u%201%2F2');
			expect(first?.textContent).toBe('user u 1/2');
			const second = cells[1]![3]!.querySelector('a');
			expect(second?.getAttribute('href')).toBe('/admin/auditoria?target=f1');
			expect(second?.textContent).toBe(' f1');
			expect(cells[2]![3]!.querySelector('a')).toBeNull();

			// Free text stays text: no element is created from the ban reason.
			expect(cells[0]![4]!.textContent).toBe(detailText({ reason: '<b>spam</b>', days: 7 }));
			expect(cells[0]![4]!.querySelector('b')).toBeNull();
			expect(cells[1]![4]!.textContent).toBe('');
			expect(cells[2]![4]!.textContent).toBe('note=auto');
		});
	});
}
