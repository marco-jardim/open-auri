import { legalNotice } from './legal-notice.ts';
import type { DocsContent } from './types.ts';

// BEGIN Android validation state ------------------------------------------------------------
// The only place in this file that says whether writing from the Android app was validated on
// a real cable (section `android-validacao`). While ANDROID_WRITE_VALIDATED is false
// (src/lib/cable/android-status.ts), the first two entries are the exact Anexo G.1 title and
// text of docs/plans/2026-10-18-android-capacitor-plano.md. At F5, replace this whole block
// with the Anexo G.6 text (date, number of devices and report). pt-BR.ts has the twin block.
const androidValidationState: readonly string[] = [
	'Writing from the app: tested on one phone',
	'The Android app was tested on a real Kuba Auri cable with one Samsung Galaxy A70 (Android 11). Preview without saving, persistent writing and restoring Padrão Auri were confirmed acoustically, and packets logged at the native bridge input match the desktop site byte for byte. Phones from other manufacturers have not been tested; full write validation is still pending. If the sound seems off after writing, write Neutral. If that does not fix it, write Neutral from the site on a computer (Chrome or Edge).',
	'What the tests guarantee: for each curve, the app builds the same nine data reports and the same commit, byte for byte, that the desktop site and the official page send. Automated tests compare those bytes with the reference for the 11 official presets, and before the commit the app also checks every sequence with an extra guard.',
	'What is still pending: a second manufacturer, on-wire parity and a signed report to close F5. We have tested 1 of 2 manufacturers (Samsung). Bytes were checked at the native bridge input through logcat, not in an on-wire USB capture. The wireLog was empty because navigating to Diagnostics reopened the session. Every write from the app still asks for one more checklist item.'
];
// END Android validation state --------------------------------------------------------------

const androidReportHref =
	'https://github.com/marco-jardim/open-auri/issues/new?template=android-cable-report.yml';
const androidReleasesHref = 'https://github.com/marco-jardim/open-auri/releases/latest';

