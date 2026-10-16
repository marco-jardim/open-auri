import { levelDb } from 'open-auri/dsp';
import type { AudioEngine, PreviewChain } from '#lib/audio/engine.ts';
import { tap, type MeterSource, type MeterTap } from '#lib/audio/meters.ts';
import type { Track } from './comparison.ts';

type Engine = Pick<AudioEngine, 'buildChain' | 'matchGains'>;
type TapHandle = Pick<MeterTap, 'disconnect' | 'subscribe'>;
type TapFactory = (node: AudioNode) => Promise<TapHandle>;
interface RecordEntry {
	signature: string;
	chain: PreviewChain;
	meter: TapHandle | null;
	loading: Promise<void> | null;
}

/** Owns chains, never sources. A/B only changes gains on the shared engine's existing fan-out. */
export function createTrackChains(
	engine: Engine,
	onMeter: (id: number, meter: MeterSource | null) => void,
	makeTap: TapFactory = (node) => tap(node, { kinds: ['vu'] })
) {
	const records = new Map<number, RecordEntry>();
	let tracks: readonly Track[] = [];
	let selected = 1;
	let pair: readonly [number, number] = [1, 2];
	let matched = true;
	let disposed = false;
	let sequence = 0;

	function remove(id: number, record: RecordEntry) {
		records.delete(id);
		onMeter(id, null);
		record.meter?.disconnect();
		record.chain.dispose();
	}

	function gains() {
		const a = tracks.find((track) => track.id === pair[0]);
		const b = tracks.find((track) => track.id === pair[1]);
		const trims =
			matched && a && b
				? engine.matchGains([
						levelDb(a.curve.bands, a.curve.preampDb),
						levelDb(b.curve.bands, b.curve.preampDb)
					])
				: [0, 0];
		const solo = tracks.some((track) => track.armed && track.solo && !track.mute);
		for (const track of tracks) {
			const trim = track.id === pair[0] ? trims[0] : track.id === pair[1] ? trims[1] : 0;
			records
				.get(track.id)
				?.chain.setGain(trim, track.id === selected && !track.mute && (!solo || track.solo));
		}
	}

	return {
		async sync(next: readonly Track[]) {
			if (disposed) return;
			tracks = next;
			for (const [id, record] of records) {
				const track = next.find((item) => item.id === id && item.armed);
				if (!track || JSON.stringify(track.curve) !== record.signature) remove(id, record);
			}
			const pending: Promise<void>[] = [];
			for (const track of next.filter((item) => item.armed)) {
				let record = records.get(track.id);
				if (!record) {
					const chain = engine.buildChain(track.curve.bands, track.curve.preampDb, {
						id: `comparar-${track.id}-${++sequence}`,
						experimental: true,
						on: false
					});
					record = { signature: JSON.stringify(track.curve), chain, meter: null, loading: null };
					records.set(track.id, record);
				}
				if (record.meter) continue;
				if (record.loading) {
					pending.push(record.loading);
					continue;
				}
				const entry = record;
				// Before the audition switch: every armed lane meters its own filtered signal,
				// even when another lane is audible. A tap is a silent analysis sink.
				entry.loading = makeTap(entry.chain.stages.at(-1) ?? entry.chain.preamp)
					.then((meter) => {
						if (disposed || records.get(track.id) !== entry) meter.disconnect();
						else {
							entry.meter = meter;
							onMeter(track.id, meter);
						}
					})
					.finally(() => {
						entry.loading = null;
					});
				pending.push(entry.loading);
			}
			gains();
			await Promise.all(pending);
		},
		select(id: number) {
			selected = id;
			gains();
		},
		configure(ids: readonly [number, number], levelMatch: boolean) {
			pair = ids;
			matched = levelMatch;
			gains();
		},
		dispose() {
			disposed = true;
			for (const [id, record] of records) remove(id, record);
		}
	};
}
