// Legal content entry point (T3.4). Templates only: operator values come from PUBLIC_* at
// prerender through ./render.ts, which only the routes' +page.server.ts import.
export { POLICY_SEEN_KEY, POLICY_VERSION, isPolicyVersion } from './version.ts';
export { termsPtBR } from './terms.pt-BR.ts';
export { termsEnUS } from './terms.en-US.ts';
export { privacyPtBR } from '../docs/privacy.pt-BR.ts';
export { privacyEnUS } from '../docs/privacy.en-US.ts';
export { legalContent } from '../docs/legal-content.ts';
export type { LegalBlock, LegalDocument, LegalKey, PublicLegalValues } from '../docs/legal.ts';
