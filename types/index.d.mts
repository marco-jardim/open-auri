/** Public core API: area namespaces plus frequently used, collision-free entry points. @module */
export * as dsp from './dsp/index.mjs';
export * as safety from './safety/index.mjs';
export * as share from './share/index.mjs';
export * as io from './io/index.mjs';
export * as solver from './solver/index.mjs';
export * as catalog from './catalog/index.mjs';
export * as transport from './transport/index.mjs';
export * as policy from './policy/index.mjs';
export * as meter from './meter/index.mjs';
export { encodePayload, encodeReports, commitReport, magnitudeDb, levelDb } from './dsp/index.mjs';
export { gate, gateForWrite, autoPreamp } from './safety/index.mjs';
export { encodeS1, decodeS1, curveId, validateEnvelope } from './share/index.mjs';
export { parseEqualizerApo, serializeEqualizerApo } from './io/index.mjs';
export { solvePeq } from './solver/index.mjs';
export { OFFICIAL_PRESETS, NEUTRO, PADRAO_AURI } from './catalog/index.mjs';
export { writeCurve, requestCable } from './transport/index.mjs';
