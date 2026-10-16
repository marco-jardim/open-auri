import { describe, expect, test } from 'vitest';
import { comparisonSvg, escapeXml } from '#lib/components/pages/comparar/export.ts';
import { initialTracks } from '#lib/components/pages/comparar/comparison.ts';
import { copy, reasonText } from '#lib/components/pages/comparar/copy.ts';

describe('S10 comparison export', () => {
	for (const locale of ['pt-BR', 'en-US'] as const) {
		test(`SVG contains the real pair, metrics, regions and optional delta in ${locale}`, () => {
			const [a, b] = initialTracks();
			const t = copy(locale);
			const svg = comparisonSvg(a.curve, b.curve, true, 1, true, locale, t);
			expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
			expect(svg).toContain(a.curve.name);
			expect(svg).toContain(b.curve.name);
			expect(svg).toContain('RMS');
			expect(svg).toContain(t.max);
			expect(svg).toContain(t.peak);
			expect(svg).toContain('Δ = B − A');
			expect(svg.match(/<path /g)).toHaveLength(3);
			const noDelta = comparisonSvg(a.curve, b.curve, false, 1, false, locale, t);
			expect(noDelta.match(/<path /g)).toHaveLength(2);
			expect(svg).not.toMatch(/NaN|Infinity|undefined/);
		});

		test(`gate refusal reasons are readable in ${locale}`, () => {
			const t = copy(locale);
			for (const code of [
				'a:b0',
				'b:pole-radius',
				'c:section-peak',
				'd:prefix-peak',
				'e:output-full',
				'f:codec',
				'g:preamp',
				'k:kind-not-allowed',
				'd7:boost-q'
			]) {
				expect(reasonText(code, t)).not.toBe(t.gateReason);
				expect(reasonText(code, t).length).toBeGreaterThan(15);
			}
		});
	}

	test('untrusted curve names cannot inject SVG, elements or attributes', () => {
		const [a, b] = initialTracks();
		const malicious = '<script>alert("x")</script>&';
		const svg = comparisonSvg(
			{ ...a.curve, name: malicious },
			b.curve,
			true,
			1,
			true,
			'en-US',
			copy('en-US')
		);
		expect(svg).not.toContain('<script>');
		expect(svg).toContain('&lt;script&gt;');
		expect(escapeXml('"\'<> &')).toBe('&quot;&apos;&lt;&gt; &amp;');
	});
});
