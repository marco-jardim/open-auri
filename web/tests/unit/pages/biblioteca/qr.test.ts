import { afterEach, expect, test, vi } from 'vitest';
import * as uqr from 'uqr';
import { encodeS1 } from 'open-auri/share';
import { PADRAO_AURI } from 'open-auri/catalog';
import { presetUrl, qrSvg } from '#lib/qr/index.ts';

// ESM namespaces are immutable. Vitest wraps exports while preserving the real encoder.
vi.mock('uqr', { spy: true });

afterEach(() => vi.clearAllMocks());

test('the real uqr encoder receives the exact PUBLIC_ORIGIN-based #p=S1 URL', () => {
	const render = vi.mocked(uqr.renderSVG);
	const code = encodeS1(PADRAO_AURI);
	const expected = `https://example.test/#p=${code}`;
	const url = presetUrl('https://example.test/', code);
	expect(url).toBe(expected);
	const svg = qrSvg(url);
	expect(render).toHaveBeenCalledTimes(1);
	expect(render).toHaveBeenCalledWith(expected, expect.objectContaining({ ecc: 'M', border: 4 }));
	expect(svg).toContain('<svg');
	expect(svg).toContain('viewBox=');
	expect(svg).not.toContain('example.test');
	const matrix = uqr.encode(url, { ecc: 'M', border: 4 });
	expect(matrix.data.length).toBeGreaterThan(21);
	const parsed = new URL(url);
	expect(parsed.search).toBe('');
	expect(parsed.hash).toBe(`#p=${code}`);
});

test('share URLs never carry credentials or executable schemes', () => {
	expect(() => presetUrl('javascript:alert(1)', 'code')).toThrow();
	expect(() => presetUrl('https://user:pass@example.test', 'code')).toThrow();
	expect(presetUrl('https://example.test/some/path?q=1#old', 'abc')).toBe(
		'https://example.test/#p=abc'
	);
});
