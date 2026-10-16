import { expect, test } from '@playwright/test';

test('editor, presets and preview work after the first load without a network', async ({
	page,
	context
}) => {
	await page.goto('/');
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (navigator.serviceWorker.controller) return;
		await new Promise<void>((resolve) => {
			navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
		});
	});

	await context.setOffline(true);
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Curva', exact: true })).toBeVisible();
	const presets = page.getByRole('region', { name: 'Presets', exact: true });
	await expect(presets).toBeVisible();
	const auri = presets.getByRole('button', { name: 'Auri', exact: true });
	await expect(auri).toBeEnabled();
	await auri.click();
	await expect(auri).toHaveAttribute('aria-pressed', 'true');
	const preview = page.getByRole('button', { name: 'Ouvir prévia', exact: true });
	await expect(preview).toBeEnabled();
	await preview.click();
	await expect(page.getByRole('button', { name: 'Parar prévia', exact: true })).toBeVisible();
	await expect(page.getByTestId('pwa-offline-notice')).toContainText(
		'Recursos sociais precisam de conexão.'
	);

	// A route not visited while online must also be in the build's prerendered precache.
	await page.goto('/biblioteca');
	await expect(page.getByRole('heading', { name: 'Biblioteca', exact: true })).toBeVisible();
	await expect(page.getByTestId('pwa-offline-notice')).toBeVisible();

	// Unknown document URLs receive the prerendered fallback, never a cached API response.
	await page.goto('/not-in-the-offline-shell');
	await expect(
		page.getByRole('heading', { name: 'Você está sem conexão', exact: true })
	).toBeVisible();
	await page.getByRole('link', { name: 'Abrir o editor', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Curva', exact: true })).toBeVisible();
});
