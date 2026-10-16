import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import {
	ForgotForm,
	PasswordStrength,
	ResendForm,
	ResetForm,
	SignInForm,
	SignUpForm,
	SignupClosed,
	VerifyEmailView
} from '#lib/components/auth/index.ts';
import AuthShellFixture from './AuthShellFixture.svelte';

beforeEach(async () => {
	await setLocale('pt-BR', { reload: false });
});

afterEach(async () => {
	await cleanup();
	await setLocale('pt-BR', { reload: false });
});

function form(): HTMLFormElement {
	const element = document.querySelector('form');
	if (!(element instanceof HTMLFormElement)) throw new Error('form missing');
	return element;
}

describe('SignInForm', () => {
	test('renders labelled fields, posts to the signIn action and keeps next', async () => {
		await render(SignInForm, { siteKey: '', next: '/biblioteca' });
		await expect
			.element(page.getByLabelText('E-mail', { exact: true }))
			.toHaveAttribute('autocomplete', 'username');
		await expect
			.element(page.getByLabelText('Senha', { exact: true }))
			.toHaveAttribute('type', 'password');
		expect(form().getAttribute('method')).toBe('POST');
		expect(form().getAttribute('action')).toBe('?/signIn');
		const next = form().querySelector<HTMLInputElement>('input[name="next"]');
		expect(next?.value).toBe('/biblioteca');
		expect(form().querySelector('input[name="cf-turnstile-response"]')).not.toBeNull();
		await expect.element(page.getByRole('button', { name: 'Entrar' })).toBeEnabled();
	});

	test('shows the uniform credentials error and keeps the e-mail, not the password', async () => {
		await render(SignInForm, {
			siteKey: '',
			result: { error: 'credentials', values: { email: 'ana@example.com' } }
		});
		await expect.element(page.getByRole('alert')).toHaveTextContent('E-mail ou senha incorretos.');
		await expect
			.element(page.getByLabelText('E-mail', { exact: true }))
			.toHaveValue('ana@example.com');
		await expect.element(page.getByLabelText('Senha', { exact: true })).toHaveValue('');
	});

	test('unverified accounts get a link to resend the confirmation', async () => {
		await render(SignInForm, { siteKey: '', next: '/cabo', result: { error: 'unverified' } });
		await expect
			.element(page.getByRole('link', { name: 'Reenviar o link de confirmação' }))
			.toHaveAttribute('href', '/verificar-email?next=%2Fcabo');
	});

	test('keeps the next echoed by the action after a no-JS round trip', async () => {
		await render(SignInForm, {
			siteKey: '',
			next: null,
			result: { error: 'credentials', next: '/cabo' }
		});
		expect(form().querySelector<HTMLInputElement>('input[name="next"]')?.value).toBe('/cabo');
	});

	test('rate limit shows the wait', async () => {
		await render(SignInForm, { siteKey: '', result: { error: 'rate', retryAfter: 65 } });
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Muitas tentativas. Tente de novo em 1:05.');
	});

	test('field issues are announced through aria-describedby', async () => {
		await render(SignInForm, { siteKey: '', result: { fields: { email: 'email' } } });
		const input = page.getByLabelText('E-mail', { exact: true });
		await expect.element(input).toHaveAttribute('aria-invalid', 'true');
		await expect
			.element(input)
			.toHaveAccessibleDescription('Digite um e-mail válido, como nome@exemplo.com.');
	});

	test('confirms a password reset', async () => {
		await render(SignInForm, { siteKey: '', notice: 'reset' });
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent('Senha redefinida. Entre com a nova senha.');
	});

	test('two-factor step asks for the code instead of the password', async () => {
		await render(SignInForm, { siteKey: '', result: { step: 'two-factor' }, next: '/cabo' });
		await expect
			.element(page.getByRole('heading', { name: 'Verificação em duas etapas' }))
			.toBeVisible();
		await expect
			.element(page.getByLabelText('Código', { exact: true }))
			.toHaveAttribute('autocomplete', 'one-time-code');
		await expect.element(page.getByRole('radio', { name: 'Código do aplicativo' })).toBeChecked();
		expect(page.getByLabelText('Senha', { exact: true }).elements()).toHaveLength(0);
		expect(form().getAttribute('action')).toBe('?/twoFactor');
	});

	test('the show-password toggle is a pressed-state button', async () => {
		await render(SignInForm, { siteKey: '' });
		const toggle = page.getByRole('button', { name: 'Mostrar senha' });
		await expect.element(toggle).toHaveAttribute('aria-pressed', 'false');
		await toggle.click();
		await expect.element(toggle).toHaveAttribute('aria-pressed', 'true');
		await expect
			.element(page.getByLabelText('Senha', { exact: true }))
			.toHaveAttribute('type', 'text');
	});
});

