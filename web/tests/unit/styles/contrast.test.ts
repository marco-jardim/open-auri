// WCAG 2.x contrast of the design system v2.1 pairs (FUX.1, spec docs/plans/fux-spec.md §2.2).
// Colours are read from the real sources, not copied: tokens.css and accents.css for the app,
// and the :root of design/mocks/v2/*.html for the page surfaces the mocks define. Text pairs
// need >= 4.5:1 (1.4.3); control borders and non-text indicators need >= 3:1 (1.4.11).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
	readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const TOKENS = read('../../../src/lib/styles/tokens.css');
const ACCENTS = read('../../../src/lib/styles/accents.css');
const MOCKS = '../../../../design/mocks/v2/';

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba {
	const text = value.trim().toLowerCase();
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
	if (hex) {
		const raw = hex[1] ?? '';
		const digits = raw.length === 3 ? [...raw].map((c) => c + c).join('') : raw;
		return {
			r: parseInt(digits.slice(0, 2), 16),
			g: parseInt(digits.slice(2, 4), 16),
			b: parseInt(digits.slice(4, 6), 16),
			a: 1
		};
	}
	const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(
		text
	);
	if (rgba) {
		return {
			r: Number(rgba[1]),
			g: Number(rgba[2]),
			b: Number(rgba[3]),
			a: rgba[4] === undefined ? 1 : Number(rgba[4])
		};
	}
	throw new Error(`Unsupported colour: ${value}`);
}

/** Declared value of a custom property inside a CSS block (first match after `scope`). */
function declared(css: string, name: string, scope = ''): string {
	const start = scope ? css.indexOf(scope) : 0;
	if (start < 0) throw new Error(`Scope not found: ${scope}`);
	const match = new RegExp(`${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`).exec(
		css.slice(start)
	);
	if (!match) throw new Error(`${name} not declared${scope ? ` in ${scope}` : ''}`);
	return (match[1] ?? '').trim();
}

const token = (name: string) => parseColor(declared(TOKENS, name));
const pageAccent = (page: string, name = '--accent') =>
	parseColor(declared(ACCENTS, name, `[data-page='${page}'] {`));

function mockRoot(file: string, name: string): Rgba {
	const html = read(`${MOCKS}${file}`);
	const root = /:root\s*\{([^}]*)\}/.exec(html);
	if (!root) throw new Error(`No :root in ${file}`);
	const match = new RegExp(`${name.replace(/[-]/g, '\\-')}\\s*:\\s*([^;}]+)`).exec(root[1] ?? '');
	if (!match) throw new Error(`${name} not in the :root of ${file}`);
	return parseColor(match[1] ?? '');
}

/** Composites a translucent colour over an opaque surface (sRGB, as browsers paint). */
function over(top: Rgba, bottom: Rgba): Rgba {
	return {
		r: top.r * top.a + bottom.r * (1 - top.a),
		g: top.g * top.a + bottom.g * (1 - top.a),
		b: top.b * top.a + bottom.b * (1 - top.a),
		a: 1
	};
}

/** color-mix(in srgb, a p%, b) */
function mix(a: Rgba, b: Rgba, p: number): Rgba {
	return {
		r: a.r * p + b.r * (1 - p),
		g: a.g * p + b.g * (1 - p),
		b: a.b * p + b.b * (1 - p),
		a: 1
	};
}

