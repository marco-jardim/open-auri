import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import paraglideOptions from './project.inlang/paraglide.config.mjs';

const PENDING_ROUTES = new Set<string>();

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
			serviceWorker: { register: false },
			prerender: {
				// Routes linked from the shared chrome whose pages land in a later task or phase. A 404
				// on any other path fails the build. Shrinks as pages are implemented.
				handleHttpError: ({ status, path, message }) => {
					if (status === 404 && PENDING_ROUTES.has(path)) return;
					throw new Error(message);
				}
			},
			env: { dir: '..' },
			// Document CSP (T5.4; reasons in docs/seguranca.md). 'auto': nonces on SSR responses,
			// sha256 hashes in a <meta> on prerendered pages. No 'unsafe-inline' for scripts or
			// <style> elements; style="" attributes (app.html wrapper, Svelte style:/style= and the
			// route announcer, all rendered as markup) are the one documented exception, via
			// style-src-attr. Every directive except script-src, style-src and style-src-attr is
			// repeated in the web/_headers policy (STATIC_DOCUMENT_CSP_DIRECTIVES in
			// src/lib/server/security/headers.ts; a unit test keeps both in sync).
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['none'],
					'script-src': ['self', 'https://challenges.cloudflare.com'],
					'style-src': ['self'],
					'style-src-attr': ['unsafe-inline'],
					'img-src': ['self', 'data:', 'blob:'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'media-src': ['self', 'blob:'],
					'worker-src': ['self'],
					'frame-src': ['https://challenges.cloudflare.com'],
					'manifest-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none']
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
		// Real Chromium + AudioWorklet startup can exceed the 1 s default poll under a loaded parallel run.
		expect: { requireAssertions: true, poll: { timeout: 5000 } },
		coverage: {
			provider: 'v8',
			include: ['src/lib/**/*.{ts,js,svelte}'],
			exclude: [
				'src/lib/paraglide/**',
				// Server modules run in workerd and are measured by test:int:coverage (plan §9, ≥ 90 %).
				'src/lib/server/**',
				// Purely decorative presentation (fixed SVG geometry or layout wrappers, no logic).
				'src/lib/components/pages/biblioteca/ReelHousing.svelte',
				'src/lib/components/pages/cabo/RackUnit.svelte',
				'src/lib/components/pages/comparar/TapeDeck.svelte'
			],
			reporter: ['text', 'json-summary'],
			// Coverage (and therefore thresholds) is enabled only by test:coverage.
			thresholds: { lines: 85, branches: 85, functions: 85, statements: 85 }
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
						// Tests read pt-BR copy; the default locale follows navigator.language (CI runs en-US).
						provider: playwright({ contextOptions: { locale: 'pt-BR' } }),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['tests/unit/**/*.svelte.test.ts', 'src/**/*.svelte.test.ts'],
					exclude: ['src/lib/server/**']
				}
			}
		]
	}
});
