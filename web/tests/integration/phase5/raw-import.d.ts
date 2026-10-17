// Type of Vite's `?raw` imports (the integration tsconfig does not load `vite/client`), used by
// headers.test.ts to read src/hooks.server.ts as text.
declare module '*?raw' {
	const source: string;
	export default source;
}
