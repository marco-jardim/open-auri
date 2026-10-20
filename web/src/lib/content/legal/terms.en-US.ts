import { legalNotice } from '../docs/legal-notice.ts';
import type { LegalDocument } from '../docs/legal.ts';
import { POLICY_VERSION } from './version.ts';

const paragraph = (text: string) => ({ kind: 'paragraph' as const, text });
const heading = (text: string) => ({ kind: 'heading' as const, text });
const list = (items: string[]) => ({ kind: 'list' as const, items });

export const termsEnUS: LegalDocument = {
	locale: 'en-US',
	title: 'open-auri Terms of Use',
	blocks: [
		paragraph(
			`**Version:** ${POLICY_VERSION} · **Effective date:** {{PUBLIC_POLICY_EFFECTIVE_DATE}} · {{PUBLIC_ORIGIN}}/termos`
		),
		paragraph(
			'This English translation is provided for convenience. The authoritative version is the Brazilian Portuguese text. If the two versions differ, the pt-BR version prevails.'
		),
		heading('1. Independent project, interoperability and disclaimer'),
		...legalNotice['en-US'].map(paragraph),
		heading('2. Responsible use and writing'),
		paragraph(
			'The website and app are intended for people aged 18 or over, including use without an account, and are not directed to minors.'
		),
		paragraph(
			'The editor and local previews require no account. No byte should be sent without gate v2 approval on the real Q27/Q23 values, a complete checklist and an explicit gesture. The gate is a similarity policy against what the 11 official presets already make the chip compute, not proof of hardware safety. Lower the volume, keep power stable and do not disconnect during a write. Every known write persists in flash of unknown endurance.'
		),
		paragraph(
			'Community curves are other people’s content. Passing the gate does not mean a curve is safe for your hearing or your equipment. Listen to the preview at low volume before writing.'
		),
		heading('3. Account and public nickname'),
		list([
			'The account is optional; sign-up and account use require users to be 18 or over. Each person keeps one account, with a verified email for any social action.',
			'You are responsible for keeping your password safe and for the actions taken with your account. Tell us through the privacy channel if you suspect misuse.',
			'The public nickname is the only name shown. It may not impersonate another person, manufacturers, the project or the honorees, nor contain other people’s personal data. Reserved nicknames or ones confusable with others are refused.',
			'The nickname can be changed every 30 days. The old one stays reserved for 90 days and redirects to the new one.'
		]),
		heading('4. Published content and licences'),
		paragraph(
			'When you publish a curve, you choose one of two Creative Commons licences for that version: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain dedication, no credit required) or [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (free use with credit to your nickname).'
		),
		list([
			'**The licence of a published version is irrevocable.** You can withdraw the curve from the site, but copies, forks and public dumps already made remain valid under the licence terms.',
			'Versions are append-only: a new version does not erase earlier ones from the history.',
			'A fork inherits the credit obligation of its source version when that version is CC BY 4.0.',
			'In packs, each curve keeps its own licence.',
			'You declare that you have the right to publish what you publish. Do not publish as your own what belongs to others, such as official Kuba presets (licence to be confirmed) or measurement data without the attribution required by its original licence. The AutoEq data embedded in the app follows the MIT licence.',
			'The open-auri software is distributed under AGPL-3.0. Third-party components keep their own licences and attributions. These terms do not replace or restrict the permissions of the applicable licences.'
		]),
		heading('5. Conduct'),
		paragraph('When using the social features, you may not:'),
		list([
			'publish illegal, offensive, discriminatory or harassing content, or content that infringes others’ rights;',
			'use names, descriptions or packs for spam, advertising, links or other people’s personal data;',
			'manipulate rankings, counts or reports, including with multiple accounts or automation;',
			'publish curves made to cause discomfort, hearing damage or equipment damage, or circumvent the gate, rate limiting or Turnstile (YOLO mode does not circumvent the gate: it applies the gate’s own YOLO profile, with the hardware locks);',
			'probe for security flaws without first contacting the project, or overload the service.'
		]),
		paragraph(
			'**YOLO curves.** Curves made beyond the standard limits, in YOLO mode, are published only with the YOLO mark, after your explicit acknowledgement, and stay outside the main feed, the rankings and the other standard lists. Passing the open-auri checks does not mean a curve poses no risk to hearing or equipment. Whoever writes a YOLO curve to the cable takes on the risk.'
		),
		heading('6. Moderation'),
		list([
			'Verified accounts can report content. A curve is hidden automatically when 3 different verified accounts, each at least 3 days old, report it; a curve whose current version is YOLO is hidden with just 2 such accounts.',
			'Moderators review automatic hiding and may restore, hide or withdraw content, mark curation and ban accounts that breach these terms or the law. Every action is kept in the audit log.',
			'If a decision affects you, ask for a review through the privacy channel in section 8, including for automated decisions (LGPD, art. 20).',
			'We may remove content or suspend accounts to comply with a court order or legal obligation.'
		]),
		heading('7. Availability and liability'),
		paragraph(
			'The service is provided with no guarantee of continuous availability and may change, switch to read-only mode or be discontinued. To the maximum extent permitted by law, we are not liable for content published by users, nor for the use of community curves on your cable or earphones. The notices in section 1 apply to the whole service.'
		),
		heading('8. Data and contact'),
		paragraph(
			'Loaded audio is never uploaded. The policy at {{PUBLIC_ORIGIN}}/privacidade describes local storage, essential cookies, accounts, social features and access records. Controller: {{PUBLIC_LGPD_CONTROLLER}}. CNPJ: {{PUBLIC_LGPD_CNPJ}}. Address: {{PUBLIC_LGPD_ADDRESS}}. Privacy contact: {{PUBLIC_LGPD_CONTACT_EMAIL}}. Data protection officer: {{PUBLIC_LGPD_DPO_NAME}}.'
		),
		heading('9. Governing law and changes'),
		paragraph(
			'Brazilian law applies, without prejudice to mandatory user rights. Relevant changes will get a new version and effective date, with a notice in the app. The full legal notice is at /docs#aviso-legal.'
		)
	]
};
