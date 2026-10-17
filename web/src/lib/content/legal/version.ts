/**
 * Version of the privacy policy and terms currently published. Bump it (ISO date of the change)
 * whenever either text changes in a relevant way: the app then shows the change notice again.
 * The `**Versão:**` / `**Version:**` lines of docs/legal/*.md and the terms must match (tested).
 */
export const POLICY_VERSION = '2026-10-17';

/** localStorage key holding the last policy version an anonymous visitor has seen. */
export const POLICY_SEEN_KEY = 'oa.policy.seen';

/** Accepted shape of a policy version: an ISO calendar date. */
export const POLICY_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isPolicyVersion(value: unknown): value is string {
	return typeof value === 'string' && POLICY_VERSION_PATTERN.test(value);
}
