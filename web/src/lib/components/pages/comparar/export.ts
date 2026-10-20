import { numberLabel, frequencyLabel } from '#lib/charts/scales.ts';
import { saveFile } from '#lib/files/save.ts';
import { compareCurves, type NamedCurve } from './comparison.ts';
import { PLOT_FREQUENCIES, plotPath, plotRange, plotTicks, plotX, plotY } from './plot.ts';
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
	const signed = (value: number, digits: number) =>
		`${value > 0 ? '+' : ''}${numberLabel(value, locale, digits)}`;
	const summary = `RMS ${numberLabel(comparison.rmsDb, locale, 2)} dB · ${t.max} ${numberLabel(comparison.maxDb, locale, 2)} dB @ ${frequencyLabel(comparison.maxFreqHz, locale)} Hz`;
	const regions = comparison.regions.map(
		(region, index) =>
			`${index + 1}. ${frequencyLabel(region.fromHz, locale)}–${frequencyLabel(region.toHz, locale)} Hz · ${t.peak} ${numberLabel(region.peakDiffDb, locale, 2)} dB`
	);
	// Level matching only lowers: each side shows the real trim used by the graph and the A/B.
	const trims = matched
		? t.exportTrims({
				a: numberLabel(Math.min(0, comparison.trims[0]), locale, 1),
				b: numberLabel(Math.min(0, comparison.trims[1]), locale, 1)
			})
		: t.exportLevelOff;
	const stats = [
		{ label: 'RMS', value: `${numberLabel(comparison.rmsDb, locale, 2)} dB`, sub: '20 Hz–20 kHz' },
		{
			label: t.max,
			value: `${numberLabel(comparison.maxDb, locale, 2)} dB`,
			sub: `${frequencyLabel(comparison.maxFreqHz, locale)} Hz`
		},
		{
			label: t.regions,
			value: String(comparison.regions.length),
			sub: `> ${numberLabel(thresholdDb, locale, 1)} dB`
		}
	];
	const ticks = plotTicks(range);
	const y = (value: number) => plotY(value, range);
	const bands = comparison.regions
		.map((region, index) => {
			const x = plotX(region.fromHz);
			const width = Math.max(2, plotX(region.toHz) - x);
			return `<rect x="${x}" y="20" width="${width}" height="230" fill="#d99a2b" fill-opacity=".16" stroke="#b9801f" stroke-opacity=".5"/><text x="${x + width / 2}" y="36" font-size="12" text-anchor="middle" fill="#7a5410">${index + 1}</text>`;
		})
		.join('');
	const listTop = 520;
	const height = listTop + Math.max(1, regions.length) * 22 + 30;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}" role="img" aria-labelledby="title desc">
	<title id="title">${escapeXml(t.exportPreview)}</title><desc id="desc">${escapeXml(`${a.name}; ${b.name}; ${summary}; ${trims}; ${regions.join('; ')}`)}</desc>
	<rect width="100%" height="100%" fill="#efe6cf"/>
	<g font-family="sans-serif" fill="#29251f"><text x="36" y="42" font-size="25">open-auri · ${escapeXml(t.title)}</text>
	${lines.map((line, index) => `<text x="36" y="${74 + index * 23}" fill="${line.color}" font-size="16">${escapeXml(line.name)}</text>`).join('')}
	<text x="36" y="${80 + lines.length * 23}" font-size="13" fill="#5a5044">${escapeXml(trims)}</text>
	${stats.map((stat, index) => `<g transform="translate(${600 + index * 128} 26)"><rect width="118" height="78" rx="6" fill="#29251f"/><text x="10" y="20" font-size="12" fill="#cfc6b2">${escapeXml(stat.label)}</text><text x="10" y="48" font-size="21" fill="#f2b33d">${escapeXml(stat.value)}</text><text x="10" y="67" font-size="11" fill="#cfc6b2">${escapeXml(stat.sub)}</text></g>`).join('')}
	<g transform="translate(0 175)"><rect x="58" y="20" width="900" height="230" fill="#f6efdd" stroke="#b7a88c"/>${bands}
	${ticks.map((value) => `<line x1="58" x2="958" y1="${y(value)}" y2="${y(value)}" stroke="#b7a88c" stroke-opacity="${value === 0 ? 1 : 0.55}"/><text x="48" y="${y(value) + 4}" font-size="12" text-anchor="end">${signed(value, 0)}</text>`).join('')}
	${PLOT_FREQUENCIES.map((hz) => `<line x1="${plotX(hz)}" x2="${plotX(hz)}" y1="20" y2="250" stroke="#b7a88c" stroke-opacity=".45"/><text x="${plotX(hz)}" y="270" font-size="12" text-anchor="middle">${frequencyLabel(hz, locale)}</text>`).join('')}
	${lines.map((line) => `<path d="${plotPath(line.values, range)}" fill="none" stroke="${line.color}" stroke-width="2"/>`).join('')}</g>
	<text x="36" y="${listTop - 24}" font-size="15">${escapeXml(summary)}</text>
	<text x="36" y="${listTop}" font-size="13" fill="#5a5044">${escapeXml(t.exportBands)}</text>
	${(regions.length ? regions : [t.noRegions]).map((region, index) => `<text x="36" y="${listTop + 22 + index * 22}" font-size="14">${escapeXml(region)}</text>`).join('')}
	</g></svg>`;
}

async function download(blob: Blob, filename: string): Promise<void> {
	await saveFile({ name: filename, mime: blob.type, bytes: blob, revokeDelayMs: 1000 });
}

/** Tests can capture the finished file without clicking a link in the shared browser runner. */
export async function downloadComparison(
	svg: string,
	format: 'svg' | 'png',
	save: (blob: Blob, filename: string) => void | Promise<void> = download
): Promise<void> {
	const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
	if (format === 'svg') {
		await save(blob, 'open-auri-comparar.svg');
		return;
	}
	const { comparisonPng } = await import('./png.ts');
	await save(await comparisonPng(blob), 'open-auri-comparar.png');
}
