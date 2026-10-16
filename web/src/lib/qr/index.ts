import { renderSVG } from 'uqr';

/** uqr (MIT) owns encoding; callers never interpolate payload text into SVG markup. */
export function qrSvg(value: string): string {
	return renderSVG(value, {
		ecc: 'M',
		border: 4,
		pixelSize: 4,
		whiteColor: '#ffffff',
		blackColor: '#000000'
	});
}

/** S1 stays in the fragment, so the preset is not sent to the server. */
export function presetUrl(origin: string, code: string): string {
	const url = new URL('/', origin);
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
		throw new TypeError('Expected an HTTP(S) public origin');
	}
	url.hash = `p=${code}`;
	return url.href;
}
