// audit_log (migration 0003, T3.8): append-only at the database level, no personal data in
// `detail`, audit-first mutations, pagination.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	audit,
	AuditEntryError,
	audited,
	auditStatement,
	listAudit,
	parsePage,
	serializeDetail
} from '#lib/server/admin/audit.ts';
import { batch } from '#lib/server/db.ts';

function target(): string {
	return `t-${crypto.randomUUID()}`;
}

describe('audit_log is append-only', () => {
	it('rejects UPDATE and DELETE of any row', async () => {
		const targetId = target();
		await audit(env.DB, {
			actorId: 'admin-1',
			actorKind: 'admin',
			action: 'user.ban',
			targetKind: 'user',
			targetId,
			detail: { reason: 'spam', days: 7 }
		});
		const row = await env.DB.prepare('SELECT id FROM audit_log WHERE target_id = ?')
			.bind(targetId)
			.first<{ id: string }>();
		expect(row).not.toBeNull();
		const id = row?.id ?? '';

		await expect(
			env.DB.prepare('UPDATE audit_log SET action = ? WHERE id = ?').bind('user.unban', id).run()
		).rejects.toThrow(/append-only/);
		await expect(
			env.DB.prepare('UPDATE audit_log SET detail = NULL WHERE id = ?').bind(id).run()
		).rejects.toThrow(/append-only/);
		await expect(
			env.DB.prepare('DELETE FROM audit_log WHERE id = ?').bind(id).run()
		).rejects.toThrow(/append-only/);
		await expect(env.DB.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/append-only/);

		const after = await listAudit(env.DB, { targetId });
		expect(after.rows).toHaveLength(1);
		expect(after.rows[0]).toMatchObject({
			action: 'user.ban',
			detail: { reason: 'spam', days: 7 }
		});
	});

	it('enforces actor kinds, JSON detail and a non-empty action in SQL too', async () => {
		const insert = (actorKind: string, action: string, detail: string | null) =>
			env.DB.prepare(
				'INSERT INTO audit_log (id, actor_id, actor_kind, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
			)
				.bind(crypto.randomUUID(), null, actorKind, action, detail, Date.now())
				.run();
		await expect(insert('root', 'x.y', null)).rejects.toThrow();
		await expect(insert('system', '', null)).rejects.toThrow();
		await expect(insert('system', 'x.y', 'not json')).rejects.toThrow();
		await expect(insert('system', 'x.y', '{"ok":true}')).resolves.toBeDefined();
	});
});

describe('audit helper', () => {
	it('refuses personal-data keys and bad actions before reaching the database', () => {
		for (const key of [
			'email',
			'e-mail',
			'userEmail',
			'ip',
			'ipHash',
			'token',
			'password',
			'userAgent',
			'address'
		]) {
			expect(() => serializeDetail({ [key]: 'x' })).toThrow(AuditEntryError);
		}
		expect(serializeDetail({ reason: 'x'.repeat(800), days: Number.NaN, ok: true })).toBe(
			JSON.stringify({ reason: 'x'.repeat(500), days: null, ok: true })
		);
		expect(serializeDetail({ description: 'ids only', recipientId: 'u1' })).toContain(
			'recipientId'
		);
		expect(serializeDetail(null)).toBeNull();
		expect(() =>
			auditStatement(env.DB, { actorId: null, actorKind: 'system', action: 'DROP TABLE' })
		).toThrow(AuditEntryError);
	});

	it('writes the intent first and appends `.failed` when the mutation throws', async () => {
		const targetId = target();
		const entry = {
			actorId: 'admin-2',
			actorKind: 'admin' as const,
			action: 'config.change',
			targetKind: 'config',
			targetId
		};
		let ran = false;
		await expect(
			audited(env.DB, entry, async () => {
				ran = true;
				throw Object.assign(new Error('nope'), { body: { code: 'SOMETHING_FAILED' } });
			})
		).rejects.toThrow('nope');
		expect(ran).toBe(true);
		const rows = (await listAudit(env.DB, { targetId })).rows;
		expect(rows.map((row) => row.action).sort()).toEqual(['config.change', 'config.change.failed']);
		expect(rows.find((row) => row.action.endsWith('.failed'))?.detail).toEqual({
			reason: 'SOMETHING_FAILED'
		});

		const value = await audited(env.DB, { ...entry, targetId: target() }, async () => 42);
		expect(value).toBe(42);
	});

	it('never runs the mutation when the audit row cannot be written', async () => {
		let ran = false;
		await expect(
			audited(
				env.DB,
				{ actorId: null, actorKind: 'system', action: 'x.y', detail: { email: 'leak' } },
				async () => {
					ran = true;
				}
			)
		).rejects.toThrow(AuditEntryError);
		expect(ran).toBe(false);
	});

	it('paginates newest first and works inside a batch', async () => {
		const targetId = target();
		const base = Date.UTC(2026, 9, 16, 12, 0, 0);
		await batch(
			env.DB,
			[0, 1, 2, 3, 4].map((index) =>
				auditStatement(
					env.DB,
					{ actorId: null, actorKind: 'system', action: `job.step${index}`, targetId },
					{ now: () => base + index * 1000 }
				)
			)
		);
		const first = await listAudit(env.DB, { targetId, page: 1, pageSize: 2 });
		expect(first).toMatchObject({ page: 1, pageSize: 2, total: 5, pages: 3 });
		expect(first.rows.map((row) => row.action)).toEqual(['job.step4', 'job.step3']);
		const last = await listAudit(env.DB, { targetId, page: 3, pageSize: 2 });
		expect(last.rows.map((row) => row.action)).toEqual(['job.step0']);
		expect((await listAudit(env.DB, { targetId, page: 9, pageSize: 2 })).rows).toEqual([]);
		const all = await listAudit(env.DB, { pageSize: 1 });
		expect(all.total).toBeGreaterThanOrEqual(5);
	});

	it('parses page numbers defensively', () => {
		expect(parsePage(null)).toBe(1);
		expect(parsePage('3')).toBe(3);
		expect(parsePage('0')).toBe(1);
		expect(parsePage('-2')).toBe(1);
		expect(parsePage('1e3')).toBe(1);
		expect(parsePage('99999')).toBe(10_000);
	});
});