describe('SignUpForm and strength meter', () => {
	test('meter follows the typed password and never disables submit', async () => {
		await render(SignUpForm, { siteKey: '' });
		const meter = page.getByRole('meter', { name: 'Força da senha' });
		await expect.element(meter).toHaveAttribute('aria-valuenow', '0');
		const password = page.getByLabelText('Senha', { exact: true });
		await password.fill('abc');
		await expect
			.element(meter)
			.toHaveAttribute('aria-valuetext', 'curta demais (mínimo de 10 caracteres)');
		await password.fill('password123');
		await expect.element(meter).toHaveAttribute('aria-valuetext', 'muito fraca');
		await expect
			.element(page.getByText('Parece uma senha comum. Evite palavras e números óbvios.'))
			.toBeVisible();
		await password.fill('violino-tarde-cobalto-ninho');
		await expect.element(meter).toHaveAttribute('aria-valuetext', 'muito forte');
		await expect.element(page.getByRole('button', { name: 'Criar conta' })).toBeEnabled();
		await expect
			.element(password)
			.toHaveAttribute('aria-describedby', expect.stringContaining('-strength'));
		expect(document.querySelectorAll('.led.on')).toHaveLength(5);
	});

	test('warns about the e-mail inside the password', async () => {
		await render(SignUpForm, { siteKey: '' });
		await page.getByLabelText('E-mail', { exact: true }).fill('marquinho@example.com');
		await page.getByLabelText('Senha', { exact: true }).fill('marquinho-2024!');
		await expect.element(page.getByText('Não use partes do seu e-mail.')).toBeVisible();
	});

	test('shows server-side field issues', async () => {
		await render(SignUpForm, {
			siteKey: '',
			result: { fields: { confirm: 'mismatch' }, values: { email: 'ana@example.com' } }
		});
		await expect.element(page.getByText('As senhas não conferem.')).toBeVisible();
		await expect
			.element(page.getByLabelText('Repita a senha', { exact: true }))
			.toHaveAttribute('aria-invalid', 'true');
		await expect
			.element(page.getByRole('link', { name: 'Termos de uso' }))
			.toHaveAttribute('href', '/termos');
	});

	test('meter is dark with nothing typed', async () => {
		await render(PasswordStrength, { id: 'meter', password: '' });
		expect(document.querySelectorAll('.led.on')).toHaveLength(0);
		await expect
			.element(page.getByRole('meter'))
			.toHaveAttribute('aria-valuetext', 'aguardando (mínimo de 10 caracteres)');
	});
});

describe('signup disabled', () => {
	test('explains that sign-up opens soon, without any form', async () => {
		await render(SignupClosed, { next: '/biblioteca' });
		await expect.element(page.getByText('Cadastro fechado por enquanto')).toBeVisible();
		expect(document.querySelector('form')).toBeNull();
		expect(document.querySelector('input[type="password"]')).toBeNull();
		await expect
			.element(page.getByRole('link', { name: 'Entrar com uma conta existente' }))
			.toHaveAttribute('href', '/entrar?next=%2Fbiblioteca');
	});
});

