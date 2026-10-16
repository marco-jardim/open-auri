/** Locale-aware numbers: pt-BR decimal comma, en-US point, always a real minus sign "−". */
export function formatNumber(value: number, locale: string, digits = 1): string {
	if (!Number.isFinite(value)) return '?';
	return new Intl.NumberFormat(locale, {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits
	})
		.format(Object.is(value, -0) ? 0 : value)
		.replaceAll('-', '−');
}

export function formatSignedDb(value: number, locale: string, digits = 1): string {
	const text = formatNumber(value, locale, digits);
	return `${value > 0 && !text.startsWith('+') ? '+' : ''}${text} dB`;
}

export function formatHz(value: number, locale: string): string {
	if (value >= 1000) return `${formatNumber(value / 1000, locale, value % 1000 === 0 ? 0 : 2)} kHz`;
	return `${formatNumber(value, locale, 0)} Hz`;
}

export function formatQ(value: number, locale: string): string {
	return formatNumber(value, locale, 2);
}

export function hex(value: number, width = 2): string {
	return (value >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

export function hexBytes(bytes: ArrayLike<number>): string {
	return Array.from(bytes, (byte) => hex(byte)).join(' ');
}

/** CRC16 stored little-endian in the last two payload bytes. */
export function payloadCrc(payload: ArrayLike<number>): string {
	const low = payload[payload.length - 2] ?? 0;
	const high = payload[payload.length - 1] ?? 0;
	return `0x${hex((high << 8) | low, 4)}`;
}
