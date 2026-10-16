import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e',
	workers: '50%',
	retries: process.env.CI ? 2 : 0,
	use: { baseURL: 'http://localhost:4173', trace: 'on-first-retry' },
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		reuseExistingServer: !process.env.CI,
		timeout: 180000
	},
	projects: [
		{
			name: 'desktop',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
		},
		{
			name: 'mobile',
			use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }
		}
	]
});
