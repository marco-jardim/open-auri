// The core's classification step with the write gate as a parameter (`classifyWith`, internal to
// src/safety/classify-core.mjs and not exported by `open-auri/safety`, whose `classifyCurve`
// always uses the core's own gate). The server classifies through it so that every gate run of a
// classification goes through the caller's (counted) gate and the standard verdict already in
// hand is reused (gate.ts `runGate`). Re-exported by relative path; types in classify-core.d.mts.
export { classifyWith } from '../../../../../src/safety/classify-core.mjs';
