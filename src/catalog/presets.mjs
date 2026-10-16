// Official Kuba curves, copied without numeric changes from
// test/fixtures/eq0xcb.reference.json. Band order is the written order.
// Labels and pt-BR descriptions: design/mocks/v2/curva.html, const LABELS.
// Its English dictionary has no translations of these descriptions.
// Keep this a JS literal (no JSON imports) so the catalog also runs in Workers.

/**
 * @typedef {import('../dsp/eq0xcb.mjs').Band} Band
 * @typedef {'preferencia' | 'referencia'} PresetGroup
 * @typedef {Readonly<{
 *   id: string,
 *   label: string,
 *   preampDb: number,
 *   bands: readonly Readonly<Band>[],
 *   crc: number,
 * }>} CurvePreset
 * @typedef {Readonly<CurvePreset & {
 *   group: PresetGroup,
 *   order: number,
 *   description: string,
 *   descriptionEn: string | null,
 *   descriptionAttribution: 'kuba',
 *   licenseStatus: 'a confirmar',
 * }>} OfficialPreset
 * @typedef {Readonly<CurvePreset & {id: 'neutro', label: 'Neutro'}>} NeutralPreset
 * @typedef {OfficialPreset | NeutralPreset} Preset
 */

/**
 * Freeze every mutable level of a curve while preserving its metadata type.
 * @template {CurvePreset} T
 * @param {T} preset
 * @returns {Readonly<T>}
 */
function freezePreset(preset) {
  preset.bands.forEach((band) => Object.freeze(band));
  Object.freeze(preset.bands);
  return Object.freeze(preset);
}

