// Security layer (T3.3). Wiring into hooks.server.ts and Better Auth is T3.5: see ./README.md.
export {
	captureAccess,
	isAccessLogEnabled,
	routeGroup,
	type AccessEventLike,
	type AccessRecord,
	type CaptureOptions
} from './access-log.ts';
export {
	createAuthGuard,
	type AuthGuard,
	type AuthGuardCode,
	type AuthGuardInput,
	type AuthGuardResult
} from './auth-guard.ts';
export {
	applySecurityHeaders,
	PERMISSIONS_POLICY,
	renderStaticHeadersFile,
	securityHeaders
} from './headers.ts';
export {
	createKeyedHasher,
	getDailySalt,
	InvalidIpError,
	ipHash,
	normalizeIp,
	SaltUnavailableError
} from './iphash.ts';
export {
	AUTH_GUARDED_PATHS,
	AUTH_POLICIES,
	authRateLimit,
	rateLimit,
	rateLimitKey,
	slidingWindowLimit,
	type RateLimitKey
} from './ratelimit.ts';
export {
	TURNSTILE_ACTIONS,
	verifyTurnstile,
	type TurnstileFailure,
	type TurnstileResult
} from './turnstile.ts';