describe('resend with cooldown', () => {
	test('shows the remaining wait and disables the button until it ends', async () => {
		let clock = 1_800_000_000_000;
		await render(ResendForm, { availableAt: clock + 240_000, now: () => clock });
		const button = page.getByRole('button', { name: 'Reenviar link' });
		await expect.element(page.getByText('Próximo envio liberado em 4:00.')).toBeVisible();
		await expect.element(button).toBeDisabled();
		clock += 240_000;
		await expect.element(button).toBeEnabled();
		await expect.element(page.getByText('Você já pode pedir outro envio.')).toBeInTheDocument();
	});

	test('a successful resend is uniform and starts a new wait', async () => {
		const now = 1_800_000_000_000;
		await render(ResendForm, {
			now: () => now,
			result: {
				sent: true,
				values: { email: 'ana@example.com' },
				resendAvailableAt: now + 300_000
			}
		});
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent(
				'Se houver uma conta aguardando confirmação com esse e-mail, enviamos um novo link.'
			);
		await expect.element(page.getByText('Próximo envio liberado em 5:00.')).toBeVisible();
	});

	test('an early no-JS click gets the wait from the server', async () => {
		const now = 1_800_000_000_000;
		await render(ResendForm, {
			now: () => now,
			result: { error: 'cooldown', retryAfter: 30, resendAvailableAt: now + 30_000 }
		});
		await expect.element(page.getByText('Aguarde 0:30 para pedir outro envio.')).toBeVisible();
	});
});

describe('verification landing', () => {
	test.each([
		['verified', 'A sua conta está ativa. Entre para continuar.'],
		['invalid', 'Este link de confirmação é inválido ou já venceu. Peça outro abaixo.'],
		['sent', 'Se o endereço puder receber, enviamos um link de confirmação.']
	] as const)('%s', async (status, text) => {
		await render(VerifyEmailView, { status });
		await expect.element(page.getByText(text, { exact: false })).toBeVisible();
		const hasForm = document.querySelector('form') !== null;
		expect(hasForm).toBe(status !== 'verified');
	});
});

describe('password reset pages', () => {
	test('forgot: uniform confirmation', async () => {
		await render(ForgotForm, { siteKey: '', result: { sent: true } });
		await expect
			.element(page.getByRole('status'))
			.toMatchTextContent(/^Se existir uma conta com esse e-mail, enviamos um link\./);
	});

	test('reset without a token offers a new link and no form', async () => {
		await render(ResetForm, { token: null });
		await expect
			.element(page.getByRole('alert'))
			.toMatchTextContent(/^Este endereço não tem um link de redefinição válido\./);
		await expect
			.element(page.getByRole('link', { name: 'Pedir um link novo' }))
			.toHaveAttribute('href', '/esqueci-senha');
		expect(document.querySelector('form')).toBeNull();
	});

	test('reset with a token carries it in a hidden field', async () => {
		await render(ResetForm, { token: 'AbC123xyz456' });
		expect(form().querySelector<HTMLInputElement>('input[name="token"]')?.value).toBe(
			'AbC123xyz456'
		);
		await expect
			.element(page.getByLabelText('Nova senha', { exact: true }))
			.toHaveAttribute('autocomplete', 'new-password');
	});
});

describe('AuthShell', () => {
	test('one main landmark titled by the h1, decorative cap hidden', async () => {
		await render(AuthShellFixture);
		await expect.element(page.getByRole('main', { name: 'Entrar' })).toBeVisible();
		await expect.element(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
		expect(document.querySelector('.cap')?.getAttribute('aria-hidden')).toBe('true');
		await expect.element(page.getByText('Canal 01')).toBeInTheDocument();
		await expect.element(page.getByRole('link', { name: 'Esqueci a senha' })).toBeVisible();
	});
});
