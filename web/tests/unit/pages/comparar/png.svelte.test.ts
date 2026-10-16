import { afterEach, expect, test, vi } from 'vitest';
import { comparisonPng } from '#lib/components/pages/comparar/png.ts';

afterEach(() => vi.restoreAllMocks());

const svg = () =>
	new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], {
		type: 'image/svg+xml'
	});

test('an invalid SVG rejects and always revokes its object URL', async () => {
	const revoke = vi.spyOn(URL, 'revokeObjectURL');
	await expect(
		comparisonPng(new Blob(['not an image'], { type: 'image/svg+xml' }))
	).rejects.toThrow('Could not render comparison SVG');
	expect(revoke).toHaveBeenCalledOnce();
});

test('an unavailable canvas rejects and releases its source', async () => {
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
	const revoke = vi.spyOn(URL, 'revokeObjectURL');
	await expect(comparisonPng(svg())).rejects.toThrow('Canvas is unavailable');
	expect(revoke).toHaveBeenCalledOnce();
});

test('a null PNG encoding rejects and releases its source', async () => {
	vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(null));
	const revoke = vi.spyOn(URL, 'revokeObjectURL');
	await expect(comparisonPng(svg())).rejects.toThrow('Could not encode PNG');
	expect(revoke).toHaveBeenCalledOnce();
});
