import { levelDb } from 'open-auri/dsp';
import type { AudioEngine, PreviewChain } from '#lib/audio/engine.ts';
import {
	getReference,
	tap,
	type MeterSource,
	type MeterTap,
	type VuReference
} from '#lib/audio/meters.ts';
import type { Track } from './comparison.ts';

type Engine = Pick<AudioEngine, 'buildChain' | 'matchGains' | 'sharedProtection'>;
type TapHandle = Pick<MeterTap, 'disconnect' | 'subscribe'>;
type TapFactory = (node: AudioNode) => Promise<TapHandle>;
interface RecordEntry {
	signature: string;
	chain: PreviewChain;
	meter: TapHandle | null;
	loading: Promise<void> | null;
}

/**
 * Owns chains, never sources. A/B only changes gains on the shared engine's existing fan-out.
 * Every chain stays silent until `setAudible(true)` (the page's own Play): building chains, or
 * the engine having been left playing by another page, never makes a lane audible.
 * `reference` gives the 0 VU alignment for new taps (the app's `meterRef`).
 *
 * Protection (C1): the armed lanes share one preview protection (`engine.sharedProtection`), as
 * `createAB` gives a pair. When any armed curve fails the standard gate (or is louder than it
 * allows), every armed lane gets the same normalize gain and limiter, so a YOLO-only lane plays
 * at the level the A/B match gives it instead of several dB below the others. The gain comes
 * from the untrimmed peaks: the level-match trims are ≤ 0 and change with the pair without a
 * rebuild, so no lane peaks above -1 dBFS whatever its trim. A change of that protection (a lane
 * armed, disarmed or edited) rebuilds every lane, replacements first.
 */
export function createTrackChains(
	engine: Engine,
	onMeter: (id: number, meter: MeterSource | null) => void,
	makeTap?: TapFactory,
	reference: () => VuReference = getReference
) {
	const meterTap: TapFactory =
		makeTap ?? ((node) => tap(node, { kinds: ['vu'], reference: reference() }));
	const records = new Map<number, RecordEntry>();
	let tracks: readonly Track[] = [];
	let selected = 1;
	let pair: readonly [number, number] = [1, 2];
	let matched = true;
	let disposed = false;
	let audible = false;
	let sequence = 0;

	/**
	 * Releases a record already taken out of `records` (its meter and chain). The lane's meter is
	 * cleared at once; a replacement's tap only reports later (asynchronously), never stale.
	 */
	function release(id: number, record: RecordEntry) {
		onMeter(id, null);
		record.meter?.disconnect();
		record.chain.dispose();
	}

	function remove(id: number, record: RecordEntry) {
		records.delete(id);
		release(id, record);
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
				?.chain.setGain(
					trim,
					audible && track.id === selected && !track.mute && (!solo || track.solo)
				);
		}
	}

	return {
		async sync(next: readonly Track[]) {
			if (disposed) return;
			tracks = next;
			const armed = next.filter((item) => item.armed);
			// One protection for every armed lane (or none): see above.
			const protect = engine.sharedProtection(armed.map((track) => track.curve));
			const signatureOf = (track: Track) => JSON.stringify([track.curve, protect ?? null]);
			const stale: [number, RecordEntry][] = [];
			for (const [id, record] of records) {
				const track = armed.find((item) => item.id === id);
				if (!track || signatureOf(track) !== record.signature) {
					records.delete(id);
					stale.push([id, record]);
				}
			}
			const pending: Promise<void>[] = [];
			for (const track of armed) {
				let record = records.get(track.id);
				if (!record) {
					const chain = engine.buildChain(track.curve.bands, track.curve.preampDb, {
						id: `comparar-${track.id}-${++sequence}`,
						experimental: true,
						on: false,
						...(protect ? { protect } : {})
					});
					record = { signature: signatureOf(track), chain, meter: null, loading: null };
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
				entry.loading = meterTap(entry.chain.stages.at(-1) ?? entry.chain.preamp)
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
			// Stale chains go only once their replacements exist: a paused session (SEEK.2) ends
			// when its last chain is disposed, so an edit while paused must never empty the set.
			for (const [id, record] of stale) release(id, record);
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
		/** True only from the page's own Play; false silences every lane (chains are kept). */
		setAudible(on: boolean) {
			if (disposed) return;
			audible = on;
			gains();
		},
		audible: () => audible,
		dispose() {
			disposed = true;
			audible = false;
			for (const [id, record] of records) remove(id, record);
		}
	};
}
