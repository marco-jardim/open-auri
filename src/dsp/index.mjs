/** DSP design, firmware encoding, response analysis and perceptual frequency grids. @module */

export {
  USB_VID,
  USB_PID,
  HID_REPORT_ID,
  SAMPLE_RATE,
  BAND_COUNT,
  PREAMBLE,
  COMMIT_COMMAND,
  PAYLOAD_SIZE,
  REPORT_SIZE,
  REPORT_COUNT,
  FILTER_KINDS,
  OFF,
  NEUTRAL_BANDS,
  designPeaking,
  designLowShelf,
  designHighShelf,
  designLowPass,
  designHighPass,
  designSection,
  checkBand,
  isStable,
  encodeSection,
  preampWord,
  crc16Ccitt,
  encodePayload,
  encodeReports,
  commitReport,
  magnitudeDb,
} from './eq0xcb.mjs';
export { GRID_MIN_HZ, GRID_MAX_HZ, GRID_POINTS, logGrid, GRID } from './grid.mjs';
export {
  Q27,
  MEAN_FREQUENCIES,
  fromWords,
  quantizedSection,
  isIdentitySection,
  sectionDb,
  sectionDbFromTerms,
  quantizedPreampDb,
  levelDb,
} from './level.mjs';
export { curveResponseDb, distance } from './distance.mjs';
export {
  ISO226_TABLE,
  equalLoudnessSpl,
  contour,
  splAtPreferred,
  loudnessCompensationDb,
  perceptualWeights,
} from './iso226.mjs';
