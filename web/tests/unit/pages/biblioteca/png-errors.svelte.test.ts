import { afterEach, expect, test, vi } from 'vitest';
import { sheetPng } from '#lib/components/pages/biblioteca/sheet-export.ts';

afterEach(() => vi.restoreAllMocks());

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';

test('a sheet decode failure releases its source URL', async () => {
	const revoke = vi.spyOn(URL, 'revokeObjectURL');
	await expect(sheetPng('invalid SVG')).rejects.toThrow();
	expect(revoke).toHaveBeenCalledOnce();
});

test('a missing sheet canvas reports an error and releases its source URL', async () => {
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
	const revoke = vi.spyOn(URL, 'revokeObjectURL');
	await expect(sheetPng(svg)).rejects.toThrow('Canvas 2D unavailable');
	expect(revoke).toHaveBeenCalledOnce();
});

test('a null sheet PNG encoding reports an error and releases its source URL', async () => {
	vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => callback(null));
	const revoke = vi.spyOn(URL, 'revokeObjectURL');
	await expect(sheetPng(svg)).rejects.toThrow('PNG export failed');
	expect(revoke).toHaveBeenCalledOnce();
});
