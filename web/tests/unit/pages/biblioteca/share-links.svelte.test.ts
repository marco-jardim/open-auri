// A tape the editor admits only in Engenharia (HS/LP/HP, or a band above 20 kHz) is shared with
// `?camada=engenharia`: the sheet's QR code, its link and the exported card. Without it, Curva
// opens the link in Ouvir and refuses it (`ultrasonic-layer`, `experimental-layer`).
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import { gateForWrite } from 'open-auri/safety';
import { encodeS1 } from 'open-auri/share';
import { IDLE_STATE } from '#lib/audio/engine.ts';
import { neutralCurve, type CurveData } from '#lib/state/model.ts';
import type { LibraryItem } from '#lib/state/library.svelte.ts';
import { presetUrl, qrSvg } from '#lib/qr/index.ts';
import TrackSheet from '#lib/components/pages/biblioteca/TrackSheet.svelte';
import {
	archiveTapes,
	needsEngineering,
	tapeShareUrl,
	type Tape
} from '#lib/components/pages/biblioteca/archive.ts';
import { sheetSvg } from '#lib/components/pages/biblioteca/sheet-export.ts';
import { readLinkHash } from '#lib/components/pages/curva/io.ts';
import { LAYER_PARAM, parseLayer } from '#lib/components/pages/curva/layers.ts';
import { exitReason } from '#lib/components/pages/curva/yolo.ts';

afterEach(async () => {
	await cleanup();
	vi.restoreAllMocks();
});

const ORIGIN = 'https://example.test';
const neutral = neutralCurve();
const ultrasonicCurve: CurveData = {
	...neutral,
	name: 'Ar',
	preampDb: -0.5,
	bands: [{ kind: 'PK', freqHz: 22000, gainDb: -3, qFactor: 1 }, ...neutral.bands.slice(1)]
};
const experimentalCurve: CurveData = {
	...neutral,
	name: 'Subsônica',
	preampDb: -0.5,
	bands: [{ kind: 'HP', freqHz: 30, qFactor: 0.71 }, ...neutral.bands.slice(1)]
};
const plainCurve: CurveData = { ...neutral, name: 'Plana', preampDb: -3 };

/** The local tape of `curve`, as the shelf builds it. */
function tapeOf(curve: CurveData): Tape {
	const item: LibraryItem = {
		...curve,
		id: curve.name,
		s1: encodeS1(curve),
		favorite: false,
		createdAt: 0,
		updatedAt: 1
	};
	const tape = archiveTapes([item]).at(-1);
	if (!tape || tape.group !== 'local') throw new Error('Missing local tape');
	return tape;
}

const copy = {
	title: 'Folha',
	response: 'Resposta',
	preamp: 'Pré',
	track: 'Pista',
	frequency: 'Frequência',
	gain: 'Ganho',
	license: 'Licença',
	card: 'Cartão'
};

/** The QR code exactly as the exported card places it. */
const placedQr = (url: string) =>
	qrSvg(url).replace('<svg ', '<svg x="935" y="880" width="210" height="210" ');

test('HS/LP/HP and bands above 20 kHz are shared in Engenharia; other tapes as before', () => {
	for (const curve of [ultrasonicCurve, experimentalCurve]) {
		const code = encodeS1(curve);
		expect(needsEngineering(curve)).toBe(true);
		const shared = tapeShareUrl(presetUrl(ORIGIN, code), curve);
		expect(shared).toBe(`${ORIGIN}/?camada=engenharia#p=${code}`);
		// Curva reads the layer from the link, then admits the curve there.
		const url = new URL(shared);
		const layer = parseLayer(url.searchParams.get(LAYER_PARAM));
		expect(layer).toBe('engenharia');
		expect(readLinkHash(url.hash, layer)).toMatchObject({ ok: true });
		// The plain link opens in Ouvir, which refuses the curve: the reason for the parameter.
		expect(readLinkHash(new URL(presetUrl(ORIGIN, code)).hash, 'ouvir')).toMatchObject({
			ok: false,
			error: expect.stringMatching(/^(ultrasonic|experimental)-layer$/)
		});
	}
	const code = encodeS1(plainCurve);
	expect(needsEngineering(plainCurve)).toBe(false);
	expect(tapeShareUrl(presetUrl(ORIGIN, code), plainCurve)).toBe(`${ORIGIN}/#p=${code}`);
});

function sheetProps(tape: Tape) {
	return {
		tape,
		current: neutralCurve(),
		origin: ORIGIN,
		locale: 'pt-BR' as const,
		app: null,
		verdict: gateForWrite(tape.bands, tape.preampDb, { experimental: true }),
		audioState: { ...IDLE_STATE },
		onClose: vi.fn(),
		onStatus: vi.fn()
	};
}

for (const [label, curve] of [
	['a band above 20 kHz', ultrasonicCurve],
	['an HP section (YOLO)', experimentalCurve]
] as const) {
	test(`the sheet QR code, its link and the card open ${label} in Engenharia`, async () => {
		const tape = tapeOf(curve);
		// Shareable (standard or YOLO): the sheet shows the QR code and the link.
		expect(exitReason(tape)).toBeNull();
		const expected = `${ORIGIN}/?camada=engenharia#p=${encodeS1(tape)}`;
		const screen = await render(TrackSheet, sheetProps(tape));
		const link = screen.container.querySelector<HTMLAnchorElement>('.print-card a');
		expect(link?.getAttribute('href')).toBe(expected);
		const qr = screen.container.querySelector<HTMLImageElement>('.print-card img');
		expect(qr?.getAttribute('src')).toBe(
			`data:image/svg+xml,${encodeURIComponent(qrSvg(expected))}`
		);
		const card = sheetSvg(tape, ORIGIN, 'pt-BR', copy);
		expect(card).toContain(placedQr(expected));
		expect(card).not.toContain(placedQr(`${ORIGIN}/#p=${encodeS1(tape)}`));
	});
}

test('a tape every layer admits keeps the plain link, QR code and card', async () => {
	const tape = tapeOf(plainCurve);
	const expected = `${ORIGIN}/#p=${encodeS1(tape)}`;
	const screen = await render(TrackSheet, sheetProps(tape));
	const link = screen.container.querySelector<HTMLAnchorElement>('.print-card a');
	expect(link?.getAttribute('href')).toBe(expected);
	expect(sheetSvg(tape, ORIGIN, 'pt-BR', copy)).toContain(placedQr(expected));
});
