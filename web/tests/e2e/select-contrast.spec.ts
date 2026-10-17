// Every native dropdown stays readable: the closed control and its option list both keep
// WCAG 4.5:1 between text and the background actually painted behind them.
import { expect, test, type Page } from '@playwright/test';

const ROUTES = [
	'/',
	'/biblioteca',
	'/comparar',
	'/soe-como-x',
	'/comunidade',
	'/teste-cego',
	'/cabo',
	'/docs'
];
const PAGES = ['curva', 'comunidade', 'cabo', 'soe-como-x', 'comparar', 'teste-cego', 'biblioteca'];

interface Finding {
	route: string;
	select: string;
	part: 'face' | 'option';
	ratio: number;
}

async function audit(page: Page, route: string): Promise<Finding[]> {
	return page.evaluate((route) => {
		const parse = (value: string): [number, number, number, number] | null => {
			const match = value.match(/rgba?\(([^)]+)\)/);
			if (!match) return null;
			const parts = match[1]
				.split(/[\s,/]+/)
				.filter(Boolean)
				.map(Number);
			return [parts[0], parts[1], parts[2], parts[3] ?? 1];
		};
		const over = (top: number[], bottom: number[]) =>
			top.slice(0, 3).map((c, i) => c * top[3] + bottom[i] * (1 - top[3]));
		const luminance = (rgb: number[]) => {
			const [r, g, b] = rgb.map((c) => {
				const s = c / 255;
				return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const ratio = (a: number[], b: number[]) => {
			const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
			return (hi + 0.05) / (lo + 0.05);
		};
		/** Background painted behind an element: composite every ancestor's solid colour. */
		const backdrop = (element: Element): number[] => {
			const layers: number[][] = [];
			for (let node: Element | null = element; node; node = node.parentElement) {
				const colour = parse(getComputedStyle(node).backgroundColor);
				if (colour && colour[3] > 0) {
					layers.push(colour);
					if (colour[3] >= 1) break;
				}
			}
			let result = [255, 255, 255];
			for (const layer of layers.reverse()) result = over(layer, result);
			return result;
		};
		const findings: Finding[] = [];
		const selects = [...document.querySelectorAll('select')].filter(
			(select) => select.getClientRects().length > 0
		);
		for (const select of selects) {
			const name =
				select.getAttribute('aria-label') ??
				select.labels?.[0]?.textContent?.trim() ??
				select.id ??
				select.name;
			const style = getComputedStyle(select);
			const ink = parse(style.color);
			if (ink) {
				const back = backdrop(select);
				findings.push({ route, select: name, part: 'face', ratio: ratio(over(ink, back), back) });
			}
			const option = select.querySelector('option');
			if (option) {
				const optionStyle = getComputedStyle(option);
				const optionInk = parse(optionStyle.color);
				const optionBack = parse(optionStyle.backgroundColor);
				// A transparent option list is painted by the OS on white.
				const list =
					optionBack && optionBack[3] > 0 ? over(optionBack, [255, 255, 255]) : [255, 255, 255];
				if (optionInk) {
					findings.push({
						route,
						select: name,
						part: 'option',
						ratio: ratio(over(optionInk, list), list)
					});
				}
			}
		}
		return findings;
	}, route);
}

test.beforeEach(async ({ context }) => {
	await context.addInitScript((pages) => {
		localStorage.setItem(
			'oa.tour.v1',
			JSON.stringify(Object.fromEntries(pages.map((name) => [name, 'dispensado'])))
		);
	}, PAGES);
});

for (const route of ROUTES) {
	test(`dropdowns on ${route} keep 4.5:1 for the control and its options`, async ({ page }) => {
		await page.goto(route);
		await page.waitForLoadState('networkidle');
		const failing = (await audit(page, route)).filter((finding) => finding.ratio < 4.5);
		expect(failing, JSON.stringify(failing, null, 1)).toEqual([]);
	});
}
