import { expect, test } from 'vitest';
import { encodeS1 } from 'open-auri/share';
import { archiveTapes } from '#lib/components/pages/biblioteca/archive.ts';
import {
	sheetSvg,
	SHEET_HEIGHT,
	SHEET_WIDTH,
	type SheetCopy
} from '#lib/components/pages/biblioteca/sheet-export.ts';

const copy: SheetCopy = {
	title: 'Folha de pistas',
	response: 'Resposta elétrica',
	preamp: 'Preamp',
	track: 'Pista',
	frequency: 'Frequência / Hz',
	gain: 'Ganho / dB',
	license: 'licença: a confirmar',
	card: 'Cartão da curva'
};

test('S10 renders the entire sheet as deterministic SVG with ten tracks, core curve paths, S1 and a real QR', () => {
	const tape = archiveTapes([])[0];
	const svg = sheetSvg(tape, 'https://example.test', 'pt-BR', copy);
	expect(svg).toBe(sheetSvg(tape, 'https://example.test', 'pt-BR', copy));
	expect(svg).toContain(`viewBox="0 0 ${SHEET_WIDTH} ${SHEET_HEIGHT}"`);
	expect(svg).toContain('Folha de pistas');
	expect(svg).toContain('Auri');
	expect(svg).toContain(encodeS1(tape));
	expect(svg).toContain('−2,8');
	expect(svg).toContain('licença: a confirmar');
	expect(svg).toContain('>10</text>');
	expect(svg).toContain('stroke-dasharray="5 4"');
	expect(svg.match(/<svg /g)).toHaveLength(2);
	expect(svg).not.toContain('<script');
	expect(svg).not.toContain('undefined');
});

test('S10 escapes untrusted names, uses locale numbers and retains full names in accessible text', () => {
	const tape = { ...archiveTapes([])[0], name: '<script>alert("x")</script> & fita' };
	const svg = sheetSvg(tape, 'https://example.test', 'en-US', { ...copy, title: 'Track sheet' });
	expect(svg).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; fita');
	expect(svg).not.toContain('<script>');
	expect(svg).toContain('−2.8');
	expect(svg).toContain('<title id="title">Track sheet:');
});
