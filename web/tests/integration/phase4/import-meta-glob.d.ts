// Type of Vite's `import.meta.glob` for the integration project (it does not load `vite/client`).
// Vite rewrites the call at transform time, also inside workerd; only the lazy form is used here.
interface ImportMeta {
	glob(pattern: string | readonly string[]): Record<string, () => Promise<unknown>>;
}
