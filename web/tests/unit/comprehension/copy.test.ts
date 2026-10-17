import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import ptAll from '../../../messages/pt-BR.json';
import enAll from '../../../messages/en-US.json';
import { explainers } from '#lib/comprehension/explainers.ts';
import { glossary } from '#lib/comprehension/glossary.ts';
import { tourSteps } from '#lib/comprehension/steps.ts';

const prefix = /^(tour|explain|glossary|empty)_/;
const pick = (all: Record<string, string>) =>
	Object.fromEntries(Object.entries(all).filter(([key]) => prefix.test(key)));
const pt = pick(ptAll) as typeof ptAll;
const en = pick(enAll) as typeof enAll;

test('comprehension messages have identical keys in both locales and no pt-BR em dash', () => {
	expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
	for (const [key, value] of Object.entries(pt)) {
		expect(value, key).not.toContain('—');
		expect(value.trim(), key).not.toBe('');
	}
	for (const value of Object.values(en)) expect(value.trim()).not.toBe('');
});

test('no staging pt-BR message contains an em dash', () => {
	const directory = new URL('../../../messages/_staging/', import.meta.url);
	const files = readdirSync(directory).filter((name) => name.endsWith('.pt-BR.json'));
	expect(Array.isArray(files)).toBe(true);
	for (const file of files) {
		const messages: Record<string, unknown> = JSON.parse(
			readFileSync(new URL(file, directory), 'utf8')
		);
		for (const [key, value] of Object.entries(messages)) {
			if (typeof value === 'string') expect(value, `${file}:${key}`).not.toContain('—');
		}
	}
});

test('every explainer links to a supported glossary term and the complete Docs anchor contract', () => {
	const expected = [
		'gate',
		'envelope',
		'q',
		'preamp',
		's1',
		's5',
		's6',
		's7',
		'ab-nivel',
		'teste-cego',
		'checklist',
		'flash',
		'crc',
		'q27',
		'q23',
		'camadas',
		'neutro'
	];
	expect(Object.keys(glossary).sort()).toEqual(expected.sort());
	for (const entry of Object.values(explainers)) {
		expect(entry.anchor).toBe(`/docs#g-${entry.term}`);
		expect(glossary[entry.term]).toBeDefined();
		expect(typeof entry.title).toBe('function');
		expect(typeof entry.body).toBe('function');
	}
	for (const reason of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
		expect(explainers).toHaveProperty(`gate-${reason}`);
	}
});

test('all seven pages have 3–5 uniquely anchored steps with both locales', () => {
	expect(Object.keys(tourSteps)).toHaveLength(7);
	const ids = new Set<string>();
	for (const steps of Object.values(tourSteps)) {
		expect(steps.length).toBeGreaterThanOrEqual(3);
		expect(steps.length).toBeLessThanOrEqual(5);
		for (const step of steps) {
			expect(ids.has(step.id)).toBe(false);
			ids.add(step.id);
			expect(step.selector).toBe(`[data-tour="${step.id}"]`);
			for (const locale of [pt, en]) {
				expect(locale).toHaveProperty(step.titleKey);
				expect(locale).toHaveProperty(step.bodyKey);
			}
		}
	}
});

test('Curva tour, official explainers and empty-state copy stay literal to the specification', () => {
	const spec = readFileSync(new URL('../../../../docs/plans/fux-spec.md', import.meta.url), 'utf8');
	for (const key of Object.keys(pt)) {
		if (key.startsWith('tour_curva_')) {
			expect(spec).toContain(pt[key as keyof typeof pt]);
			expect(spec).toContain(en[key as keyof typeof en]);
		}
	}
	const official = [
		'explain_gate_body',
		'explain_envelope_body',
		'explain_q_body',
		'explain_preamp_body',
		'explain_s1_body',
		'explain_ab_body',
		'explain_blind_body',
		'explain_checklist_body',
		'explain_s6_body',
		'explain_s7_body',
		'explain_checklist_warning',
		'explain_layers_body',
		'explain_neutral_body',
		'explain_s5_body',
		'empty_community_body',
		'empty_guest_open',
		'empty_guest_closed',
		'empty_journal_body',
		'empty_library_body',
		'empty_soe_body',
		'empty_neutral_body'
	] as const;
	for (const key of official) expect(spec, key).toContain(pt[key]);
	for (const key of [
		'explain_envelope_body',
		'explain_q_body',
		'explain_preamp_body',
		'explain_s1_body',
		'explain_ab_body',
		'explain_blind_body',
		'explain_checklist_body',
		'explain_s6_body',
		'explain_s7_body'
	] as const)
		expect(spec, key).toContain(en[key]);
	expect(en.explain_gate_body).toBe(
		'Before any write, open-auri checks the curve against the exact numbers that would go to the cable. If it goes beyond what the official presets already do, Write stays locked and we show you why. It is a similarity policy with what the 11 official presets already make the chip compute, not a proof of hardware safety.'
	);
	for (const reason of ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const) {
		const key = `explain_gate_${reason}_body` as const;
		expect(spec).toContain(pt[key]);
		expect(spec).toContain(en[key]);
	}
});

test('no visible message carries a plan code outside the technical Docs thresholds', () => {
	const code = /\bS(10|[1-9])\b|\b[TF]\d+(\.\d+)?\b|gate v2/i;
	for (const messages of [ptAll, enAll] as Record<string, string>[]) {
		for (const [key, value] of Object.entries(messages)) {
			if (key === 'docs_thresholds' || key === '$schema') continue;
			expect(value, key).not.toMatch(code);
		}
	}
});

test('highlight is static for reduced motion and touch triggers keep a 44px hit area', () => {
	// FUX.B: the open tour (and its highlight) is the lazy TourPanel; Tour.svelte is the host.
	const tour = readFileSync(
		new URL('../../../src/lib/components/comprehension/TourPanel.svelte', import.meta.url),
		'utf8'
	);
	const read = (name: string) =>
		readFileSync(
			new URL(`../../../src/lib/components/comprehension/${name}`, import.meta.url),
			'utf8'
		);
	expect(tour).toContain('@media (prefers-reduced-motion: reduce)');
	expect(tour).toContain('transition: none');
	expect(tour).toContain('animation: none');
	// Both the eager trigger and the lazy panel's close button keep the 44px touch target.
	for (const source of [read('Explainer.svelte'), read('ExplainerPanel.svelte'), tour]) {
		expect(source).toContain('@media (pointer: coarse)');
		expect(source).toContain('min-height: 44px');
	}
	expect(read('Explainer.svelte')).toContain('min-width: 44px');
	expect(read('ExplainerPanel.svelte')).toContain('min-width: 44px');
});
