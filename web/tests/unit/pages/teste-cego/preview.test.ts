import { describe, expect, test, vi } from 'vitest';
import type { AudioEngine, PreviewChain } from '#lib/audio/engine.ts';
import { matchGains } from '#lib/audio/engine.ts';
import { NEUTRO } from 'open-auri/catalog';
import { candidate } from '#lib/components/pages/teste-cego/experiment.ts';
import { createBlindPreview } from '#lib/components/pages/teste-cego/preview.ts';

function fakeChain(id: string) {
	// Only the methods used by the page controller; no fake meter readings or production fakes.
	return { id, setGain: vi.fn(), dispose: vi.fn() } as unknown as PreviewChain;
}
function fakeEngine() {
	const a = fakeChain('a'),
		b = fakeChain('b'),
		c = fakeChain('c');
	const createAB = vi.fn(() => ({
		a,
		b,
		dispose: () => {
			a.dispose();
			b.dispose();
		}
	}));
	const buildChain = vi.fn(() => c);
	const engine = { createAB, buildChain, matchGains: vi.fn(matchGains) } as unknown as AudioEngine;
	return { engine, a, b, c, createAB, buildChain };
}

describe('shared preview level matching', () => {
	test('uses createAB, global three-way attenuation and only the selected chain is audible', () => {
		const fake = fakeEngine();
		const candidates = [-1, -4, -9].map((level, i) => ({
			...candidate(String(i), String(i), NEUTRO),
			level
		}));
		const preview = createBlindPreview(fake.engine, candidates);
		expect(fake.createAB).toHaveBeenCalledOnce();
		expect(fake.buildChain).toHaveBeenCalledOnce();
		expect(preview.trims).toEqual([-8, -5, 0]);
		for (const chain of preview.chains) expect(chain.setGain).toHaveBeenLastCalledWith(0, false);
		preview.select('1');
		expect(fake.a.setGain).toHaveBeenLastCalledWith(-8, false);
		expect(fake.b.setGain).toHaveBeenLastCalledWith(-5, true);
		expect(fake.c.setGain).toHaveBeenLastCalledWith(0, false);
		preview.dispose();
		for (const chain of preview.chains) expect(chain.dispose).toHaveBeenCalledOnce();
	});
	test('cleans up the A/B pair if the third chain fails', () => {
		const fake = fakeEngine();
		fake.buildChain.mockImplementation(() => {
			throw new Error('unsupported');
		});
		const candidates = ['a', 'b', 'c'].map((id) => candidate(id, id, NEUTRO));
		expect(() => createBlindPreview(fake.engine, candidates)).toThrow('unsupported');
		expect(fake.a.dispose).toHaveBeenCalledOnce();
		expect(fake.b.dispose).toHaveBeenCalledOnce();
	});
	test('two candidates do not build another chain or touch transport or playback', () => {
		const fake = fakeEngine();
		createBlindPreview(
			fake.engine,
			['a', 'b'].map((id) => candidate(id, id, NEUTRO))
		);
		expect(fake.buildChain).not.toHaveBeenCalled();
		expect(() => createBlindPreview(fake.engine, [])).toThrow(RangeError);
	});
});
