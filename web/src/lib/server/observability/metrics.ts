// Analytics Engine metrics (T5.2). One data point per event, fixed schema, never PII:
//
//   indexes[0] = event name (the sampling key)
//   blobs      = [event, label, detail]
//   doubles    = [count (always 1), value (latency ms for job runs, HTTP status for 5xx, else 0)]
//
// Events and their labels (all fixed codes, never user input, ids, e-mails, IPs or tokens):
//   gate_rejected  label = gate reason code       detail = publication path (publish|version|fork)
//   signup         label = method ("email")       detail = ""
//   email_failed   label = template id            detail = error kind
//   http_5xx       label = route id               detail = error code or error class
//   report         label = target kind            detail = report reason code
//   job_run        label = job name               detail = "ok" | "failed"   value = duration ms
//
// The binding (`METRICS`, dataset open_auri_metrics / open_auri_metrics_staging) is optional: when
// it is absent (tests, local dev, a config rendered before T5.2) every helper is a no-op. A write
// never throws into the caller. Shared with the jobs Worker (workers/jobs/src/jobs/registry.ts),
// so this module has no `$app/*` or SvelteKit imports and its own structural dataset type.

/** Structural subset of `AnalyticsEngineDataset` (web and jobs type it from different packages). */
export interface MetricsDataset {
	writeDataPoint(point?: {
		indexes?: ((ArrayBuffer | string) | null)[];
		doubles?: number[];
		blobs?: ((ArrayBuffer | string) | null)[];
	}): void;
}

export const METRIC_EVENTS = [
	'gate_rejected',
	'signup',
	'email_failed',
	'http_5xx',
	'report',
	'job_run'
] as const;
export type MetricEvent = (typeof METRIC_EVENTS)[number];

/** The exact shape handed to `writeDataPoint` (exported for tests and the docs). */
export interface MetricPoint {
	indexes: [MetricEvent];
	blobs: [MetricEvent, string, string];
	doubles: [number, number];
}

/** Longest label kept; longer or non-code values become `other`. */
export const LABEL_MAX = 96;
const LABEL = /^[A-Za-z0-9_.:/[\]()-]*$/;
/** Shapes that look like personal data even when made of allowed characters. */
const LOOKS_PERSONAL = /@|\d{6,}/;

/**
 * Keeps a fixed code (route id, reason code, job name) and replaces anything else with `other`,
 * so a caller cannot put free text, an e-mail or an id into a metric by mistake.
 */
export function metricLabel(value: string | null | undefined): string {
	if (value === null || value === undefined) return '';
	if (value.length > LABEL_MAX || !LABEL.test(value) || LOOKS_PERSONAL.test(value)) return 'other';
	return value;
}

/** Duck-typed check: anything with `writeDataPoint` is a dataset; anything else is "absent". */
export function isMetricsDataset(value: unknown): value is MetricsDataset {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof Reflect.get(value, 'writeDataPoint') === 'function'
	);
}

/** `METRICS` of a raw Worker env (`platform.env` or the jobs `env`), or null when absent. */
export function metricsFromEnv(env: unknown): MetricsDataset | null {
	if (typeof env !== 'object' || env === null) return null;
	const binding: unknown = Reflect.get(env, 'METRICS');
	return isMetricsDataset(binding) ? binding : null;
}

/** Builds the data point of one event (pure; exported for tests). */
export function metricPoint(
	event: MetricEvent,
	label: string | null | undefined,
	detail: string | null | undefined,
	value = 0
): MetricPoint {
	return {
		indexes: [event],
		blobs: [event, metricLabel(label), metricLabel(detail)],
		doubles: [1, Number.isFinite(value) ? value : 0]
	};
}

function write(dataset: MetricsDataset | null | undefined, point: MetricPoint): void {
	if (!dataset) return;
	try {
		dataset.writeDataPoint(point);
	} catch (error) {
		// Metrics are best effort; the line carries the error class only.
		console.warn(
			JSON.stringify({
				event: 'metrics.write_failed',
				metric: point.indexes[0],
				error: error instanceof Error ? error.name : typeof error
			})
		);
	}
}

/** Most reason codes recorded for one rejection (one data point per distinct reason). */
export const GATE_REASONS_MAX = 8;

export type PublicationPath = 'publish' | 'version' | 'fork';

/** A publication refused by the gate (server publication path), one point per reason code. */
export function recordGateRejection(
	dataset: MetricsDataset | null | undefined,
	reasons: readonly string[],
	path: PublicationPath
): void {
	if (!dataset) return;
	const distinct = [...new Set(reasons)].slice(0, GATE_REASONS_MAX);
	if (distinct.length === 0) distinct.push('unspecified');
	for (const reason of distinct) write(dataset, metricPoint('gate_rejected', reason, path));
}

/** A successful sign-up. */
export function recordSignup(dataset: MetricsDataset | null | undefined, method = 'email'): void {
	write(dataset, metricPoint('signup', method, ''));
}

/** A transactional e-mail that could not be sent (template id and error kind only). */
export function recordEmailFailure(
	dataset: MetricsDataset | null | undefined,
	template: string,
	kind: string
): void {
	write(dataset, metricPoint('email_failed', template, kind));
}

/** A 5xx answered by an API route (route id, never the URL). */
export function recordServerError(
	dataset: MetricsDataset | null | undefined,
	route: string | null,
	code: string,
	status: number
): void {
	write(dataset, metricPoint('http_5xx', route ?? 'unknown', code, status));
}

/** A report filed (target kind and reason code; never the target or the reporter). */
export function recordReport(
	dataset: MetricsDataset | null | undefined,
	targetKind: string,
	reason: string
): void {
	write(dataset, metricPoint('report', targetKind, reason));
}

/** One job run of the jobs Worker. */
export function recordJobRun(
	dataset: MetricsDataset | null | undefined,
	job: string,
	ok: boolean,
	ms: number
): void {
	write(dataset, metricPoint('job_run', job, ok ? 'ok' : 'failed', Math.max(0, Math.round(ms))));
}
