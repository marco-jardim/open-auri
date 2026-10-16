/**
 * @param {string} id
 * @returns {Preset | null}
 */
export function getPreset(id: string): Preset | null;
/**
 * Official curves in display order; unknown groups yield a frozen empty array.
 * @param {string} group
 * @returns {readonly OfficialPreset[]}
 */
export function presetsByGroup(group: string): readonly OfficialPreset[];
/** Official display order; coefficients must never be sorted or rounded. */
export const OFFICIAL_PRESETS: readonly Readonly<Readonly<Readonly<{
    id: string;
    label: string;
    preampDb: number;
    bands: readonly Readonly<Band>[];
    crc: number;
}> & {
    group: PresetGroup;
    order: number;
    description: string;
    descriptionEn: string | null;
    descriptionAttribution: "kuba";
    licenseStatus: "a confirmar";
}>>[];
/** @type {NeutralPreset} */
export const NEUTRO: NeutralPreset;
/** Rescue default: the very same object as the official Auri entry. */
export const PADRAO_AURI: Readonly<Readonly<Readonly<{
    id: string;
    label: string;
    preampDb: number;
    bands: readonly Readonly<Band>[];
    crc: number;
}> & {
    group: PresetGroup;
    order: number;
    description: string;
    descriptionEn: string | null;
    descriptionAttribution: "kuba";
    licenseStatus: "a confirmar";
}>>;
export const PADRAO_AURI_CREDIT: "filtros do Leonardo (segundo coment\u00E1rio no c\u00F3digo da p\u00E1gina oficial)";
/**
 * All official curves plus Neutro, sharing their frozen object references.
 * @type {Readonly<Record<string, Preset>>}
 */
export const PRESETS_BY_ID: Readonly<Record<string, Preset>>;
export type Band = import("../dsp/eq0xcb.mjs").Band;
export type PresetGroup = "preferencia" | "referencia";
export type CurvePreset = Readonly<{
    id: string;
    label: string;
    preampDb: number;
    bands: readonly Readonly<Band>[];
    crc: number;
}>;
export type OfficialPreset = Readonly<CurvePreset & {
    group: PresetGroup;
    order: number;
    description: string;
    descriptionEn: string | null;
    descriptionAttribution: "kuba";
    licenseStatus: "a confirmar";
}>;
export type NeutralPreset = Readonly<CurvePreset & {
    id: "neutro";
    label: "Neutro";
}>;
export type Preset = OfficialPreset | NeutralPreset;
