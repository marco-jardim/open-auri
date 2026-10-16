/** Shared helpers for the cable unit tests (node; FakeHID, FakeHIDDevice, createFakeClock). */
import { readFileSync } from 'node:fs';
import { FakeHID, FakeHIDDevice, createFakeClock } from 'open-auri/transport';
import { appendEntry, recordWrite } from 'open-auri/policy';
import { commitReport } from 'open-auri/dsp';
import { createCableService } from '../../../src/lib/cable/service.ts';
import type {
	Band,
	CableServiceDeps,
	CableWrittenDetail,
	Confirmations,
	FlashState,
	JournalEntry
} from '../../../src/lib/cable/types.ts';

interface PresetFixture {
	preampDb: number;
	eqBands: Band[];
	reports: number[][];
}

const fixtureUrl = new URL('../../../../test/fixtures/eq0xcb.reference.json', import.meta.url);
export const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as {
	presets: Record<string, PresetFixture>;
};

export const padrao: PresetFixture = fixture.presets.padrao as PresetFixture;
export const COMMIT = [...commitReport()];

/** 2026-10-16T12:00:00Z, epoch ms. */
export const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

export const CONFIRMED: Confirmations = {
	volumeLowered: true,
	keepConnected: true,
	experimental: false
};

export const TRUSTED_CLICK = { isTrusted: true, type: 'click' } as const;

export function off(): Band {
	return { kind: 'OFF' };
}

export function memoryJournal(initial: JournalEntry[] = []) {
	let entries: JournalEntry[] = initial.slice();
	return {
		get entries() {
			return entries;
		},
		// appendEntry validates the journal schema (throws on an invalid entry).
		append(entry: JournalEntry) {
			entries = appendEntry(entries, entry);
		},
		last(): JournalEntry | null {
			return entries.at(-1) ?? null;
		}
	};
}

export function memoryFlash(initial: Partial<FlashState> = {}) {
	let state: FlashState = {
		day: { date: null, count: 0 },
		total: 0,
		lastWriteAt: T0 - 10_000,
		session: 0,
		...initial
	};
	const records: number[] = [];
	return {
		records,
		get(): FlashState {
			return state;
		},
		record(nowMs: number) {
			records.push(nowMs);
			state = recordWrite(state, nowMs);
		}
	};
}

export interface SetupOptions {
	deviceOptions?: ConstructorParameters<typeof FakeHIDDevice>[0];
	flash?: Partial<FlashState>;
	journal?: JournalEntry[];
	lastWrittenLevelDb?: number | null;
	sessionWriteCount?: number;
	connect?: boolean;
	hid?: 'fake' | null;
}

export async function setup(options: SetupOptions = {}) {
	const clock = createFakeClock(0, { autoAdvance: true });
	const device = new FakeHIDDevice({ clock, ...options.deviceOptions });
	const hid = new FakeHID({ devices: [device] });
	const journal = memoryJournal(options.journal);
	const flash = memoryFlash(options.flash);
	const time = { value: T0 };
	const levels = {
		lastWrittenLevelDb: options.lastWrittenLevelDb ?? null,
		sessionWriteCount: options.sessionWriteCount ?? 0
	};
	const deps: CableServiceDeps = {
		hid: options.hid === null ? null : hid,
		journal,
		flash,
		now: () => time.value,
		lastWrittenLevelDb: () => levels.lastWrittenLevelDb,
		sessionWriteCount: () => levels.sessionWriteCount,
		clock,
		userActivation: () => ({ isActive: true })
	};
	const service = createCableService(deps);
	const written: CableWrittenDetail[] = [];
	service.events.addEventListener('cable:written', (event) => {
		written.push((event as CustomEvent<CableWrittenDetail>).detail);
	});
	if (options.connect !== false) await service.connect();
	return { clock, device, hid, journal, flash, time, levels, service, written };
}

export function bytesOf(device: FakeHIDDevice): number[][] {
	return device.sent.map(({ bytes }) => [...bytes]);
}