export const enUS: DocsContent = {
	locale: 'en-US',
	title: 'Protocol 0xCB and its limits',
	titleLead: 'Protocol 0xCB',
	titleEmphasis: 'and its limits',
	subtitle: 'open-auri documentation',
	reprint: 'A reprint in tribute to Harry Nyquist',
	introduction:
		'An independent study of bytes, sampling and stability. Revised October 15, 2026. Format studied; hardware not yet validated.',
	polarCaption:
		'Fig. 1. Preset response H(eʲω), with Q23 preamp and Q27 sections. Solid: 0–48 kHz; dotted: negative frequencies. The point (−1, 0) is a historical reference: this is not a feedback loop or an application of the Nyquist stability criterion.',
	telegraphNote:
		'In 1928, Nyquist described how a channel of bandwidth B carries up to 2B independent elements per second. The tape above contains the 220 real bytes of the Auri default, calculated by the codec without transmitting to the cable.',
	stabilityNote:
		'In 1932 he published “Regeneration Theory”. Here we check digital filter poles after coefficient quantization: |p| < 1. We do not confuse this test with the stability criterion for a feedback loop.',
	safetyCaveat:
		'Gate v2 is a similarity policy relative to what the 11 official presets already make the chip compute, not a proof of hardware safety.',
	flashNotice:
		'The cable memory has an unknown write endurance; memories of this kind typically withstand 10 thousand to 1 million writes.',
	thresholdLabels: [
		'Q27 pole radius',
		'Section peak, DC–48 kHz',
		'Every prefix with preamp, 20 Hz–20 kHz',
		'Output, 20 Hz–20 kHz',
		'Output, DC–48 kHz',
		'Nominal preamp',
		'Numerical tolerance in dB',
		'Numerical tolerance on radius'
	],
	sections: [
		{
			id: 'comeco',
			title: 'Quick start',
			paragraphs: [
				'Use Chrome or Edge desktop over HTTPS to write. The editor, local library and previews also work without a cable. Connect the Auri DSP cable and authorize WebHID with a click; VID 0x3302, PID 0x8902, product “USB DSP Audio”, CB5100 bridge.',
				'Choose one of the 11 official presets or edit a curve. Review preamp and gate v2. Lower the volume, check the selected cable, stable power and checklist, then press Write to cable. Dragging, choosing a preset or opening this documentation never writes.',
				'Neutral is 10 × OFF, exact identity, with −0.5 dB preamp and CRC 0x4FFF (FF 4F on the wire). Auri default is the official padrao preset, not a proven factory reset. A local copy is not a cable read-back and offers no guaranteed undo.'
			],
			links: [
				{ label: 'Open Curve', href: '/' },
				{ label: 'Connection and checklist', href: '/cabo' }
			]
		},
		{
			id: 'camadas',
			title: 'The three layers',
			paragraphs: [
				'The same curve with different amounts of information. Each layer includes the previous one. Changing the view does not change the payload or grant write permission.'
			],
			items: [
				'Listen: presets, response, tone macros and preamp for selecting and comparing.',
				'Adjust: frequency, gain and Q for PK, LS and OFF. Dragging and the solver keep the last approved curve; the gate rechecks after snapping.',
				'Engineering: Q27 coefficients, the Q23 word, bytes and rejection reasons. HS, LP and HP are experimental, requiring gate v2 and extra confirmation. Raw biquads are not released yet.'
			],
			links: [
				{ label: 'Listen', href: '/?camada=ouvir' },
				{ label: 'Adjust', href: '/?camada=ajustar' },
				{ label: 'Engineering', href: '/?camada=engenharia' }
			]
		},
		{
			id: 'envelope',
			title: 'What is safe',
			paragraphs: [
				'Gate v2, the “observed envelope”, evaluates the actual Q27/Q23 values sent on the wire. Passing the gate does not mean Kuba has written that curve. Marginal maxima do not bound all internal states, transients, limit cycles or unknown arithmetic.',
				'The sequence is: integer coefficients with no slack; quantized poles; isolated section peaks; every prefix in actual wire order with preamp; audible and full-band output; encodePayload succeeding; nominal preamp. Attenuation cannot fix rejected coefficients, poles or section peaks.',
				'Cuts before boosts is an initial order, not a certificate. Ten individually approved sections may fail together. Prefixes are only bounded over 20 Hz–20 kHz; subsonic or ultrasonic prefixes may escape. The gate remains mandatory after snapping and before every write or publication.',
				'Absolute controls: 20 Hz–20 kHz, gain −24 to +9.2 dB, Q from 0.1 to 20. PK boosts have Q ≤ 4 and are not allowed above 16 kHz. HS, LP and HP are Engineering-only with extra experimental confirmation. Soft ranges are not write permission.'
			]
		},
		{
			id: 'protocolo',
			title: 'Protocol 0xCB',
			paragraphs: [
				'A curve becomes 220 B: a 14 B header, a 4 B int32 little-endian Q23 preamp, ten 20 B biquads and a 2 B CRC. Each section contains five int32 Q27 values in wire order [b0, b2, −a1, b1, −a2], with implicit a0 = 1. There is no filter-type byte.',
				'Confirmed header: 45 51 31 23 D6 00 00 0A 04 05 01 0A 00 00. “EQ1#” is ASCII; D6 00 is the length 14 + 20 × 10 = 214 and both 0A bytes are the section count, as the official WalkPlay app computes them. Bytes 6 and 12–13 remain unknown.',
				'WebHID uses report ID 0xCB and 31 B of data (the ID is separate). Reports 0 to 6 carry an index + 30 B; report 7 carries 10 B and zero padding; report 8 carries only the index and zeros. Wait 16 ms after each report, then 150 ms and commit 01 65 00 01 FF padded to 31 B: nominally 294 ms plus overhead. Equivalence of commit padding in firmware still needs testing.',
				'Q23 stores linear gain: round(10^(dB/20) × 2²³). Q27 uses round(coef × 2²⁷). CRC16-CCITT-FALSE covers the first 218 B: poly 0x1021, init 0xFFFF, no reflection or final XOR, appended little-endian. Integrity is not authenticity or safety.',
				'The sampling illustration uses 96 kHz, folding at 48 kHz. For 48 < f < 96 kHz, f_alias = 96 − f. This does not measure the real clock or analog input. The widgets are local codec examples, never write authorization.'
			]
		},
		{
			id: 'protocolo-cabo',
			title: 'Cable protocol',
			paragraphs: [
				'The official WalkPlay PEQ app contains a device class (group CB, log CB1100AU) that speaks exactly this protocol and confirms the format of the previous section: report 0xCB, 9 packets of index + 30 B, Q27 coefficients, Q23 preamp, EQ1# magic and CRC-16/CCITT-FALSE (init 0xFFFF, poly 0x1021) over the preceding bytes, appended little-endian. The app’s main path, however, creates the generic CB class over report 0x4B, which the Auri does not expose; the CB1100AU class sits outside that path. It declares 48 kHz but designs filters with π·f/48000, the same angle as 2π·f/96000: the effective design is 96 kHz, as on the kuba page and in open-auri.',
				'Frame: 45 51 31 23, u16 LE length = 14 + 20 × n, then 00 n 04 05 01 n 00 00, the preamp and n sections [b0, b2, −a1, b1, −a2]. The official app sends only the n active filters; the Kuba page and open-auri always send 10, with disabled bands as identity. Frames with fewer than 10 sections have not been tested on this cable.',
				'A final command follows the data: 01 tag 00 01 FF saves to flash; 01 tag 00 00 FF applies without saving. With tag 0x65, saving is exactly the Kuba page commit (01 65 00 01 FF). Data reports alone already apply live (measured on the cable); the effect of the official apply-without-saving command has not been measured yet.',
				'The protocol has a single read: the EQ tag. The request 80 00 00 00 FF, on report 0xCB, gets the answer 80 tag. On a real Auri the answer was 80 65 00 00 FF, that is, tag 0x65 (101).',
				'We have no validated read-back of the firmware version or stored curve on this cable. The official app marks those functions as unsupported; this does not prove their absence from firmware. It also marks DAC modes and balance, microphone offsets and reset as unsupported. The last known curve is the one recorded on this device, not a reading from the cable.',
				'The TTGK brief TT39510B01 describes the CB5100 USB audio bridge, with DSP and EQ integrated with the Walk Play app, but contains no HID protocol. Whether the Auri uses exactly that chip or a CB1100AU variant is not confirmed.',
				'Outer decryption of three WalkPlay downloads, for PIDs 43CC, 43CD and C20F, was validated locally: AES-128-ECB, no IV, with PKCS7 and the textual key UTF-8(MD5(code).hex.slice(0,16)), using the UI field value.code. These are 16 digest characters as text, not hex-decoded bytes. This is separate from Base64 + XOR for JSON responses, whose literal ASCII key is d2Fsa3BsYXlAMjAyNS4uLw==; AES must not be applied twice.',
				'All three results have an SPV@ container, a 32 B header and four 16 B CPU/MOD/PBK/EXT entries. Validation covers padding, the table and nonempty entry bounds; empty entries are metadata only and may point beyond the end of the file. Neither checksum nor authenticity was validated. The internal EncryptAddr/EncryptSize region is still under study: this is not complete code decryption or full protocol reconstruction, CPU identification or proof of Auri compatibility. The technical guide below provides sources, hashes and a local Node script that never overwrites files; it neither executes firmware nor sends data to the cable.'
			],
			links: [
				{ label: 'Official WalkPlay PEQ app', href: 'https://peq.szwalkplay.com/' },
				{
					label: 'Offline mirror of the app (Ircama/walkplay)',
					href: 'https://github.com/Ircama/walkplay'
				},
				{
					label: 'Chip brief TT39510B01 (PDF)',
					href: 'https://szttgk.com/uploads/files/20240725/51fad44bb79a05a35046af38b0017de5.pdf'
				},
				{
					label: 'CB5100PRO at TTGK',
					href: 'https://szttgk.com/en/product/HIFIhighfidelityaudiomodule/815.html'
				},
				{
					label: 'docs/protocol-0xcb.md on GitHub',
					href: 'https://github.com/marco-jardim/open-auri/blob/main/docs/protocol-0xcb.md'
				},
				{
					label: 'Outer firmware decryption guide (local Node)',
					href: 'https://github.com/marco-jardim/open-auri/blob/main/docs/firmware-analysis.md'
				}
			]
		},
		{
			id: 'limites',
			title: 'Physical limits',
			paragraphs: [
				'The known format offers 10 sections, one curve for both channels and a 96 kHz design rate (0 < f < 48 kHz). It does not offer independent L/R EQ, crossfeed, compression, reverb, cable volume or a DAC filter selector.',
				'The only validated cable read is its EQ tag: we have no validated read-back of the curve or firmware version, no verify, pull or rollback. The journal, snapshot and localStorage record the host transmission, not the current cable state. Fixed clock and internal DSP realization have not been measured.'
			]
		},
		{
			id: 'memoria',
			title: 'Memory and endurance',
			paragraphs: [
				'Every known commit persists to flash. There are no automatic writes. Policy allows at most one write every 2 s, with session, day and total counters and an informational warning from 50 writes per day, not a hard daily budget.',
				'Memory type and erase strategy are unknown. Typical datasheet orders of magnitude are not cable specifications; we do not calculate “years remaining”.',
				'The new curve may sound louder. Lower the volume before writing. The loudness warning appears for a predicted increase ≥ +3 dB or an unknown current curve; the estimate is not LUFS or a medical threshold. Do not disconnect during a write.'
			]
		},
		{
			id: 'previa',
			title: 'Preview with your MP3',
			paragraphs: [
				'Use ♪ Audio in the top bar to load an MP3 or other supported audio. The file stays on this device, in the open-auri IndexedDB audio store; it is never uploaded. Remove it in the loader or erase local data to delete it.',
				'Preview uses streaming playback. Where possible it runs at 96 kHz, with exact Q27 IIR sections and Q23 preamp; at another rate coefficients are recalculated and the preview is labeled approximate. Without a file it uses local pink noise. Comparisons and browser blind tests match levels to the quietest candidate.',
				'Preview volume affects only the browser. Internal chip arithmetic is unknown. Listening through the cable adds its persisted curve. To hear only the curve, use Hear on the cable (Curve), Compare on the cable (Compare, Sound like X, Community and Library) or the On the cable tab (Blind test): the curve goes to the cable memory without saving, the browser plays without EQ and, once unplugged, the cable goes back to its saved curve. Or use another output, or explicitly write Neutral first. Browser blind tests never write to the cable.'
			],
			links: [
				{ label: 'Compare curves', href: '/comparar' },
				{ label: 'Browser blind test', href: '/teste-cego' }
			]
		},
		{
			id: 'dados-locais',
			title: 'Data in this browser',
			paragraphs: [
				'Curves, the journal, settings and MP3 stay on the device. Erase local data removes only oa.* localStorage and sessionStorage keys and the open-auri IndexedDB database (audio, library, outbox), after confirmation. It sends nothing, does not delete an account and does not affect the cable: its written preset stays there.',
				'localStorage: oa.lang (language), oa.current (editor), oa.journal (last 500 entries), oa.flash.day, oa.flash.total and oa.flash.lastWriteAt (counters and interval), oa.meter.ref (reference), oa.curve.written (last curve written to the cable), oa.cable.inflight (write in progress, removed when it ends). sessionStorage: oa.flash.session. IndexedDB: library, offline outbox and audio. The essential oa_lang cookie and offline cache are not removed by this action.',
				'Export anything you want to keep first. Close other tabs if the database is blocked. Accounts and social features are optional; see the privacy policy for server requests and access records. MP3 is never uploaded.'
			],
			links: [{ label: 'Privacy policy', href: '/privacidade' }]
		},
		{
			id: 'pagina-oficial',
			title: 'What the official page does',
			paragraphs: [
				'The official page offers 11 presets without frequency, gain, Q or preamp editing. It sends nine reports and one commit; it does not read the cable or offer slots. The preset persists for use on another device.',
				'Natural (pref6) plots show but writes bands: those sets differ. Here figures and bytes use what is written. Official presets preserve original order, preamp and bytes. Descriptions are by Kuba; license: to be confirmed.',
				'Auri default: filters by Leonardo (according to a comment in the official page source). The credit does not establish the factory state.'
			],
			links: [
				{ label: 'Official reference implementation', href: 'https://equalizador.kuba.audio/' }
			]
		},
		{
			id: 'perguntas',
			title: 'What we do not know',
			paragraphs: ['No software test replaces writing, listening and measuring the real cable.'],
			items: [
				'Does firmware support RAM-only application or CRC verification? Curve read-back has not been validated: the only validated cable read is its EQ tag.',
				'What do tags other than 0x65 and the flag that negates the preamp in the official app mean? Does the cable accept frames with fewer than 10 sections? Does applying without saving (01 65 00 00 FF) change anything compared to sending data only?',
				'What flash type, endurance and erase strategy are used, and what happens on power loss during commit?',
				'Are there clicks, pops, muting or transients when switching during audio?',
				'Is the clock always 96 kHz? What internal precision, realization, guard bits and limit-cycle behavior are used?',
				'What do unknown header bytes mean? Which interfaces and firmware versions exist?',
				'CB5100 appears in TTGK briefs; attribution to Savitech is a secondary-source hypothesis. Related hardware does not make 0xCB and 0x4B interchangeable.'
			]
		},
		{ id: 'glossario', title: 'Glossary', paragraphs: [] },
		{
			id: 'aviso-legal',
			title: 'Legal notice',
			paragraphs: legalNotice['en-US'],
			links: [
				{
					label: 'AGPL-3.0, sections 15 and 16',
					href: 'https://www.gnu.org/licenses/agpl-3.0.html'
				},
				{ label: 'Terms of use', href: '/termos' }
			]
		},
		{
			id: 'creditos',
			title: 'Credits',
			paragraphs: [
				'AutoEq: MIT, Copyright (c) 2018-2022 Jaakko Pasanen. PK/LS/HS design derives from autoeq/peq.py; LP/HP follow Robert Bristow-Johnson’s Audio EQ Cookbook. Measurements remain credited to their original sources, listed in each generation’s manifest.',
				'To request measurement removal, open an issue with the source, models or paths and the reason. The distribution is regenerated excluding the source, replacing old packs and invalidating caches; this does not change upstream. The complete procedure is in the AutoEq data document.',
				'The names below are editorial homages in text, not open-auri branding or endorsements.'
			],
			links: [{ label: 'Full dependency licenses', href: '/third-party-licenses.txt' }]
		},
		{
			id: 'contas',
			title: 'Accounts',
			paragraphs: [
				'An account is optional. The editor, presets, in-browser library, previews, blind test and cable writes all work without one. Publishing, favoriting, recording activity, sharing, building packs, reporting and trading curves need an account with a verified e-mail.',
				'Sign up with an e-mail and a password of at least 10 characters, checked for strength. Sign-up, sign-in, recovery and e-mail change go through Turnstile. The verification link arrives by e-mail; until then the account can only read.',
				'Your nickname is the only public name: it appears in rankings, the feed, credits, shares, your profile and curve audiences. It has 3 to 24 characters (letters, digits, dot, underscore and hyphen) and is unique after NFKC normalization and the confusable-character skeleton (UTS #39). Some names are reserved, such as admin, open-auri, kuba, auri, the honorees and system terms. You can change it every 30 days; the old nickname stays reserved for 90 days and redirects to the new one.',
				'Administrator accounts use a second factor (authenticator app or backup codes). Destructive actions, such as removing content or banning, need a recent session: at most 10 minutes since sign-in or the last second-factor check.',
				'Closing your account requires confirmation through a link sent to your e-mail. You choose what happens to your public CC content: keep it anonymized (public, active curves and packs stay as “author removed” and the nickname stays reserved for 90 days with no owner) or delete everything (every curve, version and pack; the nickname is free at once). In both modes, private, unlisted or retracted content is deleted, together with favorites, activity, shares and trades. Forks made by other people remain. Export your data as JSON first if you want to keep it.'
			],
			links: [
				{ label: 'My account', href: '/conta' },
				{ label: 'Privacy policy', href: '/privacidade' }
			]
		},
		{
			id: 'privacidade-atividade',
			title: 'Activity privacy',
			paragraphs: [
				'“Tried” is an audible preview of at least 10 s. “Installed” is a real, successful write to the cable, never a simulated one; your browser reports it after the checklist and your gesture. “Favorited” is a favorite. Events made offline wait in a queue and are accepted up to 7 days later.',
				'Public numbers count distinct people with a verified e-mail who are not banned; the author never counts on their own curve. Repeating a preview or install only bumps a private counter of yours.',
				'Activity is private by default. While it is private, you appear in a curve’s audience only as part of “N people with a private profile”. If you make it public, your nickname appears in the list of who tried, installed or favorited, and your favorites can appear on your profile.',
				'A public library is also optional and starts off: your profile shows only your nickname and aggregate counts. When on, it shows your public creations and packs. Either way, your public curves open by link, credited to your nickname.',
				'You can see and delete your own history, all of it or per curve and kind. Public counts drop at once; rankings, at the next recalculation. Opens of shared links are only an anonymous daily counter.'
			],
			links: [{ label: 'My account', href: '/conta' }]
		},
		{
			id: 'rankings',
			title: 'Rankings',
			paragraphs: [
				'Two metrics: most favorited and most installed. Three windows: 7 days, 30 days and all time. The score is the number of distinct people with a verified e-mail, not banned, who favorited or installed within the window; the curve’s author does not count.',
				'Only public, listed curves enter: active, not hidden by moderation, with the current version approved by the gate and an author who is not banned. Unlisted or private curves never enter.',
				'Tie-break: score, then the most recent activity, then the id. Rankings are recalculated every 15 minutes, with up to 1000 positions per metric and window. Visibility is checked again on every read: a curve that is hidden or retracted leaves the list at once.'
			],
			links: [{ label: 'Community', href: '/comunidade' }]
		},
		{
			id: 'moderacao',
			title: 'Moderation',
			paragraphs: [
				'Any account with a verified e-mail can report a curve, a pack or a profile, with a reason (dangerous, spam, offensive, copyright, impersonation or other) and an optional note of up to 500 characters, read only by administrators. Reports go through Turnstile; each person reports the same target once, up to 30 reports per day, and cannot report their own content.',
				'When 3 distinct accounts, verified, not banned and at least 3 days old, report the same curve or pack, it is hidden automatically until review. Automatic hiding never overrides an administrator’s decision. Profiles are not hidden automatically.',
				'Administrators review the queue and decide: hide, restore, remove, dismiss the reports or ban the author. Every decision is kept in the audit log with its reason. To appeal a decision, use the contact channel given in the privacy policy.'
			],
			links: [
				{ label: 'Privacy policy', href: '/privacidade' },
				{ label: 'Terms of use', href: '/termos' }
			]
		},
		{
			id: 's6',
			title: 'Anonymous preferences (S6)',
			paragraphs: [
				'At the end of a blind test in the browser, you can send the result of the pairs. Sending is optional, anonymous and needs no account. Since hearing preferences can reveal health conditions, it only happens with your explicit consent (LGPD, art. 11).',
				'The server keeps only a random identifier, the SHA-256 digest of your receipt, the consent version, the day and the pairs (curve A, curve B, choice and whether levels were matched), in shuffled order. No account, IP, browser or time of day. Abuse control uses Turnstile and a short-lived counter that stores nothing about you.',
				'The receipt stays only in this browser. With it, you can withdraw the submission at any time and the pairs are deleted. Without the receipt the batch cannot be found: keep it if you may want to withdraw later.',
				'Once a day, the pairs become “Community prefers” through the Bradley–Terry model: a tie counts as half a win for each side, and only curves linked to each other by comparisons in both directions get a score. The published result has only each curve’s score and number of comparisons.'
			],
			links: [
				{ label: 'Blind test in the browser', href: '/teste-cego' },
				{ label: 'Community', href: '/comunidade' }
			]
		},
		{
			id: 's7',
			title: 'Blind trade (S7)',
			paragraphs: [
				'With a verified e-mail, you put a gate-approved curve in the queue: one of yours or a public one. Each person has one active trade at a time. Pairing is asynchronous, with whoever has waited longest; if nobody is in the queue, your trade waits.',
				'Once paired, you hear your partner’s curve only through the browser preview, with no name, author or link. Installing still asks for the checklist and your gesture. Give a score from 1 to 5, only once.',
				'When both have scored, the trade is revealed: you see your partner’s nickname, their curve when it opens by link, and both scores. Unrevealed trades expire 72 h after joining the queue or after pairing; while waiting, you can cancel.'
			],
			links: [{ label: 'Community', href: '/comunidade' }]
		},
		{
			id: 'windows-volume',
			title: 'Windows volume does not change the headphones',
			paragraphs: [
				'If the Windows level changes but the Auri stays just as loud, restart the “Windows Audio” service in the Services app or restart the PC. Lower the volume before testing again. On the bench, this was a stuck audio-service state for that device, not a cable fault; rewriting the curve and reconnecting the cable did not fix it.'
			]
		},
		{
			id: 'android',
			title: 'Android app',
			paragraphs: [
				'The open-auri Android app writes curves to the Auri cable over the phone’s USB, which the phone browser cannot do: Chrome for Android has no WebHID. The app opens the open-auri.com site itself and replaces only the last stretch, down to USB, with a native transport. The editor, presets, library, account and community are the same as on the site.',
				'Requirements: Android 8 or newer, USB host (OTG) support and an up-to-date Android System WebView. With an old WebView, the app shows a screen asking you to update it. Without USB host, the site says the device does not support OTG and stays in simulated mode.'
			],
			browserOnly: {
				paragraphs: [
					'Where to download: on Google Play once the listing is approved, and on GitHub Releases, where every version ships the APK, the AAB and a SHA256SUMS.txt file. Both sources use the same signature, so you can switch from one to the other without uninstalling.'
				],
				links: [{ label: 'Download from GitHub Releases', href: androidReleasesHref }]
			},
			appOnly: {
				paragraphs: ['Update the app through Google Play.'],
				links: [
					{
						label: 'Open in Google Play',
						href: 'https://play.google.com/store/apps/details?id=com.openauri.app'
					}
				]
			}
		},
		{
			id: 'android-validacao',
			title: 'App validation state',
			paragraphs: androidValidationState,
			links: [
				{ label: 'Report result', href: androidReportHref },
				{
					label: 'Hardware test report',
					href: 'https://github.com/marco-jardim/open-auri/blob/main/docs/android/validacao-hardware.md'
				}
			]
		},
		{
			id: 'android-resgate',
			title: 'How to recover with Neutral',
			paragraphs: [
				'If the sound seems off after writing from the app, lower the volume and write Neutral from the app itself, on the cable page. Neutral is 10 × OFF, exact identity, with −0.5 dB preamp: the cable plays again with no equalization.',
				'If that does not fix it, write Neutral from the site on a computer with Chrome or Edge: connect the cable, authorize WebHID and use Neutral on the cable page. This path does not go through the app.',
				'Then report the result, whether it worked or not. The GitHub form asks for the device, Android version, app version, WebView version, install source (Play or GitHub), the USB diagnostics JSON and what happened. Every report helps validate the app on more devices.'
			],
			links: [{ label: 'Report result', href: androidReportHref }]
		},
		{
			id: 'android-usb',
			title: 'USB permission in the app',
			paragraphs: [
				'On the cable page, Connect lists the Auri cables attached to the phone (VID 0x3302, PID 0x8902) and Android asks whether open-auri may access the USB device. Without that permission, nothing is sent. With more than one cable, an app picker takes the place of the WebHID picker.',
				'What stays the same: the same gate v2, the same checklist and the same journal as the site, with the same codec and the same bytes. Nothing is written without your gesture on Write to cable, and disconnecting during a write interrupts it with no commit.',
				'What changes: only the final stretch, from the site to USB, runs through the app’s native code, with an extra guard that checks every sequence before the commit. Downloads open the Android file picker, and external links open in the system browser. The app asks only for internet access and, when you connect the cable, for USB. Before each write, the app checks the published site version with the server. If that check fails (no connection or the server is unavailable), the write goes ahead on the last confirmation of this same version, and the app shows its date; with no confirmation at all, or once the app has seen a newer version or writing turned off, the write is refused.'
			]
		},
		{
			id: 'android-diagnostico',
			title: 'USB diagnostics',
			paragraphs: [
				'USB diagnostics live in the Engineering layer and exist only in the app. They show the device, configuration and HID report descriptors, the chosen interface and endpoint, and the computed output report size.',
				'Copy puts all of this on the clipboard as JSON, ready to paste into a result report. Nothing is sent to the server: the JSON leaves the device only if you paste it somewhere.'
			],
			links: [{ label: 'Report result', href: androidReportHref }]
		},
		{
			id: 'android-iphone',
			title: 'Why there is no iPhone version',
			paragraphs: [
				'No public API lets an iPhone app send the cable the HID output report that writing needs, and Safari has no WebHID. On an iPhone, use the site to edit, compare and preview; to write, use a computer with Chrome or Edge or an Android phone with the app.'
			],
			items: [
				'CoreHID, Apple’s HID API, exists only on macOS 15 or newer.',
				'External Accessory only talks to accessories in Apple’s MFi program.',
				'USBDriverKit runs only on iPads with an M-series chip and needs an entitlement granted by Apple.'
			]
		},
		{
			id: 'android-assinatura',
			title: 'Verifying the signature',
			paragraphs: ['Google Play verifies the signature when installing and updating the app.'],
			browserOnly: {
				paragraphs: [
					'Every version of the app is signed with the same key on Google Play and on GitHub. Each release publishes the SHA-256 of the APK and the AAB, also in the SHA256SUMS.txt file, and the SHA-256 fingerprint of the signing certificate, which is the same for both sources.',
					'To check an APK downloaded from GitHub, compute the file’s SHA-256 (with sha256sum or Get-FileHash, for example) and compare it with SHA256SUMS.txt. To check the certificate, run apksigner verify --print-certs on the APK and compare the certificate’s SHA-256 with the published fingerprint. If anything does not match, do not install it.'
				],
				links: [{ label: 'Releases and SHA256SUMS.txt', href: androidReleasesHref }]
			}
		},
		{
			id: 'android-privacidade',
			title: 'App privacy',
			paragraphs: [
				'The app collects nothing beyond what the site already collects: it opens the same open-auri.com, under the same privacy policy rules, and adds no collection of its own.',
				'Curves, the journal and settings stay in the app’s storage on this device, as they would in the browser, and are left out of Android backups. USB diagnostics and the bytes sent to the cable never leave the device. In your account’s session list, sessions opened from the app show as “App Android”.'
			]
		}
	],
	glossary: [
		['biquad', 'A second-order filter, five coefficients with implicit a0 = 1.'],
		['Q', 'Quality factor, distinct from the Q23/Q27 fixed-point scale.'],
		['PK / LS / OFF', 'Peak, low shelf and exact identity [1, 0, 0, 0, 0].'],
		[
			'HS / LP / HP',
			'High shelf, low pass and high pass; experimental, Engineering only. LP/HP have no editable gain.'
		],
		['preamp', 'Global gain before bands; linear Q23 gain on the wire, not dB.'],
		['headroom / clipping', 'Margin to maximum amplitude / truncation when it is exceeded.'],
		['Q23 / Q27', 'Int32 integers with 23 / 27 fractional bits.'],
		['CRC', 'An integrity check, not a safety or authenticity check.'],
		['WebHID / report', 'A device API with explicit permission / a HID data unit.'],
		['flash', 'Nonvolatile memory with finite endurance, unknown for this cable.'],
		['observed envelope', 'A similarity policy based on 11 official payloads, not a safety proof.']
	]
};
