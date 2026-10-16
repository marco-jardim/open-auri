import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import paraglideOptions from './project.inlang/paraglide.config.mjs';

const PENDING_ROUTES = new Set(['/comunidade']);

export default defineConfig({
	envDir: '..',
	envPrefix: 'PUBLIC_',
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			prerender: {
				// Routes linked from the shared chrome whose pages land in a later task or phase. A 404
				// on any other path fails the build. Shrinks as pages are implemented.
				handleHttpError: ({ status, path, message }) => {
					if (status === 404 && PENDING_ROUTES.has(path)) return;
					throw new Error(message);
				}
			},
			env: { dir: '..' },
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:', 'blob:'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'media-src': ['self', 'blob:'],
					'worker-src': ['self', 'blob:'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self']
				}
			}
		}),

		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			...paraglideOptions
		})
	],
	test: {
		expect: { requireAssertions: true },
		coverage: {
			provider: 'v8',
			include: ['src/lib/**'],
			exclude: ['src/lib/paraglide/**'],
			reporter: ['text', 'json-summary'],
			// Coverage (and therefore thresholds) is enabled only by test:coverage.
			thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 }
		},
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'unit',
					environment: 'node',
					include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
					exclude: ['**/*.svelte.test.ts']
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'component',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['tests/unit/**/*.svelte.test.ts', 'src/**/*.svelte.test.ts'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'integration',
					environment: 'node',
					include: ['tests/integration/**/*.test.ts']
				}
			}
		]
	}
});
