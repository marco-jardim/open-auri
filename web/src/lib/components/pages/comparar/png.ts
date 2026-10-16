/** Loaded only for a PNG download; the SVG preview needs no canvas code. */
export async function comparisonPng(svg: Blob): Promise<Blob> {
	const url = URL.createObjectURL(svg);
	try {
		const image = new Image();
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () => reject(new Error('Could not render comparison SVG'));
			image.src = url;
		});
		const canvas = document.createElement('canvas');
		canvas.width = image.naturalWidth * 2;
		canvas.height = image.naturalHeight * 2;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas is unavailable');
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((value) => {
				if (value) resolve(value);
				else reject(new Error('Could not encode PNG'));
			}, 'image/png')
		);
	} finally {
		URL.revokeObjectURL(url);
	}
}