/** Official display order; coefficients must never be sorted or rounded. */
export const OFFICIAL_PRESETS = Object.freeze(
  /** @type {OfficialPreset[]} */ ([
    {
      id: 'padrao',
      label: 'Auri',
      group: 'preferencia',
      order: 0,
      description: 'A assinatura do Auri, inspirada pela comunidade.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -2.8,
      bands: [
        { kind: 'PK', freqHz: 25, gainDb: -0.8, qFactor: 0.3 },
        { kind: 'PK', freqHz: 150, gainDb: -3, qFactor: 0.69 },
        { kind: 'PK', freqHz: 2237, gainDb: -10, qFactor: 1.41 },
        { kind: 'PK', freqHz: 4348, gainDb: -6.1, qFactor: 3 },
        { kind: 'PK', freqHz: 4958, gainDb: -8.3, qFactor: 2.72 },
        { kind: 'PK', freqHz: 7178, gainDb: -10, qFactor: 3 },
        { kind: 'PK', freqHz: 11063, gainDb: -10, qFactor: 3 },
        { kind: 'PK', freqHz: 520, gainDb: 3.1, qFactor: 0.81 },
        { kind: 'PK', freqHz: 3046, gainDb: 5.7, qFactor: 1.51 },
        { kind: 'PK', freqHz: 5995, gainDb: 3.4, qFactor: 0.59 },
      ],
      crc: 0x1970,
    },
    {
      id: 'pref6',
      label: 'Natural',
      group: 'preferencia',
      order: 1,
      description: 'Subgrave presente, médios limpos e agudos arejados.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -3,
      bands: [
        { kind: 'PK', freqHz: 25, gainDb: -2, qFactor: 0.4 },
        { kind: 'PK', freqHz: 167, gainDb: -6.2, qFactor: 0.53 },
        { kind: 'PK', freqHz: 2560, gainDb: -8, qFactor: 1.03 },
        { kind: 'PK', freqHz: 4911, gainDb: -8, qFactor: 4 },
        { kind: 'PK', freqHz: 7838, gainDb: -6.7, qFactor: 4 },
        { kind: 'PK', freqHz: 11523, gainDb: -6.5, qFactor: 4 },
        { kind: 'PK', freqHz: 270, gainDb: 0.1, qFactor: 4 },
        { kind: 'PK', freqHz: 404, gainDb: 4.1, qFactor: 0.48 },
        { kind: 'PK', freqHz: 2930, gainDb: 7, qFactor: 2.94 },
        { kind: 'PK', freqHz: 3537, gainDb: 4.5, qFactor: 4 },
      ],
      crc: 0x85b8,
    },
    {
      id: 'emv',
      label: 'Em V',
      group: 'preferencia',
      order: 2,
      description: 'Alvo com graves e agudos levantados.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -7.8,
      bands: [
        { kind: 'PK', freqHz: 1084, gainDb: -1.1, qFactor: 3 },
        { kind: 'PK', freqHz: 1930, gainDb: -1.9, qFactor: 2.39 },
        { kind: 'PK', freqHz: 2334, gainDb: -8, qFactor: 1.93 },
        { kind: 'PK', freqHz: 4454, gainDb: -8, qFactor: 2.63 },
        { kind: 'PK', freqHz: 5568, gainDb: -4.2, qFactor: 1.55 },
        { kind: 'PK', freqHz: 7504, gainDb: -7.2, qFactor: 3 },
        { kind: 'PK', freqHz: 107, gainDb: 0.7, qFactor: 0.5 },
        { kind: 'PK', freqHz: 473, gainDb: 2.4, qFactor: 0.5 },
        { kind: 'PK', freqHz: 6814, gainDb: 7.7, qFactor: 1.48 },
        { kind: 'PK', freqHz: 8862, gainDb: 8, qFactor: 3 },
      ],
      crc: 0x14a9,
    },
    {
      id: 'basshead',
      label: 'Basshead',
      group: 'preferencia',
      order: 3,
      description: 'Para os amantes de graves.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -5.7,
      bands: [
        { kind: 'PK', freqHz: 4613, gainDb: -12, qFactor: 2.5 },
        { kind: 'PK', freqHz: 2246, gainDb: -12, qFactor: 1.31 },
        { kind: 'PK', freqHz: 6746, gainDb: -7.9, qFactor: 2.5 },
        { kind: 'PK', freqHz: 1122, gainDb: -2.6, qFactor: 1.73 },
        { kind: 'PK', freqHz: 10302, gainDb: -6.1, qFactor: 2.5 },
        { kind: 'PK', freqHz: 20, gainDb: -5, qFactor: 0.42 },
        { kind: 'PK', freqHz: 223, gainDb: -4.9, qFactor: 0.84 },
        { kind: 'PK', freqHz: 3184, gainDb: 2.5, qFactor: 2.5 },
        { kind: 'PK', freqHz: 3116, gainDb: 9.2, qFactor: 0.3 },
        { kind: 'LS', freqHz: 286, gainDb: 8.2, qFactor: 0.47 },
      ],
      crc: 0x932b,
    },
    {
      id: 'energico',
      label: 'Enérgico',
      group: 'preferencia',
      order: 4,
      description: 'Sonoridade intensa, pensada para rock.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -3.3,
      bands: [
        { kind: 'PK', freqHz: 25, gainDb: -3.1, qFactor: 0.5 },
        { kind: 'PK', freqHz: 97, gainDb: -1.4, qFactor: 0.68 },
        { kind: 'PK', freqHz: 2445, gainDb: -8, qFactor: 0.87 },
        { kind: 'PK', freqHz: 4725, gainDb: -8, qFactor: 3 },
        { kind: 'PK', freqHz: 6920, gainDb: -8, qFactor: 3 },
        { kind: 'PK', freqHz: 12439, gainDb: -8, qFactor: 1.96 },
        { kind: 'PK', freqHz: 1838, gainDb: 5, qFactor: 0.92 },
        { kind: 'PK', freqHz: 2904, gainDb: 4.5, qFactor: 2.62 },
        { kind: 'PK', freqHz: 3665, gainDb: 3.7, qFactor: 3 },
        { kind: 'PK', freqHz: 8376, gainDb: 8, qFactor: 2.42 },
      ],
      crc: 0xbe4e,
    },
    {
      id: 'musical',
      label: 'Musical',
      group: 'preferencia',
      order: 5,
      description: 'Graves fortes, médios comedidos e agudos delicados.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -2.3,
      bands: [
        { kind: 'PK', freqHz: 24, gainDb: -3.2, qFactor: 0.1 },
        { kind: 'PK', freqHz: 2277, gainDb: -8, qFactor: 1.69 },
        { kind: 'PK', freqHz: 4588, gainDb: -9.4, qFactor: 2.8 },
        { kind: 'PK', freqHz: 5979, gainDb: -3.8, qFactor: 2 },
        { kind: 'PK', freqHz: 7184, gainDb: -3.2, qFactor: 3 },
        { kind: 'PK', freqHz: 10638, gainDb: -10.4, qFactor: 3 },
        { kind: 'PK', freqHz: 840, gainDb: 2.2, qFactor: 1.54 },
        { kind: 'PK', freqHz: 1393, gainDb: 2, qFactor: 1.85 },
        { kind: 'PK', freqHz: 3224, gainDb: 1.1, qFactor: 3 },
        { kind: 'PK', freqHz: 15808, gainDb: 2.2, qFactor: 2.5 },
      ],
      crc: 0x7ea6,
    },
    {
      id: 'analitico',
      label: 'Analítico',
      group: 'preferencia',
      order: 6,
      description: 'Para quem prioriza detalhamento e clareza.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -0.8,
      bands: [
        { kind: 'LS', freqHz: 120, gainDb: -9.3, qFactor: 0.44 },
        { kind: 'PK', freqHz: 7007, gainDb: -9.1, qFactor: 2.5 },
        { kind: 'PK', freqHz: 147, gainDb: -3.5, qFactor: 0.48 },
        { kind: 'PK', freqHz: 4561, gainDb: -12, qFactor: 2.5 },
        { kind: 'PK', freqHz: 2198, gainDb: -12, qFactor: 1.42 },
        { kind: 'PK', freqHz: 255, gainDb: -0.4, qFactor: 1.78 },
        { kind: 'PK', freqHz: 11291, gainDb: -7.8, qFactor: 2.5 },
        { kind: 'PK', freqHz: 1093, gainDb: -2.7, qFactor: 1.17 },
        { kind: 'PK', freqHz: 3226, gainDb: 6.2, qFactor: 0.3 },
        { kind: 'PK', freqHz: 3028, gainDb: 1.8, qFactor: 2.5 },
      ],
      crc: 0x836c,
    },
    {
      id: 'referencia',
      label: 'JM-1',
      group: 'referencia',
      order: 7,
      description: 'Sonoridade fiel à JM-1.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -4,
      bands: [
        { kind: 'LS', freqHz: 297, gainDb: -3.4, qFactor: 0.81 },
        { kind: 'PK', freqHz: 11107, gainDb: -4.8, qFactor: 2.5 },
        { kind: 'PK', freqHz: 1027, gainDb: -1.7, qFactor: 1.98 },
        { kind: 'PK', freqHz: 20, gainDb: -3.6, qFactor: 0.57 },
        { kind: 'PK', freqHz: 7055, gainDb: -3.8, qFactor: 2.5 },
        { kind: 'PK', freqHz: 4588, gainDb: -8, qFactor: 2.5 },
        { kind: 'PK', freqHz: 2208, gainDb: -8.2, qFactor: 1.83 },
        { kind: 'PK', freqHz: 595, gainDb: 3.5, qFactor: 0.42 },
        { kind: 'PK', freqHz: 3144, gainDb: 5.6, qFactor: 1.69 },
        { kind: 'PK', freqHz: 3031, gainDb: 0.5, qFactor: 2.5 },
      ],
      crc: 0xec19,
    },
    {
      id: 'harman',
      label: 'Harman IE 2019',
      group: 'referencia',
      order: 8,
      description: 'A curva de preferência mais estudada do mundo.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -0.5,
      bands: [
        { kind: 'LS', freqHz: 199, gainDb: -5.6, qFactor: 0.94 },
        { kind: 'PK', freqHz: 399, gainDb: -1.4, qFactor: 1.62 },
        { kind: 'PK', freqHz: 2271, gainDb: -8, qFactor: 1.32 },
        { kind: 'PK', freqHz: 256, gainDb: -4.2, qFactor: 1.17 },
        { kind: 'PK', freqHz: 7566, gainDb: -7.6, qFactor: 0.43 },
        { kind: 'PK', freqHz: 4662, gainDb: -6.8, qFactor: 2.5 },
        { kind: 'PK', freqHz: 9138, gainDb: 3.8, qFactor: 2.5 },
        { kind: 'PK', freqHz: 3318, gainDb: 7.8, qFactor: 1.32 },
        { kind: 'PK', freqHz: 5767, gainDb: 5.8, qFactor: 2.5 },
        { kind: 'PK', freqHz: 3209, gainDb: 1.1, qFactor: 1.33 },
      ],
      crc: 0xc738,
    },
    {
      id: 'vdsf',
      label: 'VDSF',
      group: 'referencia',
      order: 9,
      description: 'Meio-termo entre campo difuso e Harman, com graves discretos.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -2.2,
      bands: [
        { kind: 'PK', freqHz: 25, gainDb: -8, qFactor: 0.5 },
        { kind: 'PK', freqHz: 80, gainDb: -5, qFactor: 0.52 },
        { kind: 'PK', freqHz: 210, gainDb: -2, qFactor: 0.79 },
        { kind: 'PK', freqHz: 1286, gainDb: -5.9, qFactor: 1.34 },
        { kind: 'PK', freqHz: 1978, gainDb: -7.4, qFactor: 1.67 },
        { kind: 'PK', freqHz: 2375, gainDb: -5.4, qFactor: 2.4 },
        { kind: 'PK', freqHz: 4384, gainDb: -4.7, qFactor: 3 },
        { kind: 'PK', freqHz: 4833, gainDb: -6, qFactor: 3 },
        { kind: 'PK', freqHz: 7252, gainDb: -7.6, qFactor: 3 },
        { kind: 'PK', freqHz: 1718, gainDb: 8, qFactor: 0.5 },
      ],
      crc: 0x5c6a,
    },
    {
      id: 'etymotic',
      label: 'Etymotic',
      group: 'referencia',
      order: 10,
      description: 'Graves contidos e muita definição nos médios e agudos.',
      descriptionEn: null,
      descriptionAttribution: 'kuba',
      licenseStatus: 'a confirmar',
      preampDb: -2.2,
      bands: [
        { kind: 'PK', freqHz: 25, gainDb: -8, qFactor: 0.97 },
        { kind: 'PK', freqHz: 45, gainDb: -8, qFactor: 0.5 },
        { kind: 'PK', freqHz: 105, gainDb: -5.3, qFactor: 0.51 },
        { kind: 'PK', freqHz: 226, gainDb: -1.4, qFactor: 0.91 },
        { kind: 'PK', freqHz: 2190, gainDb: -8, qFactor: 1.39 },
        { kind: 'PK', freqHz: 4276, gainDb: -5, qFactor: 3 },
        { kind: 'PK', freqHz: 4847, gainDb: -7.2, qFactor: 3 },
        { kind: 'PK', freqHz: 7260, gainDb: -6.8, qFactor: 3 },
        { kind: 'PK', freqHz: 785, gainDb: 1.8, qFactor: 1.42 },
        { kind: 'PK', freqHz: 3120, gainDb: 6.5, qFactor: 1.01 },
      ],
      crc: 0xb68e,
    },
  ]).map(freezePreset),
);

