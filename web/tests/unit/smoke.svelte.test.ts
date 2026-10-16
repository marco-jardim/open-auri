import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import Smoke from './Smoke.svelte';

test('renders a Svelte component in Chromium', async () => {
	render(Smoke);
	await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('open-auri');
});
