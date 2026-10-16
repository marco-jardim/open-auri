import { createAudioEngine } from '../../../src/lib/audio/engine.ts';
import { FakeHID, FakeHIDDevice, createFakeClock } from 'open-auri/transport';
import type { ClientAppOptions } from '../../../src/lib/app/index.ts';
import { memoryLocks } from '../cable/locks-fake.ts';

export class MemoryStorage {
	private values = new Map<string, string>();
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
}

export function fakeAppOptions() {
	const time = { value: Date.UTC(2026, 9, 16, 12) };
	const local = new MemoryStorage();
	const session = new MemoryStorage();
	local.setItem('oa.flash.lastWriteAt', String(time.value - 5000));
	const clock = createFakeClock(0, { autoAdvance: true });
	const device = new FakeHIDDevice({ clock });
	const hid = new FakeHID({ devices: [device] });
	const audio = createAudioEngine({ indexedDB: null, document: null, AudioContext: null });
	// Isolated per fake app: component test files share one origin (and its navigator.locks).
	const locks = memoryLocks();
	const options: ClientAppOptions = {
		now: () => time.value,
		storage: { local, session, indexedDB: null, channel: null },
		audio,
		cable: { hid, clock, userActivation: () => ({ isActive: true }), locks }
	};
	return { options, time, local, session, device, hid, audio, locks };
}
