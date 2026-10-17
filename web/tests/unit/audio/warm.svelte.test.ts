import { afterEach, expect, test, vi, type Mock } from 'vitest';
import type { AudioEngine } from '#lib/audio/engine.ts';
import { prefetchMeterWorklet, warmAudio, warmAudioOnPress } from '#lib/audio/warm.ts';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const link of document.head.querySelectorAll('link[data-warm]')) link.remove();
});

interface FakeContext {
	state: AudioContextState;
	resume: Mock<() => Promise<void>>;
	audioWorklet: { addModule: Mock<(url: string | URL) => Promise<void>> };
}

function fakeEngine(context: FakeContext | Error) {
	const start = vi.fn<AudioEngine['start']>();
	const getContext = vi.fn(() => {
		if (context instanceof Error) throw context;
		return context as unknown as AudioContext;
	});
	// Only the members warm-up may touch; anything else would throw a TypeError in the test.
	const engine = { getContext, start } as unknown as AudioEngine;
	return { engine, getContext, start };
}

function context(state: AudioContextState, resume = vi.fn<() => Promise<void>>()): FakeContext {
	const ctx: FakeContext = {
		state,
		resume,
		audioWorklet: {
			addModule: vi.fn<(url: string | URL) => Promise<void>>().mockResolvedValue(undefined)
		}
	};
	resume.mockImplementation(async () => {
		ctx.state = 'running';
	});
	return ctx;
}

test('warmAudio resumes a suspended context and adds the meter worklet, never starting sound', async () => {
	const ctx = context('suspended');
	const fake = fakeEngine(ctx);
	const first = warmAudio(fake.engine);
	expect(warmAudio(fake.engine)).toBe(first);
	await expect(first).resolves.toBe(true);
	expect(ctx.resume).toHaveBeenCalledOnce();
	expect(ctx.audioWorklet.addModule).toHaveBeenCalledOnce();
	expect(String(ctx.audioWorklet.addModule.mock.calls[0]?.[0])).toMatch(/meter-processor/);
	expect(fake.start).not.toHaveBeenCalled();
	// A later press reuses the loaded worklet for the same context.
	await expect(warmAudio(fake.engine)).resolves.toBe(true);
	expect(ctx.audioWorklet.addModule).toHaveBeenCalledOnce();
});

test('warmAudio gives up on a resume the browser keeps pending (no activation) and on errors', async () => {
	const pending = context('suspended', vi.fn<() => Promise<void>>());
	pending.resume.mockImplementation(() => new Promise<void>(() => undefined));
	vi.useFakeTimers();
	const waiting = warmAudio(fakeEngine(pending).engine);
	await vi.advanceTimersByTimeAsync(500);
	vi.useRealTimers();
	await expect(waiting).resolves.toBe(false);

	const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
	await expect(warmAudio(fakeEngine(new Error('unsupported')).engine)).resolves.toBe(false);
	const rejected = context('suspended', vi.fn<() => Promise<void>>());
	rejected.resume.mockRejectedValue(new DOMException('denied', 'InvalidStateError'));
	await expect(warmAudio(fakeEngine(rejected).engine)).resolves.toBe(false);
	expect(info).toHaveBeenCalledTimes(2);
});

test('warmAudioOnPress warms on a primary press or Enter/Space only, and detaches', async () => {
	const ctx = context('running');
	const fake = fakeEngine(ctx);
	const button = document.createElement('button');
	document.body.append(button);
	try {
		const detach = warmAudioOnPress(() => fake.engine)(button);
		button.dispatchEvent(new PointerEvent('pointerdown', { button: 2 }));
		button.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
		button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
		expect(fake.getContext).not.toHaveBeenCalled();
		button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
		await expect.poll(() => fake.getContext.mock.calls.length).toBe(1);
		await expect.poll(() => ctx.audioWorklet.addModule.mock.calls.length).toBe(1);
		button.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }));
		await expect.poll(() => fake.getContext.mock.calls.length).toBe(2);
		detach();
		button.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }));
		button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fake.getContext).toHaveBeenCalledTimes(2);
		expect(fake.start).not.toHaveBeenCalled();
	} finally {
		button.remove();
	}
});

test('prefetchMeterWorklet prefetches the worklet module once, executing nothing', async () => {
	const url = await prefetchMeterWorklet();
	expect(url).toMatch(/meter-processor/);
	await prefetchMeterWorklet();
	const links = document.head.querySelectorAll('link[rel="prefetch"][data-warm]');
	expect(links).toHaveLength(1);
});
