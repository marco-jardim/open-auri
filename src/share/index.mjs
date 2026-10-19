/** Compact S1 curve encoding, stable identifiers and validated sharing envelopes. @module */

export {
  S1_VERSION,
  S1_VERSIONS,
  S1_FREQ_MAX,
  S1_VARIANT_PARAMETRIC,
  S1_BYTES,
  S1_LENGTH,
  S1_KIND_CODES,
  S1Error,
  encodeS1,
  decodeS1,
  canonKey,
  curveId,
} from './s1.mjs';
export {
  EnvelopeError,
  LABEL_COUNT,
  LABEL_MAX,
  envelopeFormat,
  normalizeText,
  normalizeLabels,
  normalizeEnvelope,
  validateEnvelope,
  serializeEnvelope,
  parseEnvelope,
} from './envelope.mjs';
