import { describe, expect, test } from 'vitest';
import {
	DEFAULT_LAYER,
	LAYERS,
	includesLayer,
	isLayerKeyEvent,
	isLockedBand,
	isLockedKind,
	isUltrasonicLocked,
	kindAllowed,
	kindsForLayer,
	layerFromKey,
	layerUrl,
	parseLayer
} from '#lib/components/pages/curva/layers.ts';
import { hasUltrasonic, type Band } from '#lib/components/pages/curva/model.ts';

const key = (overrides: Partial<Parameters<typeof isLayerKeyEvent>[0]> = {}) => ({
	key: '2',
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	repeat: false,
	defaultPrevented: false,
	isComposing: false,
	target: null,
	...overrides
});

describe('layer URL state', () => {
	test('parses only the three layer names and defaults to Ouvir', () => {
		expect(parseLayer('ouvir')).toBe('ouvir');
		expect(parseLayer('ajustar')).toBe('ajustar');
		expect(parseLayer('engenharia')).toBe('engenharia');
		for (const bad of [null, undefined, '', 'Engenharia', 'admin', '<script>', 'ajustar ']) {
			expect(parseLayer(bad)).toBe(DEFAULT_LAYER);
		}
	});

	test('layerUrl sets ?camada= and keeps other parameters and the #p= hash', () => {
		const base = new URL('https://example.test/?x=1#p=ABC');
		const eng = layerUrl(base, 'engenharia');
		expect(eng.searchParams.get('camada')).toBe('engenharia');
		expect(eng.searchParams.get('x')).toBe('1');
		expect(eng.hash).toBe('#p=ABC');
		const back = layerUrl(eng, 'ouvir');
		expect(back.searchParams.has('camada')).toBe(false);
		expect(back.searchParams.get('x')).toBe('1');
		expect(base.searchParams.has('camada')).toBe(false);
	});

	test('round trips every layer through the URL', () => {
		for (const layer of LAYERS) {
			const url = layerUrl(new URL('https://example.test/'), layer);
			expect(parseLayer(url.searchParams.get('camada'))).toBe(layer);
		}
	});
});

describe('keys 1/2/3', () => {
	test('map to the layers in order', () => {
		expect(layerFromKey('1')).toBe('ouvir');
		expect(layerFromKey('2')).toBe('ajustar');
		expect(layerFromKey('3')).toBe('engenharia');
		expect(layerFromKey('4')).toBeNull();
		expect(layerFromKey('a')).toBeNull();
	});

	test('ignore modifiers, repeats, composition and handled events', () => {
		expect(isLayerKeyEvent(key())).toBe(true);
		expect(isLayerKeyEvent(key({ ctrlKey: true }))).toBe(false);
		expect(isLayerKeyEvent(key({ altKey: true }))).toBe(false);
		expect(isLayerKeyEvent(key({ metaKey: true }))).toBe(false);
		expect(isLayerKeyEvent(key({ repeat: true }))).toBe(false);
		expect(isLayerKeyEvent(key({ isComposing: true }))).toBe(false);
		expect(isLayerKeyEvent(key({ defaultPrevented: true }))).toBe(false);
		expect(isLayerKeyEvent(key({ key: '9' }))).toBe(false);
	});
});

describe('layer model', () => {
	test('Ouvir ⊂ Ajustar ⊂ Engenharia', () => {
		expect(includesLayer('engenharia', 'ajustar')).toBe(true);
		expect(includesLayer('ajustar', 'ouvir')).toBe(true);
		expect(includesLayer('ouvir', 'ajustar')).toBe(false);
		expect(includesLayer('ajustar', 'engenharia')).toBe(false);
	});

	test('HS/LP/HP are locked outside Engenharia and offered only there', () => {
		for (const kind of ['HS', 'LP', 'HP']) {
			expect(isLockedKind(kind, 'ouvir')).toBe(true);
			expect(isLockedKind(kind, 'ajustar')).toBe(true);
			expect(isLockedKind(kind, 'engenharia')).toBe(false);
			expect(kindAllowed(kind, 'ajustar')).toBe(false);
			expect(kindAllowed(kind, 'engenharia')).toBe(true);
			expect(kindsForLayer('engenharia')).toContain(kind);
			expect(kindsForLayer('ajustar')).not.toContain(kind);
		}
		expect(isLockedKind('PK', 'ajustar')).toBe(false);
		expect(kindAllowed('OFF', 'ouvir')).toBe(true);
	});

	test('bands above 20 kHz are locked outside Engenharia, like HS/LP/HP', () => {
		const ultra: Band = { kind: 'PK', freqHz: 25000, gainDb: -3, qFactor: 1 };
		const audible: Band = { kind: 'PK', freqHz: 20000, gainDb: -3, qFactor: 1 };
		const hs: Band = { kind: 'HS', freqHz: 8000, gainDb: -3, qFactor: 0.7 };
		const off: Band = { kind: 'OFF' };
		for (const layer of ['ouvir', 'ajustar'] as const) {
			expect(isLockedBand(ultra, layer)).toBe(true);
			expect(isLockedBand(audible, layer)).toBe(false);
			expect(isLockedBand(hs, layer)).toBe(true);
			expect(isUltrasonicLocked([audible, ultra], layer)).toBe(true);
			expect(isUltrasonicLocked({ bands: [audible, off], preampDb: -1 }, layer)).toBe(false);
		}
		for (const band of [ultra, audible, hs]) expect(isLockedBand(band, 'engenharia')).toBe(false);
		expect(isUltrasonicLocked([ultra], 'engenharia')).toBe(false);
		expect(isLockedBand(off, 'ouvir')).toBe(false);
		// The shared rule (also used by the import layer check): any section above 20 kHz.
		expect(hasUltrasonic({ bands: [audible, ultra], preampDb: -3 })).toBe(true);
		expect(hasUltrasonic([audible, off, hs])).toBe(false);
		expect(hasUltrasonic([{ kind: 'LP', freqHz: 20001, qFactor: 0.7 }])).toBe(true);
		expect(hasUltrasonic([])).toBe(false);
	});
});
