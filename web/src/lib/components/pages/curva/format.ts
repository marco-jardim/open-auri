// Building an Intl.NumberFormat costs far more than formatting with one, and the scope formats
// several readouts on every frame of a drag: formatters are reused per locale and options (a
// formatter is immutable, so the text is the same). A locale Intl refuses still throws each time.
const FORMATTER_LIMIT = 32;
const formatters = new Map<string, Intl.NumberFormat>();

function formatter(
	locale: string,
	options: { minimumFractionDigits?: number; maximumFractionDigits: number }
): Intl.NumberFormat {
	const key = `${locale}|${options.minimumFractionDigits ?? ''}|${options.maximumFractionDigits}`;
	let found = formatters.get(key);
	if (!found) {
		found = new Intl.NumberFormat(locale, options);
		if (formatters.size >= FORMATTER_LIMIT) formatters.clear();
		formatters.set(key, found);
	}
	return found;
}

/** Locale-aware numbers: pt-BR decimal comma, en-US point, always a real minus sign "−". */
export function formatNumber(value: number, locale: string, digits = 1): string {
	if (!Number.isFinite(value)) return '?';
	return formatter(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })
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

/** Short frequency for sentences: "2,2 kHz", "16 kHz", "250 Hz". */
export function formatHzCompact(value: number, locale: string): string {
	if (!Number.isFinite(value)) return '';
	if (value >= 1000) {
		const text = formatter(locale, { maximumFractionDigits: 1 }).format(value / 1000);
		return `${text} kHz`;
	}
	return `${Math.round(value)} Hz`;
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
