import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
/** FUX.P5 (`cego_fux_`) and FUX.P5b (`cego_fuxb_`) keys, read from the merged catalog. */
const catalog = (locale: string) =>
	Object.fromEntries(
		Object.entries(
			JSON.parse(read(`../../../../messages/${locale}.json`)) as Record<string, string>
		).filter(([key]) => /^cego_fuxb?_/.test(key))
	);
const source = (file: string) => read(`../../../../src/lib/components/pages/teste-cego/${file}`);

test('FUX.P5 copy: same keys, same fields, no em dash, no plan codes, exact literals', () => {
	const pt = catalog('pt-BR');
	const en = catalog('en-US');
	expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
	expect(pt).not.toHaveProperty('$schema');
	// The disabled-reason keys (FUX.P5b) are merged too.
	expect(pt.cego_fuxb_reason_busy).toBe('Aguarde: a operação anterior ainda não terminou.');
	for (const [key, value] of Object.entries(pt)) {
		expect(key).toMatch(/^cego_fuxb?_/);
		expect(value, key).not.toContain('—');
		expect(en[key], key).not.toContain('—');
		expect(value.match(/\{\w+\}/g) ?? []).toEqual(en[key]?.match(/\{\w+\}/g) ?? []);
		expect(`${value} ${en[key]}`).not.toMatch(/\b(?:S\d{1,2}|T\d+(?:\.\d+)?|F\d+|FUX)\b/);
	}
	expect(pt.cego_fux_waiting).toBe('aguardando candidatos');
	expect(pt.cego_fux_pick_file).toBe('Escolher arquivo de áudio');
	expect(pt.cego_fux_output_eyebrow).toBe('Saída · obrigatório');
	expect(pt.cego_fux_round_lcd).toBe('Rodada');
	expect(pt.cego_fux_rate_lcd).toBe('Taxa DSP');
	expect(pt.cego_fux_lock).toBe('Em posição');
	expect(pt.cego_fux_engine_eyebrow).toBe('Motor de áudio');
});

test('existing literals the console still shows are unchanged in the catalog', () => {
	const merged = fileURLToPath(new URL('../../../../messages/pt-BR.json', import.meta.url));
	if (!existsSync(merged)) return;
	const pt = JSON.parse(readFileSync(merged, 'utf8')) as Record<string, string>;
	expect(pt.cego_switch).toBe('Troca de 3 s');
	expect(pt.cego_matched).toBe('Nível igualado');
	expect(pt.cego_closed).toBe('Tela fechada');
	expect(pt.cego_neutral_note).toBe(
		'Confirmo 10 × OFF + preamp −0,5 dB. O cabo não pode ser lido: só você pode confirmar. Esta escolha não grava nada.'
	);
});

test('page contract: tour ids, explainers, primitives, switch, consent-gated Turnstile, no Fontsource', () => {
	const blind = source('BlindTest.svelte');
	const room = source('ListeningRoom.svelte');
	const stage = source('Stage.svelte');
	const s6 = source('S6Send.svelte');
	const route = read('../../../../src/routes/teste-cego/+page.svelte');
	expect(blind).toContain('data-tour="cego-prepare"');
	expect(blind).toContain('data-tour="cego-listen"');
	expect(room).toContain('data-tour="cego-result"');
	expect(room).toContain('<Explainer term="teste-cego" />');
	expect(room).toContain('<TourTrigger page="teste-cego" />');
	expect(blind).toContain('<Explainer term="ab-nivel" />');
	expect(route).toContain('<Tour page="teste-cego" />');
	expect(blind).toMatch(/role="switch"/);
	expect(blind).not.toMatch(/bind:checked=\{labSwitch\}/);
	const community = source('CommunityCandidates.svelte');
	// Primitive Buttons never take `disabled`: they state a reason instead.
	for (const component of [blind, room, stage, s6, community]) {
		expect(component).not.toMatch(/<Button\b[^>]*\sdisabled=/);
	}
	// No native buttons left in the stage, the S6 card or the community list.
	for (const component of [room, stage, s6, community]) {
		expect(component).not.toMatch(/<button\b/);
	}
	// Native fields that stay disabled point at text with the reason: the locked tabs, and the
	// score faders, which now live on the stage (one per bay, never inside the bay's button).
	expect(blind).toContain(
		'aria-describedby={active && index !== 2 ? `${uid}-tabs-locked` : undefined}'
	);
	expect(blind).not.toContain('m.cego_rating(');
	expect(stage.match(/<input\b[^>]*type="range"/g)).toHaveLength(1);
	expect(stage).toContain('disabled={lock !== null}');
	expect(stage).toContain('aria-describedby={lock ? `${uid}-lock-${position}` : undefined}');
	expect(stage).toContain('id="{uid}-lock-{position}"');
	expect(stage).toMatch(/<\/Button>\s*<!--[^>]*-->\s*\{#if scored && position < count\}/);
	expect(
		community.match(/aria-describedby=\{disabled \? `\$\{uid\}-locked` : undefined\}/g)
	).toHaveLength(2);
	// Turnstile mounts only after both consents.
	// (BlindTest only forwards the site key; it never imports or mounts the widget itself.)
	expect(blind).not.toMatch(/import Turnstile\b|<Turnstile\b/);
	expect(s6).toMatch(/\{#if [^}]*\bconsented\b[^}]*\}\s*\{#key attempt\}\s*<Turnstile/);
	for (const file of [blind, room, stage, s6, source('CandidateMeter.svelte'), route]) {
		expect(file).not.toContain('@fontsource');
	}
	// Both play controls warm the shared engine on press (spec §5.4).
	expect(blind).toContain("import { warmAudio } from '#lib/audio/warm.ts';");
	expect(blind.match(/onpointerdown=\{warm\}\s+onkeydown=\{warm\}/g)).toHaveLength(2);
	// Nothing reaches the cable from this page: the output choice only reads its state.
	const output = source('output.ts');
	expect(`${blind}\n${room}\n${stage}\n${output}`).not.toMatch(
		/\b(requestWrite|writeCurve|writeMany|createGesture|requestDevice|sendReport)\s*\(/
	);
	expect(`${blind}\n${stage}\n${output}`).not.toMatch(
		/\bcable\??\.(connect|disconnect|write)\w*\s*\(/
	);
	expect(output).toMatch(/^import type \{[^}]*\} from '#lib\/cable\/types\.ts';$/m);
	expect(output).not.toMatch(/^import (?!type )/m);
});
