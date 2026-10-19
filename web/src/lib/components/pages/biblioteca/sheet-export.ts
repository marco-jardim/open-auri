import { encodeS1 } from 'open-auri/share';
import { responseGeometry } from '#lib/charts/response.ts';
import { saveFile } from '#lib/files/save.ts';
import { presetUrl, qrSvg } from '#lib/qr/index.ts';
import { number, tapeShareUrl, type Locale, type Tape } from './archive.ts';

export interface SheetCopy {
	title: string;
	response: string;
	preamp: string;
	track: string;
	frequency: string;
	gain: string;
	license: string;
	card: string;
}

export const SHEET_WIDTH = 1200;
export const SHEET_HEIGHT = 1150;

const XML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&apos;'
};

function xml(value: string): string {
	const printable = Array.from(value, (char) => {
		const code = char.codePointAt(0) ?? 0;
		return code === 9 ||
			code === 10 ||
			code === 13 ||
			(code >= 32 && code <= 0xd7ff) ||
			(code >= 0xe000 && code <= 0xfffd) ||
			code >= 0x10000
			? char
			: '�';
	}).join('');
	return printable.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
}

/** The complete track sheet, not a screenshot. Only core-derived chart geometry is projected. */
export function sheetSvg(tape: Tape, origin: string, locale: Locale, copy: SheetCopy): string {
	const code = encodeS1(tape);
	// The card's QR opens the tape where the editor admits it (`tapeShareUrl`).
	const url = tapeShareUrl(presetUrl(origin, code), tape);
	const chart = responseGeometry(tape, { left: 85, top: 195, width: 1030, height: 260 });
	const text = (x: number, y: number, value: string, size = 18) =>
		`<text x="${x}" y="${y}" font-size="${size}">${xml(value)}</text>`;
	const grid = [-24, -18, -12, -6, 0, 6, 12]
		.map(
			(db) =>
				`<path d="M85 ${chart.y(db)}H1115" stroke="#b7aa8b"/>` +
				text(32, chart.y(db) + 6, number(db, locale, 0), 14)
		)
		.join('');
	const frequencies = [20, 100, 1000, 10000, 20000]
		.map(
			(hz) =>
				`<path d="M${chart.x(hz)} 195V455" stroke="#b7aa8b"/>` +
				text(chart.x(hz) - 12, 480, `${hz >= 1000 ? hz / 1000 + 'k' : hz} Hz`, 14)
		)
		.join('');
	const rows = tape.bands
		.map((band, index) => {
			const y = 565 + index * 28;
			return (
				text(55, y, String(index + 1).padStart(2, '0')) +
				text(190, y, band.kind) +
				(band.kind === 'OFF'
					? ''
					: text(335, y, number(band.freqHz, locale, 0)) +
						text(
							600,
							y,
							band.kind === 'HP' || band.kind === 'LP' ? '∅' : number(band.gainDb, locale)
						) +
						text(850, y, number(band.qFactor, locale, 2)))
			);
		})
		.join('');
	const qr = qrSvg(url).replace('<svg ', '<svg x="935" y="880" width="210" height="210" ');
	const codeLines = code.match(/.{1,86}/g) ?? [];
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_WIDTH}" height="${SHEET_HEIGHT}" viewBox="0 0 ${SHEET_WIDTH} ${SHEET_HEIGHT}" role="img" aria-labelledby="title desc">
<title id="title">${xml(copy.title)}: ${xml(tape.name)}</title>
<desc id="desc">${xml(copy.response)}</desc>
<rect width="1200" height="1150" fill="#e4d8b8"/>
<g fill="#302c23" font-family="Courier New, monospace">
${text(55, 55, `open-auri / ${copy.title}`, 20)}
${text(55, 110, Array.from(tape.name).slice(0, 48).join(''), 36)}
${text(55, 150, `${copy.preamp}: ${number(tape.preampDb, locale)} dB / 96 kHz`)}
${grid}${frequencies}
<path d="${chart.eqPath}" stroke="#6c6c5c" stroke-dasharray="5 4" fill="none"/>
<path d="${chart.outputPath}" stroke="#684b11" stroke-width="3" fill="none"/>
${text(55, 530, copy.track)}${text(190, 530, 'TYPE')}${text(335, 530, copy.frequency)}${text(600, 530, copy.gain)}${text(850, 530, 'Q')}
${rows}<path d="M55 845H1145" stroke="#302c23"/>
${text(55, 875, copy.card)}
${text(55, 910, copy.license, 15)}
${text(55, 940, 'S1 / #p=', 16)}
${codeLines.map((line, index) => text(55, 968 + index * 19, line, 14)).join('')}
${text(55, 1115, `${new URL(origin).origin} / open-auri`, 14)}
</g>${qr}</svg>`;
}

export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
	await saveFile({ name: filename, mime: blob.type, bytes: blob, revokeDelayMs: 1000 });
}

/** Canvas rasterization of that exact SVG, with cleanup on every success/failure path. */
export async function sheetPng(svg: string): Promise<Blob> {
	const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		const canvas = document.createElement('canvas');
		canvas.width = SHEET_WIDTH * 2;
		canvas.height = SHEET_HEIGHT * 2;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas 2D unavailable');
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		return await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(
				(blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))),
				'image/png'
			);
		});
	} finally {
		URL.revokeObjectURL(url);
	}
}
