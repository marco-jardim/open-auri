// Public Android App Links configuration. Fingerprints identify signing certificates, not secrets.
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const CERT_SHA256 = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const CERT_SHA256_INPUT = /^(?:[0-9a-f]{64}|(?:[0-9a-f]{2}:){31}[0-9a-f]{2})$/i;

export function parseAndroidAppId(value: unknown): string | null {
	return typeof value === 'string' && APP_ID.test(value) ? value : null;
}

/** Empty/missing configuration is allowed; a malformed entry invalidates the entire list. */
export function parseAndroidCertSha256(value: unknown): string[] | null {
	if (value === undefined || value === '') return [];
	if (typeof value !== 'string') return null;
	const fingerprints = value.split(',').map((entry) => entry.trim());
	if (!fingerprints.every((entry) => CERT_SHA256_INPUT.test(entry))) return null;
	return [
		...new Set(
			fingerprints.map((entry) =>
				entry
					.replaceAll(':', '')
					.toUpperCase()
					.replace(/(..)(?=.)/g, '$1:')
			)
		)
	];
}

export interface AndroidAppLink {
	relation: ['delegate_permission/common.handle_all_urls'];
	target: {
		namespace: 'android_app';
		package_name: string;
		sha256_cert_fingerprints: string[];
	};
}

/** No document is published until both the package and at least one certificate are valid. */
export function buildAndroidAppLinks(
	appId: string | null | undefined,
	fingerprints: readonly string[] | null | undefined
): AndroidAppLink[] | null {
	const packageName = parseAndroidAppId(appId);
	if (!packageName || !fingerprints?.length || !fingerprints.every((v) => CERT_SHA256.test(v))) {
		return null;
	}
	return [
		{
			relation: ['delegate_permission/common.handle_all_urls'],
			target: {
				namespace: 'android_app',
				package_name: packageName,
				sha256_cert_fingerprints: [...new Set(fingerprints)]
			}
		}
	];
}
