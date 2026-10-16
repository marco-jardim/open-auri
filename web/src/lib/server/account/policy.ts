// Signed-in acknowledgement of the privacy policy and terms (T3.4 table policy_acceptances).
// Only the version currently published can be acknowledged: a client cannot record a future or
// past version it never saw.
import type { D1Database } from '@cloudflare/workers-types';
import { POLICY_VERSION } from '../../content/legal/version.ts';
import { latestAcceptedVersion, recordAcceptance } from '../legal/acceptance.ts';

export type PolicyAcceptResult = { ok: true; version: string } | { ok: false; error: 'version' };

export async function acceptCurrentPolicy(
	db: D1Database,
	userId: string,
	version: unknown,
	now: number,
	current: string = POLICY_VERSION
): Promise<PolicyAcceptResult> {
	if (version !== current) return { ok: false, error: 'version' };
	await recordAcceptance(db, userId, current, now);
	return { ok: true, version: current };
}

/** Banner state for a signed-in user: the published version and the last one acknowledged. */
export async function policyBannerState(
	db: D1Database,
	userId: string,
	current: string = POLICY_VERSION
): Promise<{ version: string; seenVersion: string | null }> {
	return { version: current, seenVersion: await latestAcceptedVersion(db, userId) };
}
