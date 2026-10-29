/**
 * Operational state of writing from the Android app (plan 0.2, RF14, RF15). These are not
 * temporary flags: each one is changed only by a site deploy, following
 * docs/operacao/runbooks/android-release.md.
 */

/** Runbook: docs/operacao/runbooks/android-release.md ("Encerrar o aviso"). */
export const ANDROID_WRITE_VALIDATED: boolean = false;

/** Runbook: docs/operacao/runbooks/android-release.md ("Reabrir o aviso"). */
export const ANDROID_DISCLAIMER_VERSION = 2;

/** Runbook: docs/operacao/runbooks/android-release.md ("Desligar ou restringir a gravação"). */
export const ANDROID_WRITE_POLICY: AndroidWritePolicy = {
	enabled: true,
	blockedAppVersions: []
};

export interface AndroidWritePolicy {
	/** false turns writing from every app version off (simulated mode with the G.4 notice). */
	readonly enabled: boolean;
	/** Exact versions ("1.0.0") or upper bounds ("<1.0.3"); see {@link isAppVersionBlocked}. */
	readonly blockedAppVersions: readonly string[];
}

interface SemVer {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease: readonly string[];
}

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parses a SemVer 2.0.0 version; build metadata is ignored. Returns null when invalid. */
export function parseSemVer(value: string): SemVer | null {
	const match = SEMVER.exec(value);
	if (match === null) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] === undefined ? [] : match[4].split('.')
	};
}

function compareIdentifiers(a: string, b: string): number {
	const aNumeric = /^\d+$/.test(a);
	const bNumeric = /^\d+$/.test(b);
	if (aNumeric && bNumeric) return Number(a) - Number(b);
	if (aNumeric) return -1;
	if (bNumeric) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer 2.0.0 precedence: negative when a < b, zero when equal, positive when a > b. */
export function compareSemVer(a: SemVer, b: SemVer): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return b.prerelease.length - a.prerelease.length;
	}
	const length = Math.max(a.prerelease.length, b.prerelease.length);
	for (let i = 0; i < length; i++) {
		const left = a.prerelease[i];
		const right = b.prerelease[i];
		if (left === undefined) return -1;
		if (right === undefined) return 1;
		const order = compareIdentifiers(left, right);
		if (order !== 0) return order;
	}
	return 0;
}

let malformedBlocklistLogged = false;

/**
 * Whether `appVersion` matches a blocked entry: an exact version ("1.0.0") or an upper bound
 * ("<1.0.3", strictly lower). An app version that is not valid SemVer is blocked, so a
 * malformed or spoofed version can never write. Any invalid entry blocks every version.
 */
export function isAppVersionBlocked(
	appVersion: string,
	blocked: readonly string[] = ANDROID_WRITE_POLICY.blockedAppVersions
): boolean {
	const version = parseSemVer(appVersion);
	if (version === null) return true;
	let matches = false;
	for (const entry of blocked) {
		const bound = entry.startsWith('<');
		const target = parseSemVer(bound ? entry.slice(1) : entry);
		if (target === null) {
			if (!malformedBlocklistLogged) {
				console.error('Invalid Android write blocklist entry; all app versions are blocked', entry);
				malformedBlocklistLogged = true;
			}
			return true;
		}
		const order = compareSemVer(version, target);
		matches ||= bound ? order < 0 : order === 0;
	}
	return matches;
}

/** Whether the app at `appVersion` may write to the cable under `policy` (evaluated before any I/O). */
export function canWriteFromApp(
	appVersion: string,
	policy: AndroidWritePolicy = ANDROID_WRITE_POLICY
): boolean {
	return policy.enabled && !isAppVersionBlocked(appVersion, policy.blockedAppVersions);
}
