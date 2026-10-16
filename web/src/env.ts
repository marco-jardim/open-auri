import { defineEnvVars } from '@sveltejs/kit/env';

// Kit 3 declares public variables explicitly instead of using kit.env.publicPrefix.
export const variables = defineEnvVars({
	PUBLIC_ORIGIN: { public: true, static: true },
	PUBLIC_GITHUB_URL: { public: true, static: true },
	PUBLIC_LGPD_CONTROLLER: { public: true, static: true },
	PUBLIC_LGPD_CONTACT_EMAIL: { public: true, static: true },
	PUBLIC_LGPD_CNPJ: { public: true, static: true },
	PUBLIC_LGPD_ADDRESS: { public: true, static: true },
	PUBLIC_LGPD_DPO_NAME: { public: true, static: true },
	PUBLIC_POLICY_EFFECTIVE_DATE: { public: true, static: true },
	PUBLIC_TURNSTILE_SITE_KEY: { public: true, static: true }
});
