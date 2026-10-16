// Browser client of the auth API (`/api/auth`, same origin; relative base URL). Calls to the
// Turnstile-guarded endpoints (sign-up, sign-in, request-password-reset, change-email) must send
// the widget token in the `x-turnstile-token` header, e.g.
//   authClient.signIn.email({ email, password }, { headers: { 'x-turnstile-token': token } })
import { adminClient, twoFactorClient, usernameClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/svelte';

export const TURNSTILE_HEADER = 'x-turnstile-token';

export const authClient = createAuthClient({
	basePath: '/api/auth',
	plugins: [usernameClient(), adminClient(), twoFactorClient()]
});
