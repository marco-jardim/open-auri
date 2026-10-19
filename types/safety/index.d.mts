export { levelDb, MEAN_FREQUENCIES, sectionDb } from "../dsp/level.mjs";
export { THRESHOLDS, PROVENANCE, YOLO_THRESHOLDS } from "./thresholds.mjs";
export { GRID_INTERVALS, poleRadius, sectionPeaks, sectionAnalysis, autoPreampForSection, gate, gateForWrite, gateProfile, isWaivable, YOLO_WAIVABLE, HARD_REASONS, CODEC_PREAMP_FLOOR_DB, YOLO_PREAMP_MAX_DB, autoPreamp } from "./gate.mjs";
export { SOFT_RANGES, ABS_RANGES, EXPERIMENTAL_KINDS, LAYER_KINDS, GRID_STEPS, isKindAllowed, isExperimentalKind, roundToGrid, clampToAbs, interpolateLinear, interpolateBand, boundarySearch, snapToGridAccepted } from "./policy.mjs";
