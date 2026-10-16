// Page states derived from the query string. The only secret read here is the reset token, which
// goes back to the server in a hidden field of the reset form and nowhere else.

/** /verificar-email: Better Auth appends `error=…` to the callback URL when the token is bad. */
export type VerifyStatus = 'verified' | 'invalid' | 'sent' | 'idle';

export function verifyStatus(params: URLSearchParams): VerifyStatus {
	if (params.has('error')) return 'invalid';
	if (params.get('verificado') === '1') return 'verified';
	if (params.get('enviado') === '1') return 'sent';
	return 'idle';
}

/** /entrar: `?redefinida=1` after a password reset. */
export function signInNotice(params: URLSearchParams): 'reset' | null {
	return params.get('redefinida') === '1' ? 'reset' : null;
}

/** Reset tokens are opaque; anything outside this shape is treated as missing. */
export function resetToken(params: URLSearchParams): string | null {
	const token = params.get('token');
	return token && /^[A-Za-z0-9._~-]{8,512}$/.test(token) ? token : null;
}
