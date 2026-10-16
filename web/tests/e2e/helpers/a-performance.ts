import type { Page } from '@playwright/test';

interface LongTaskSample {
	startTime: number;
	duration: number;
}

interface DragRecording {
	observer: PerformanceObserver;
	frame: number;
	startedAt: number;
	previousFrame: number | null;
	deltas: number[];
	tasks: LongTaskSample[];
}

type DragWindow = Window & { __oaPartADrag?: DragRecording };

export async function startDragRecording(page: Page): Promise<void> {
	await page.evaluate(() => {
		const target = window as DragWindow;
		const tasks: LongTaskSample[] = [];
		const startedAt = performance.now();
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (entry.startTime >= startedAt) {
					tasks.push({ startTime: entry.startTime, duration: entry.duration });
				}
			}
		});
		observer.observe({ type: 'longtask' });
		const recording: DragRecording = {
			observer,
			frame: 0,
			startedAt,
			previousFrame: null,
			deltas: [],
			tasks
		};
		const sample = (timestamp: number) => {
			if (recording.previousFrame !== null) {
				recording.deltas.push(timestamp - recording.previousFrame);
			}
			recording.previousFrame = timestamp;
			recording.frame = requestAnimationFrame(sample);
		};
		target.__oaPartADrag = recording;
		recording.frame = requestAnimationFrame(sample);
	});
}

export async function finishDragRecording(page: Page): Promise<{
	deltas: number[];
	tasks: LongTaskSample[];
}> {
	// Give the observer a turn to deliver work caused by pointerup/commit as well as pointermove.
	await nextFrame(page);
	await nextFrame(page);
	return page.evaluate(() => {
		const target = window as DragWindow;
		const recording = target.__oaPartADrag;
		if (!recording) throw new Error('No drag performance recording was started');
		cancelAnimationFrame(recording.frame);
		for (const entry of recording.observer.takeRecords()) {
			if (entry.startTime >= recording.startedAt) {
				recording.tasks.push({ startTime: entry.startTime, duration: entry.duration });
			}
		}
		recording.observer.disconnect();
		delete target.__oaPartADrag;
		return { deltas: recording.deltas, tasks: recording.tasks };
	});
}

export async function nextFrame(page: Page): Promise<void> {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

interface LcpRecording {
	supported: boolean;
	value: number | null;
	entries: number[];
	observer: PerformanceObserver | null;
}

type LcpWindow = Window & { __oaPartALcp?: LcpRecording };

export async function installLcpObserver(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const recording: LcpRecording = {
			supported: PerformanceObserver.supportedEntryTypes.includes('largest-contentful-paint'),
			value: null,
			entries: [],
			observer: null
		};
		(window as LcpWindow).__oaPartALcp = recording;
		if (!recording.supported) return;
		recording.observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				recording.value = entry.startTime;
				recording.entries.push(entry.startTime);
			}
		});
		recording.observer.observe({ type: 'largest-contentful-paint', buffered: true });
	});
}

export async function readLcp(page: Page): Promise<Omit<LcpRecording, 'observer'>> {
	return page.evaluate(() => {
		const recording = (window as LcpWindow).__oaPartALcp;
		if (!recording) throw new Error('LCP observer was not installed before navigation');
		for (const entry of recording.observer?.takeRecords() ?? []) {
			recording.value = entry.startTime;
			recording.entries.push(entry.startTime);
		}
		return {
			supported: recording.supported,
			value: recording.value,
			entries: recording.entries
		};
	});
}
