import type { MetricPoint } from '#lib/server/observability/index.ts';

/** A fake Analytics Engine binding (`METRICS`) that keeps every point it receives. */
export function fakeMetrics() {
	const points: MetricPoint[] = [];
	return {
		points,
		dataset: {
			writeDataPoint(point?: unknown) {
				points.push(point as MetricPoint);
			}
		}
	};
}
