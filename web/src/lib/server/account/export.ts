// LGPD data export (art. 18, II and V): one JSON document generated on demand from a registry of
// sections. Every section reads ONLY rows of the requesting user (`ctx.userId`) and never secrets:
// no password hashes, session tokens, 2FA secrets or backup codes, OAuth tokens, IP addresses or
// verification values. F4 (curves, versions, favorites, activity, shares, packs) appends sections
// to ACCOUNT_EXPORT_SECTIONS; keys must be unique.
import type { D1Database } from '@cloudflare/workers-types';
import { all, first, sql } from '../db.ts';
import { listAcceptances } from '../legal/acceptance.ts';
import { socialSection } from '../social/export.ts';
import { readHidden } from '../social/hidden.ts';
import { readDeletionRequest } from './deletion.ts';
import { pendingEmailChange } from './email-change.ts';
import { listNicknameHolds } from './nickname.ts';
import { getAccountProfile, toEpoch } from './profile.ts';
import { listAccountSessions } from './sessions.ts';

export const EXPORT_FORMAT = 'open-auri.account-export';
export const EXPORT_VERSION = 1;

export interface ExportContext {
	db: D1Database;
	userId: string;
	/** Session that asked for the export (flagged in the sessions section). */
	currentSessionId: string | null;
	now: number;
}

export interface ExportSection {
	/** Key of the section in the document. */
	readonly key: string;
	collect(ctx: ExportContext): Promise<unknown>;
}

export interface AccountExport {
	format: typeof EXPORT_FORMAT;
	version: typeof EXPORT_VERSION;
	generatedAt: string;
	userId: string;
	sections: Record<string, unknown>;
}

function iso(value: number | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}

export const accountSection: ExportSection = {
	key: 'account',
	async collect({ db, userId }) {
		const user = await first<{
			id: string;
			email: string;
			name: string | null;
			emailVerified: number | null;
			createdAt: string | number | null;
			updatedAt: string | number | null;
			role: string | null;
			banned: number | null;
			banReason: string | null;
			banExpires: string | number | null;
			twoFactorEnabled: number | null;
		}>(
			sql(
				db,
				'SELECT "id", "email", "name", "emailVerified", "createdAt", "updatedAt", "role", ' +
					'"banned", "banReason", "banExpires", "twoFactorEnabled" FROM "user" WHERE "id" = ?',
				userId
			)
		);
		if (!user) return null;
		const methods = await all<{ providerId: string; createdAt: string | number | null }>(
			sql(
				db,
				'SELECT "providerId", "createdAt" FROM "account" WHERE "userId" = ? ORDER BY "createdAt"',
				userId
			)
		);
		return {
			id: user.id,
			email: user.email,
			name: user.name ?? '',
			emailVerified: user.emailVerified === 1,
			createdAt: iso(toEpoch(user.createdAt)),
			updatedAt: iso(toEpoch(user.updatedAt)),
			role: user.role ?? 'user',
			twoFactorEnabled: user.twoFactorEnabled === 1,
			banned: user.banned === 1,
			banReason: user.banReason,
			banExpires: iso(toEpoch(user.banExpires)),
			signInMethods: methods.map((method) => ({
				provider: method.providerId,
				createdAt: iso(toEpoch(method.createdAt))
			}))
		};
	}
};

export const profileSection: ExportSection = {
	key: 'profile',
	async collect({ db, userId, now }) {
		const profile = await getAccountProfile(db, userId, now);
		if (!profile) return null;
		return {
			nickname: profile.displayUsername,
			nicknameNormalized: profile.username,
			nicknameChangedAt: iso(profile.usernameChangedAt),
			bio: profile.bio,
			activityVisibility: profile.activityVisibility,
			libraryVisibility: profile.libraryVisibility,
			previousNicknamesOnHold: (await listNicknameHolds(db, userId, now)).map((hold) => ({
				nickname: hold.username,
				releasedAt: iso(hold.releasedAt)
			}))
		};
	}
};

export const policyAcceptancesSection: ExportSection = {
	key: 'policyAcceptances',
	async collect({ db, userId }) {
		return (await listAcceptances(db, userId)).map((row) => ({
			version: row.version,
			acceptedAt: iso(row.acceptedAt)
		}));
	}
};

export const sessionsSection: ExportSection = {
	key: 'sessions',
	async collect({ db, userId, currentSessionId, now }) {
		return (await listAccountSessions(db, userId, currentSessionId, now)).map((session) => ({
			browser: session.browser,
			os: session.os,
			createdAt: iso(session.createdAt),
			lastActiveAt: iso(session.lastActiveAt),
			expiresAt: iso(session.expiresAt),
			current: session.current,
			impersonated: session.impersonated
		}));
	}
};

export const pendingRequestsSection: ExportSection = {
	key: 'pendingRequests',
	async collect({ db, userId, now }) {
		const email = await first<{ email: string }>(
			sql(db, 'SELECT "email" FROM "user" WHERE "id" = ?', userId)
		);
		const change = email ? await pendingEmailChange(db, userId, email.email, now) : null;
		const closure = await readDeletionRequest(db, userId);
		return {
			emailChange: change
				? {
						newEmail: change.newEmail,
						requestedAt: iso(change.requestedAt),
						expiresAt: iso(change.expiresAt)
					}
				: null,
			accountClosure: closure ? { mode: closure.mode, requestedAt: iso(closure.requestedAt) } : null
		};
	}
};

/** Sections of F3 (account and profile). F4 appends its own. */
export const ACCOUNT_EXPORT_SECTIONS: readonly ExportSection[] = [
	accountSection,
	profileSection,
	policyAcceptancesSection,
	sessionsSection,
	pendingRequestsSection,
	socialSection,
	{ key: 'hiddenItems', collect: ({ db, userId }) => readHidden(db, userId) }
];

export async function buildAccountExport(
	ctx: ExportContext,
	sections: readonly ExportSection[] = ACCOUNT_EXPORT_SECTIONS
): Promise<AccountExport> {
	const keys = new Set<string>();
	for (const section of sections) {
		if (keys.has(section.key)) throw new Error(`Duplicate export section: ${section.key}`);
		keys.add(section.key);
	}
	const values = await Promise.all(sections.map((section) => section.collect(ctx)));
	const collected: Record<string, unknown> = {};
	sections.forEach((section, index) => {
		collected[section.key] = values[index];
	});
	return {
		format: EXPORT_FORMAT,
		version: EXPORT_VERSION,
		generatedAt: new Date(ctx.now).toISOString(),
		userId: ctx.userId,
		sections: collected
	};
}

/** `open-auri-dados-2026-10-16.json`: no personal data in the file name. */
export function exportFileName(now: number): string {
	return `open-auri-dados-${new Date(now).toISOString().slice(0, 10)}.json`;
}

/** The download response: attachment, never cached, never sniffed. */
export function exportResponse(document: AccountExport, now: number): Response {
	return new Response(`${JSON.stringify(document, null, 2)}\n`, {
		status: 200,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'content-disposition': `attachment; filename="${exportFileName(now)}"`,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
}
