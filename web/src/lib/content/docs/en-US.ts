import { legalNotice } from './legal-notice.ts';
import type { DocsContent } from './types.ts';

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
				'Confirmed header: 45 51 31 23 D6 00 00 0A 04 05 01 0A 00 00. “EQ1#” is ASCII; interpreting D6 00 as length is a hypothesis. Bytes 6 and 12–13 remain unknown.',
				'WebHID uses report ID 0xCB and 31 B of data (the ID is separate). Reports 0 to 6 carry an index + 30 B; report 7 carries 10 B and zero padding; report 8 carries only the index and zeros. Wait 16 ms after each report, then 150 ms and commit 01 65 00 01 FF padded to 31 B: nominally 294 ms plus overhead. Equivalence of commit padding in firmware still needs testing.',
				'Q23 stores linear gain: round(10^(dB/20) × 2²³). Q27 uses round(coef × 2²⁷). CRC16-CCITT-FALSE covers the first 218 B: poly 0x1021, init 0xFFFF, no reflection or final XOR, appended little-endian. Integrity is not authenticity or safety.',
				'The sampling illustration uses 96 kHz, folding at 48 kHz. For 48 < f < 96 kHz, f_alias = 96 − f. This does not measure the real clock or analog input. The widgets are local codec examples, never write authorization.'
			]
		},
		{
			id: 'limites',
			title: 'Physical limits',
			paragraphs: [
				'The known format offers 10 sections, one curve for both channels and a 96 kHz design rate (0 < f < 48 kHz). It does not offer independent L/R EQ, crossfeed, compression, reverb, cable volume or a DAC filter selector.',
				'The path is write-only: no confirmed read-back, verify, pull or rollback. The journal, snapshot and localStorage record the host transmission, not the current cable state. Fixed clock and internal DSP realization have not been measured.'
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
				'Preview volume affects only the browser. Internal chip arithmetic is unknown. Listening through the cable adds its persisted curve: use another output or explicitly write Neutral first. Browser blind tests never write to the cable.'
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
				'Does firmware support read-back, RAM-only application or CRC verification?',
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
			]
		},
		{
			id: 'contas',
			title: 'Accounts',
			paragraphs: [
				'Arrives in the next phase. This section will describe account flows and controls. The local editor does not require an account.'
			]
		},
		{
			id: 'social',
			title: 'Community and social',
			paragraphs: [
				'Arrives in the next phase. This section will describe publishing, activity privacy and sharing.'
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