function luminance({ r, g, b }: Rgba): number {
	const channel = (value: number) => {
		const c = value / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg: Rgba, bg: Rgba): number {
	const surface = bg.a < 1 ? over(bg, token('--ink')) : bg;
	const ink = fg.a < 1 ? over(fg, surface) : fg;
	const a = luminance(ink);
	const b = luminance(surface);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const WHITE = parseColor('#ffffff');
const TEXT = 4.5;
const NON_TEXT = 3;

describe('formula', () => {
	it('matches the WCAG reference values', () => {
		expect(contrast(parseColor('#000000'), WHITE)).toBeCloseTo(21, 5);
		expect(contrast(parseColor('#777777'), WHITE)).toBeCloseTo(4.48, 2);
	});
});

describe('chrome surfaces (tokens.css)', () => {
	const ink = token('--ink');
	const ink2 = token('--ink-2');
	const ink3 = token('--ink-3');
	const ink4 = token('--ink-4');
	const popBg = token('--pop-bg');

	it('keeps the §2.2 values', () => {
		expect(declared(TOKENS, '--ink-3')).toBe('#1d1c1a');
		expect(declared(TOKENS, '--ink-4')).toBe('#2b2a27');
		expect(declared(TOKENS, '--muted-hi')).toBe('#a39d92');
		expect(declared(TOKENS, '--ok')).toBe('#4cc38a');
		expect(declared(TOKENS, '--warn')).toBe('#e5a23a');
		expect(declared(TOKENS, '--text-2')).toBe('#cfc9be');
		expect(declared(TOKENS, '--rule-control')).toBe('rgba(236, 231, 221, 0.4)');
		expect(declared(TOKENS, '--lamp-off')).toBe('rgba(236, 231, 221, 0.1)');
	});

	it.each([
		['--text', [ink, ink2, ink3, ink4, popBg]],
		['--text-2', [ink, ink2, ink3, ink4, popBg]],
		['--muted-hi', [ink, ink2, ink3, ink4, popBg]],
		['--state-text', [ink, ink2, popBg]],
		['--ok', [ink, ink2, ink3, ink4]],
		['--warn', [ink, ink2, ink3, ink4]]
	] as const)('%s reads as text (>= 4.5:1) on its surfaces', (name, surfaces) => {
		for (const surface of surfaces) {
			expect(contrast(token(name), surface)).toBeGreaterThanOrEqual(TEXT);
		}
	});

	it('--muted only on ink and ink-2 (T7); muted-hi takes over on raised and hardware panels', () => {
		expect(contrast(token('--muted'), ink)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(token('--muted'), ink2)).toBeGreaterThanOrEqual(TEXT);
		// Documents why --muted-hi exists: plain muted fails on the hardware panel.
		expect(contrast(token('--muted'), ink4)).toBeLessThan(TEXT);
		expect(contrast(token('--muted-hi'), ink4)).toBeGreaterThanOrEqual(5.25);
	});

	it('--danger as text only on ink and ink-2; the lightened chip/field red works on panels', () => {
		const danger = token('--danger');
		expect(contrast(danger, ink)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(danger, ink2)).toBeGreaterThanOrEqual(TEXT);
		const dangerText = mix(danger, WHITE, 0.7); // components.css: color-mix(danger 70%, white)
		for (const surface of [ink, ink2, ink3, ink4, popBg]) {
			expect(contrast(dangerText, surface)).toBeGreaterThanOrEqual(TEXT);
		}
		// Solid danger button: ink text on red.
		expect(contrast(ink, danger)).toBeGreaterThanOrEqual(TEXT);
	});

	it('--rule-control borders reach 3:1 on every chrome surface (T6); --rule stays decorative', () => {
		const control = token('--rule-control');
		for (const surface of [ink, ink2, ink3, ink4, popBg]) {
			expect(contrast(control, surface)).toBeGreaterThanOrEqual(NON_TEXT);
		}
		expect(contrast(token('--rule'), ink)).toBeLessThan(NON_TEXT);
	});

	it('disabled-with-reason buttons keep a legible label on the unlit face', () => {
		const face = over(token('--lamp-off'), ink2);
		expect(contrast(token('--muted-hi'), face)).toBeGreaterThanOrEqual(TEXT);
	});

	it('tooltips and menus: text on the popover surface', () => {
		expect(contrast(token('--text'), popBg)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(token('--muted'), popBg)).toBeGreaterThanOrEqual(TEXT);
	});
});

describe('page accents (accents.css)', () => {
	const ink = token('--ink');
	const ink2 = token('--ink-2');
	const ink3 = token('--ink-3');
	const ink4 = token('--ink-4');
	const pages = ['curva', 'biblioteca', 'comparar', 'comunidade', 'teste-cego', 'cabo'] as const;

	it.each(pages)('%s: --accent-text is the accent and reads on every chrome surface', (page) => {
		expect(declared(ACCENTS, '--accent-text', `[data-page='${page}'] {`)).toBe('var(--accent)');
		for (const surface of [ink, ink2, ink3, ink4]) {
			expect(contrast(pageAccent(page), surface)).toBeGreaterThanOrEqual(TEXT);
		}
	});

	it.each([...pages, 'soe-como-x'] as const)(
		'%s: --accent-ink on the accent (primary button)',
		(page) => {
			expect(contrast(pageAccent(page, '--accent-ink'), pageAccent(page))).toBeGreaterThanOrEqual(
				TEXT
			);
		}
	);

	it('soe-como-x: accent passes on ink, fails on hardware panels, so --accent-text is accent-hi', () => {
		expect(contrast(pageAccent('soe-como-x'), ink)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(pageAccent('soe-como-x'), ink4)).toBeLessThan(TEXT);
		expect(declared(ACCENTS, '--accent-text', `[data-page='soe-como-x'] {`)).toBe(
			'var(--accent-hi)'
		);
		for (const surface of [ink, ink2, ink3, ink4]) {
			expect(contrast(pageAccent('soe-como-x', '--accent-hi'), surface)).toBeGreaterThanOrEqual(
				TEXT
			);
		}
	});

	it('cabo: --accent-on-metal reads on every stop of --mat-metal and on the mock legend', () => {
		const onMetal = pageAccent('cabo', '--accent-on-metal');
		for (const stop of ['#d4d4cf', '#bdbdb7', '#c9c9c4']) {
			expect(declared(TOKENS, '--mat-metal')).toContain(stop);
			expect(contrast(onMetal, parseColor(stop))).toBeGreaterThanOrEqual(TEXT);
		}
		expect(contrast(onMetal, mockRoot('cabo.html', '--legend'))).toBeGreaterThanOrEqual(TEXT);
	});

	it('docs: the red accent on paper, the light chrome tint on the bar', () => {
		const paper = token('--paper');
		expect(contrast(pageAccent('docs'), paper)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(pageAccent('docs', '--accent-ink'), pageAccent('docs'))).toBeGreaterThanOrEqual(
			TEXT
		);
		const chrome = pageAccent('docs', '--accent-chrome');
		expect(contrast(chrome, ink2)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(token('--paper-ink'), paper)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(token('--paper-muted'), paper)).toBeGreaterThanOrEqual(TEXT);
	});

	it('neutral accent (admin, pages without an honoree) on the chrome', () => {
		expect(contrast(token('--accent'), ink2)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(token('--accent-ink'), token('--accent'))).toBeGreaterThanOrEqual(TEXT);
	});
});

describe('surfaces from the mocks (design/mocks/v2 :root)', () => {
	it('every mock keeps the chrome palette the tokens copy', () => {
		for (const file of [
			'curva.html',
			'biblioteca.html',
			'comparar.html',
			'soe-como-x.html',
			'comunidade.html',
			'teste-cego.html',
			'cabo.html',
			'docs.html'
		]) {
			expect(mockRoot(file, '--ink'), file).toEqual(token('--ink'));
			expect(mockRoot(file, '--text'), file).toEqual(token('--text'));
			expect(mockRoot(file, '--muted'), file).toEqual(token('--muted'));
		}
	});

	it('mock accents match accents.css', () => {
		const pairs = [
			['curva.html', 'curva'],
			['biblioteca.html', 'biblioteca'],
			['comparar.html', 'comparar'],
			['soe-como-x.html', 'soe-como-x'],
			['comunidade.html', 'comunidade'],
			['teste-cego.html', 'teste-cego'],
			['cabo.html', 'cabo'],
			['docs.html', 'docs']
		] as const;
		for (const [file, page] of pairs) {
			expect(mockRoot(file, '--accent'), file).toEqual(pageAccent(page));
		}
	});

	it('curva: legend text and the accent on the oscilloscope panel', () => {
		const panel = mockRoot('curva.html', '--pnl');
		expect(contrast(mockRoot('curva.html', '--legend'), panel)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(mockRoot('curva.html', '--legend-2'), panel)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(pageAccent('curva'), panel)).toBeGreaterThanOrEqual(TEXT);
	});

	it('comunidade: engraving, accent and muted-hi on the console face (muted fails there, T7)', () => {
		const face = mockRoot('comunidade.html', '--face');
		expect(contrast(mockRoot('comunidade.html', '--engrave'), face)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(pageAccent('comunidade'), face)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(token('--muted-hi'), face)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(token('--muted'), face)).toBeLessThan(TEXT);
		const tape = mockRoot('comunidade.html', '--tape');
		expect(contrast(mockRoot('comunidade.html', '--marker-ink'), tape)).toBeGreaterThanOrEqual(
			TEXT
		);
	});

	it('biblioteca: typed label ink on the paper label', () => {
		expect(
			contrast(mockRoot('biblioteca.html', '--paper-ink'), mockRoot('biblioteca.html', '--paper'))
		).toBeGreaterThanOrEqual(TEXT);
	});

	it('cabo: engraving on brushed metal', () => {
		const engrave = mockRoot('cabo.html', '--engrave');
		for (const stop of ['#d4d4cf', '#bdbdb7', '#c9c9c4']) {
			expect(contrast(engrave, parseColor(stop))).toBeGreaterThanOrEqual(TEXT);
		}
	});

	it('docs: paper ink and muted on the paper of the mock', () => {
		const paper = mockRoot('docs.html', '--paper');
		expect(contrast(mockRoot('docs.html', '--paper-ink'), paper)).toBeGreaterThanOrEqual(TEXT);
		expect(contrast(mockRoot('docs.html', '--paper-muted'), paper)).toBeGreaterThanOrEqual(TEXT);
		expect(
			contrast(mockRoot('docs.html', '--accent-light'), token('--ink-2'))
		).toBeGreaterThanOrEqual(TEXT);
	});
});

// FUX integration queue: text/surface pairs the page stylesheets paint with literal colours (no
// token or mock :root holds them). Named tokens are still read from tokens.css / accents.css.
describe('page text on page surfaces (FUX integration queue)', () => {
	const hex = parseColor;
	const muted = token('--muted');
	const mutedHi = token('--muted-hi');
	const text2 = token('--text-2');
	const soeAccentHi = pageAccent('soe-como-x', '--accent-hi');
	// Curva's --accent-text is var(--accent) (asserted in "page accents" above).
	const curvaAccentText = pageAccent('curva');

	const textPairs: [string, Rgba, Rgba][] = [
		// Comparar
		['comparar: #cfc6b2 on #0c0a08', hex('#cfc6b2'), hex('#0c0a08')],
		['comparar: #ff9b9e on #0b0a09', hex('#ff9b9e'), hex('#0b0a09')],
		['comparar: #f2b33d on #0c0a08', hex('#f2b33d'), hex('#0c0a08')],
		// Biblioteca
		['biblioteca: #4c4130 on #eaddbd', hex('#4c4130'), hex('#eaddbd')],
		['biblioteca: #302c23 on #eaddbd', hex('#302c23'), hex('#eaddbd')],
		['biblioteca: #e0cdae on #17130f', hex('#e0cdae'), hex('#17130f')],
		// Soe como X
		['soe-como-x: #a39d92 on #2c3227', hex('#a39d92'), hex('#2c3227')],
		['soe-como-x: #cfc9be on #2c3227', hex('#cfc9be'), hex('#2c3227')],
		['soe-como-x: --accent-hi on #363a30', soeAccentHi, hex('#363a30')],
		// Auth
		['auth: #a9b2bd on #1b2028', hex('#a9b2bd'), hex('#1b2028')],
		['auth: #e3e7ec on #1b2028', hex('#e3e7ec'), hex('#1b2028')],
		['auth: #ffb4a8 on #1b2028', hex('#ffb4a8'), hex('#1b2028')],
		// Comunidade
		['comunidade: --muted on #1a1c1f', muted, hex('#1a1c1f')],
		['comunidade: --muted-hi on #17181a', mutedHi, hex('#17181a')],
		['comunidade: --muted-hi on #1b1c1e', mutedHi, hex('#1b1c1e')],
		['comunidade: #4a3a1c on #f8f5ec', hex('#4a3a1c'), hex('#f8f5ec')],
		// Cabo
		['cabo: #24282a on #b5b8b4', hex('#24282a'), hex('#b5b8b4')],
		['cabo: #123b38 on #b5b8b4', hex('#123b38'), hex('#b5b8b4')],
		['cabo: #761115 on #b5b8b4', hex('#761115'), hex('#b5b8b4')],
		['cabo: #4a1013 on #b5b8b4', hex('#4a1013'), hex('#b5b8b4')],
		['cabo: #8fe9df on #0b1312', hex('#8fe9df'), hex('#0b1312')],
		['cabo: #a6f6ed on #0d0f10', hex('#a6f6ed'), hex('#0d0f10')],
		// Curva
		['curva: --text-2 on #2e2d2b', text2, hex('#2e2d2b')],
		['curva: --text-2 on #1f1e1c', text2, hex('#1f1e1c')],
		['curva: --accent-text on #050505', curvaAccentText, hex('#050505')],
		['curva: --muted-hi on #2b2a27', mutedHi, hex('#2b2a27')]
	];

	it.each(textPairs)('%s reads as text (>= 4.5:1)', (_pair, fg, bg) => {
		expect(contrast(fg, bg)).toBeGreaterThanOrEqual(TEXT);
	});

	// Soe como X station panels (FUX.P3): the olive gradient #45483e to #363a30 is lighter than the
	// hardware tokens assume, so `.station` remaps --accent-hi and --muted-hi to panel-safe
	// variants declared on `.soe-page`. Values are read from the component, not copied.
	describe('soe-como-x station panels', () => {
		const WORKSTATION = read('../../../src/lib/components/pages/soe-como-x/Workstation.svelte');
		const panelStops: [string, Rgba][] = [
			['#45483e', hex('#45483e')],
			['#363a30', hex('#363a30')]
		];
		const panelAccent = parseColor(declared(WORKSTATION, '--soe-panel-accent', '.soe-page {'));

		it('the stations remap the hi tokens to the panel-safe variants', () => {
			expect(WORKSTATION).toContain('linear-gradient(120deg, #45483e, #363a30)');
			expect(declared(WORKSTATION, '--accent-hi', '.station {')).toBe('var(--soe-panel-accent)');
			expect(declared(WORKSTATION, '--muted-hi', '.station {')).toBe('var(--soe-panel-muted)');
			expect(declared(WORKSTATION, '--soe-panel-muted', '.soe-page {')).toBe(
				'var(--text-2, #cfc9be)'
			);
		});

		it.each(panelStops)('panel accent on %s reads as text (>= 4.5:1)', (_name, surface) => {
			expect(contrast(panelAccent, surface)).toBeGreaterThanOrEqual(TEXT);
		});

		it.each(panelStops)(
			'panel secondary text (--text-2) on %s reads as text (>= 4.5:1)',
			(_name, surface) => {
				expect(contrast(text2, surface)).toBeGreaterThanOrEqual(TEXT);
			}
		);

		it('the page tokens alone would fail there, which is why the remap exists', () => {
			expect(contrast(soeAccentHi, hex('#45483e'))).toBeLessThan(TEXT);
			expect(contrast(mutedHi, hex('#45483e'))).toBeLessThan(TEXT);
			expect(contrast(mutedHi, hex('#363a30'))).toBeLessThan(TEXT);
		});
	});
});
