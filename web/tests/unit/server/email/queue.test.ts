import { describe, expect, it, vi } from 'vitest';
import { EmailError, type EmailMessage, type EmailProvider } from '#lib/server/email/provider.ts';
import { queueEmail } from '#lib/server/email/queue.ts';

const ADDRESS = 'fila.teste@example.com';

const message: EmailMessage = {
	to: ADDRESS,
	subject: 'Assunto secreto',
	html: '<p>token-abc</p>',
	text: 'token-abc',
	idempotencyKey: 'verify-email:deadbeef'
};

function context() {
	const pending: Promise<unknown>[] = [];
	return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, pending };
}

function failing(error: unknown): EmailProvider {
	return { send: async () => Promise.reject(error) };
}

describe('queueEmail', () => {
	it('schedules the send with waitUntil and returns before it settles', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const send = vi.fn<EmailProvider['send']>(async () => {
			await gate;
			return { id: 'msg' };
		});
		const { ctx, pending } = context();
		const logger = { warn: vi.fn() };

		const task = queueEmail(ctx, { send }, { templateId: 'verify-email', message }, logger);
		expect(pending).toEqual([task]);
		expect(send).toHaveBeenCalledWith(message);

		release();
		await expect(task).resolves.toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('logs only the template id, the error kind and the status', async () => {
		const { ctx } = context();
		const logger = { warn: vi.fn() };
		await queueEmail(
			ctx,
			failing(new EmailError('unavailable', 'Resend server error', { status: 503 })),
			{ templateId: 'reset-password', message },
			logger
		);
		expect(logger.warn).toHaveBeenCalledWith('email.send failed', {
			template: 'reset-password',
			kind: 'unavailable',
			status: 503
		});
	});

	it('labels unexpected errors and unsafe template ids without echoing them', async () => {
		const { ctx } = context();
		const logger = { warn: vi.fn() };
		await queueEmail(
			ctx,
			failing(new Error(`boom for ${ADDRESS}`)),
			{ templateId: `custom ${ADDRESS}`, message },
			logger
		);
		expect(logger.warn).toHaveBeenCalledWith('email.send failed', {
			template: 'custom',
			kind: 'unexpected'
		});
		const logged = JSON.stringify(logger.warn.mock.calls);
		for (const secret of [ADDRESS, 'Assunto secreto', 'token-abc', 'deadbeef']) {
			expect(logged).not.toContain(secret);
		}
	});

	it('uses console by default and never leaks the message there', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		try {
			const { ctx } = context();
			await queueEmail(ctx, failing(new EmailError('suppressed', 'recipient is on the list')), {
				templateId: 'password-changed',
				message
			});
			expect(warn).toHaveBeenCalledOnce();
			expect(JSON.stringify(warn.mock.calls)).not.toContain(ADDRESS);
		} finally {
			warn.mockRestore();
		}
	});
});
