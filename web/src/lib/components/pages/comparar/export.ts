import { numberLabel, frequencyLabel } from '#lib/charts/scales.ts';
import { compareCurves, type NamedCurve } from './comparison.ts';
import { plotPath, plotRange, plotX } from './plot.ts';
import type { Copy } from './copy.ts';

const XML_ENTITIES: Record<string, string> = {
	'<': '&lt;',
	'>': '&gt;',
	'&': '&amp;',
	'"': '&quot;',
	"'": '&apos;'
};

export function escapeXml(value: string): string {
	return value.replace(/[<>&"']/g, (character) => XML_ENTITIES[character] ?? character);
}

export function comparisonSvg(
	a: NamedCurve,
	b: NamedCurve,
	matched: boolean,
	thresholdDb: number,
	includeDelta: boolean,
	locale: 'pt-BR' | 'en-US',
	t: Copy
): string {
	const comparison = compareCurves(a, b, matched, thresholdDb);
	const lines = [
		{ name: `A · ${a.name}`, values: comparison.left, color: '#8b382c' },
		{ name: `B · ${b.name}`, values: comparison.right, color: '#245b60' },
		...(includeDelta ? [{ name: 'Δ = B − A', values: comparison.delta, color: '#73511c' }] : [])
	];
	const range = plotRange(lines);
	const summary = `RMS ${numberLabel(comparison.rmsDb, locale, 2)} dB · ${t.max} ${numberLabel(comparison.maxDb, locale, 2)} dB @ ${frequencyLabel(comparison.maxFreqHz, locale)} Hz`;
	const regions = comparison.regions.map(
		(region) =>
			`${frequencyLabel(region.fromHz, locale)}–${frequencyLabel(region.toHz, locale)} Hz · ${t.peak} ${numberLabel(region.peakDiffDb, locale, 2)} dB`
	);
	const height = 470 + Math.max(1, regions.length) * 24;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}" role="img" aria-labelledby="title desc">
	<title id="title">${escapeXml(t.exportPreview)}</title><desc id="desc">${escapeXml(`${a.name}; ${b.name}; ${summary}; ${regions.join('; ')}`)}</desc>
	<rect width="100%" height="100%" fill="#efe6cf"/>
	<g font-family="sans-serif" fill="#29251f"><text x="36" y="42" font-size="25">open-auri · ${escapeXml(t.title)}</text>
	${lines.map((line, index) => `<text x="36" y="${76 + index * 25}" fill="${line.color}" font-size="17">${escapeXml(line.name)}</text>`).join('')}
	<g transform="translate(0 150)">${[-1, -0.5, 0, 0.5, 1].map((fraction) => `<line x1="58" x2="958" y1="${135 - fraction * 115}" y2="${135 - fraction * 115}" stroke="#b7a88c"/><text x="48" y="${140 - fraction * 115}" font-size="13" text-anchor="end">${numberLabel(fraction * range, locale)}</text>`).join('')}
	${[20, 100, 1000, 10000, 20000].map((hz) => `<text x="${plotX(hz)}" y="277" font-size="13" text-anchor="middle">${frequencyLabel(hz, locale)} Hz</text>`).join('')}
	${lines.map((line) => `<path d="${plotPath(line.values, range)}" fill="none" stroke="${line.color}" stroke-width="2"/>`).join('')}</g>
	<text x="36" y="455" font-size="16">${escapeXml(summary)}</text>
	${(regions.length ? regions : [t.noRegions]).map((region, index) => `<text x="36" y="${483 + index * 24}" font-size="14">${escapeXml(region)}</text>`).join('')}
	</g></svg>`;
}

function download(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Tests can capture the finished file without clicking a link in the shared browser runner. */
export async function downloadComparison(
	svg: string,
	format: 'svg' | 'png',
	saveFile: (blob: Blob, filename: string) => void = download
): Promise<void> {
	const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
	if (format === 'svg') {
		saveFile(blob, 'open-auri-comparar.svg');
		return;
	}
	const url = URL.createObjectURL(blob);
	try {
		const image = new Image();
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error('Could not render comparison SVG'));
			image.src = url;
		});
		const canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth * 2;
		canvas.height = image.naturalHeight * 2;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas is unavailable');
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		const png = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((value) => {
				if (value) resolve(value);
				else reject(new Error('Could not encode PNG'));
			}, 'image/png')
		);
		saveFile(png, 'open-auri-comparar.png');
	} finally {
		URL.revokeObjectURL(url);
	}
}