/** @type {NeutralPreset} */
export const NEUTRO = freezePreset({
  id: 'neutro',
  label: 'Neutro',
  preampDb: -0.5,
  bands: [
    { kind: 'OFF' },
    { kind: 'OFF' },
    { kind: 'OFF' },
    { kind: 'OFF' },
    { kind: 'OFF' },
    { kind: 'OFF' },
    { kind: 'OFF' },
    { kind: 'OFF' },
    { kind: 'OFF' },
    { kind: 'OFF' },
  ],
  crc: 0x4fff,
});

/** Rescue default: the very same object as the official Auri entry. */
export const PADRAO_AURI = OFFICIAL_PRESETS[0];

export const PADRAO_AURI_CREDIT =
  'filtros do Leonardo (segundo comentário no código da página oficial)';

/**
 * All official curves plus Neutro, sharing their frozen object references.
 * @type {Readonly<Record<string, Preset>>}
 */
export const PRESETS_BY_ID = Object.freeze(
  Object.fromEntries([...OFFICIAL_PRESETS, NEUTRO].map((preset) => [preset.id, preset])),
);

/**
 * @param {string} id
 * @returns {Preset | null}
 */
export function getPreset(id) {
  return Object.hasOwn(PRESETS_BY_ID, id) ? PRESETS_BY_ID[id] : null;
}

/**
 * Official curves in display order; unknown groups yield a frozen empty array.
 * @param {string} group
 * @returns {readonly OfficialPreset[]}
 */
export function presetsByGroup(group) {
  return Object.freeze(OFFICIAL_PRESETS.filter((preset) => preset.group === group));
}
