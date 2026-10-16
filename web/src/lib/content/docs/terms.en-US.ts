import { legalNotice } from './legal-notice.ts';
import type { LegalDocument } from './legal.ts';

// TODO(Q-LEGAL): legal review of the terms before publication.
export const termsEnUS: LegalDocument = {
	locale: 'en-US',
	title: 'open-auri Terms of Use',
	blocks: [
		{
			kind: 'paragraph',
			text: 'Version 1.0 · Effective date: {{PUBLIC_POLICY_EFFECTIVE_DATE}} · {{PUBLIC_ORIGIN}}/termos'
		},
		{ kind: 'heading', text: '1. Independent project and interoperability' },
		...legalNotice['en-US'].map((text) => ({ kind: 'paragraph' as const, text })),
		{ kind: 'heading', text: '2. Responsible use and writing' },
		{
			kind: 'paragraph',
			text: 'The editor and local previews require no account. No byte should be sent without gate v2 approval of actual Q27/Q23 values, a complete checklist and an explicit user gesture. The gate is a similarity policy relative to what the 11 official presets already make the chip compute, not a proof of hardware safety. Lower the volume, keep power stable and do not disconnect during a write. Every known write persists to flash, whose endurance is unknown.'
		},
		{ kind: 'heading', text: '3. Licenses and third-party rights' },
		{
			kind: 'paragraph',
			text: 'The software is distributed under AGPL-3.0. Third-party components retain their licenses and attribution; AutoEq uses MIT. Official Kuba presets and descriptions have a license to be confirmed. Respect third-party rights when importing or sharing content. These terms do not replace or restrict permissions under applicable licenses.'
		},
		{ kind: 'heading', text: '4. Data and contact' },
		{
			kind: 'paragraph',
			text: 'Loaded audio is never uploaded. The policy at {{PUBLIC_ORIGIN}}/privacidade describes local storage, essential cookies, any account features and access records. Controller: {{PUBLIC_LGPD_CONTROLLER}}. CNPJ: {{PUBLIC_LGPD_CNPJ}}. Address: {{PUBLIC_LGPD_ADDRESS}}. Privacy contact: {{PUBLIC_LGPD_CONTACT_EMAIL}}. Data protection officer, if any: {{PUBLIC_LGPD_DPO_NAME}}.'
		},
		{ kind: 'heading', text: '5. Governing law and changes' },
		{
			kind: 'paragraph',
			text: 'Brazilian law applies, preserving mandatory user rights. Material changes will have a new version and effective date. The full legal notice is at /docs#aviso-legal. Accounts and social features will have specific rules in the phase when they become available. The Brazilian Portuguese version of these terms prevails in case of differences.'
		}
	]
};
