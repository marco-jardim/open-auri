/** Golden CRCs from T2.T, deliberately not calculated from the implementation under test. */
export const officialPresets = [
	{ id: 'padrao', label: 'Auri', crc: '0x1970' },
	{ id: 'pref6', label: 'Natural', crc: '0x85B8' },
	{ id: 'emv', label: 'Em V', crc: '0x14A9' },
	{ id: 'basshead', label: 'Basshead', crc: '0x932B' },
	{ id: 'energico', label: 'Enérgico', crc: '0xBE4E' },
	{ id: 'musical', label: 'Musical', crc: '0x7EA6' },
	{ id: 'analitico', label: 'Analítico', crc: '0x836C' },
	{ id: 'referencia', label: 'JM-1', crc: '0xEC19' },
	{ id: 'harman', label: 'Harman IE 2019', crc: '0xC738' },
	{ id: 'vdsf', label: 'VDSF', crc: '0x5C6A' },
	{ id: 'etymotic', label: 'Etymotic', crc: '0xB68E' }
] as const;

export const neutralPreset = { id: 'neutro', label: 'Neutro', crc: '0x4FFF' } as const;
