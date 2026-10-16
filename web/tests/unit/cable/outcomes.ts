import type { Written } from '#lib/cable/types.ts';

/** Completed transport result at the UI boundary; no physical device is involved. */
export function writtenOutcome(status: Written['status']): Written {
	const interrupted = status === 'interrupted';
	return {
		status,
		simulated: status === 'simulated',
		result: {
			status: interrupted ? 'interrupted' : 'ok',
			crc: 0x4fff,
			startedAt: 0,
			finishedAt: interrupted ? 32 : 294,
			reportsSent: interrupted ? 2 : 9,
			committed: !interrupted
		},
		entry: null,
		deviceLabel: 'Test cable',
		crc: 0x4fff,
		levelDb: interrupted ? null : -0.5
	};
}
