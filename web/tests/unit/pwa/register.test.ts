import { afterEach, describe, expect, test, vi } from 'vitest';
import { registerPwa, type UpdateState } from '#lib/pwa/register.ts';
import { SKIP_WAITING } from '#lib/pwa/strategy.ts';

class WorkerStub extends EventTarget {
	postMessage = vi.fn();
}

class RegistrationStub extends EventTarget {
	waiting: WorkerStub | null = new WorkerStub();
	installing: WorkerStub | null = null;
}

function browser() {
	const registration = new RegistrationStub();
	const workers = Object.assign(new EventTarget(), {
		controller: new WorkerStub() as WorkerStub | null,
		register: vi.fn().mockResolvedValue(registration)
	});
	const reload = vi.fn();
	const win = { isSecureContext: true, location: { reload }, __oaWriteInProgress: false };
	vi.stubGlobal('window', win);
	vi.stubGlobal('navigator', { serviceWorker: workers });
	const states: UpdateState[] = [];
	return { registration, workers, reload, win, states };
}

afterEach(() => vi.unstubAllGlobals());

describe('PWA registration and explicit updates', () => {
	test('is an SSR-safe no-op without a browser', async () => {
		vi.stubGlobal('window', undefined);
		const controller = await registerPwa();
		expect(controller.applyUpdate()).toBe(false);
		controller.dispose();
	});

	test('registers a module without HTTP cache and observes an already waiting update', async () => {
		const { workers, states, reload } = browser();
		const controller = await registerPwa({ onState: (state) => states.push(state) });
		expect(workers.register).toHaveBeenCalledWith('/service-worker.js', {
			scope: '/',
			type: 'module',
			updateViaCache: 'none'
		});
		expect(states.at(-1)?.waiting).toBe(true);
		expect(reload).not.toHaveBeenCalled();
		controller.dispose();
	});

	test('does not activate during a write and reloads only after an explicit update action', async () => {
		const { registration, workers, reload, win, states } = browser();
		const waiting = registration.waiting;
		const controller = await registerPwa({ onState: (state) => states.push(state) });
		win.__oaWriteInProgress = true;
		expect(controller.applyUpdate()).toBe(false);
		expect(waiting?.postMessage).not.toHaveBeenCalled();
		expect(states.at(-1)?.blocked).toBe(true);
		win.__oaWriteInProgress = false;
		expect(controller.applyUpdate()).toBe(true);
		expect(waiting?.postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING });
		expect(reload).not.toHaveBeenCalled();
		workers.dispatchEvent(new Event('controllerchange'));
		expect(reload).toHaveBeenCalledOnce();
		controller.dispose();
	});

	test('checks again on controllerchange and requires a fresh click after a racing write', async () => {
		const { workers, registration, reload, win, states } = browser();
		const controller = await registerPwa({ onState: (state) => states.push(state) });
		expect(controller.applyUpdate()).toBe(true);
		win.__oaWriteInProgress = true;
		registration.waiting = null;
		workers.dispatchEvent(new Event('controllerchange'));
		expect(reload).not.toHaveBeenCalled();
		expect(states.at(-1)).toEqual({ waiting: true, applying: false, blocked: true });
		win.__oaWriteInProgress = false;
		expect(reload).not.toHaveBeenCalled();
		expect(controller.applyUpdate()).toBe(true);
		expect(reload).toHaveBeenCalledOnce();
		controller.dispose();
	});

	test('does not reload for first install or another tab activating an update', async () => {
		const { workers, registration, reload, states } = browser();
		registration.waiting = null;
		workers.controller = null;
		const controller = await registerPwa({ onState: (state) => states.push(state) });
		expect(states.at(-1)?.waiting).toBe(false);
		workers.dispatchEvent(new Event('controllerchange'));
		expect(reload).not.toHaveBeenCalled();
		workers.controller = new WorkerStub();
		workers.dispatchEvent(new Event('controllerchange'));
		expect(reload).not.toHaveBeenCalled();
		controller.dispose();
	});

	test('observes updates installed later and removes listeners on disposal', async () => {
		const { registration, workers, reload, states } = browser();
		registration.waiting = null;
		const controller = await registerPwa({ onState: (state) => states.push(state) });
		const installing = new WorkerStub();
		registration.installing = installing;
		registration.dispatchEvent(new Event('updatefound'));
		registration.waiting = installing;
		installing.dispatchEvent(new Event('statechange'));
		expect(states.at(-1)?.waiting).toBe(true);
		controller.dispose();
		const count = states.length;
		registration.dispatchEvent(new Event('updatefound'));
		installing.dispatchEvent(new Event('statechange'));
		workers.dispatchEvent(new Event('controllerchange'));
		expect(states).toHaveLength(count);
		expect(reload).not.toHaveBeenCalled();
		expect(controller.applyUpdate()).toBe(false);
	});
});
