import { defineEnvVars } from '@sveltejs/kit/env';

// Kit 3 declares public variables explicitly instead of using kit.env.publicPrefix.
export const variables = defineEnvVars({
	PUBLIC_ORIGIN: { public: true, static: true },
	PUBLIC_GITHUB_URL: { public: true, static: true }
});
