// Stand-in `main` for the integration project. The real entry point (.svelte-kit/cloudflare/
// _worker.js) only exists after `vite build`; integration tests call server modules directly.
export default {
	fetch: () => new Response('Not found', { status: 404 })
} satisfies ExportedHandler<Cloudflare.Env>;
