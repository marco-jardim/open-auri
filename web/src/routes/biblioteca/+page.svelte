<script lang="ts">
	import { getAppContext } from '#lib/app/index.ts';
	import { PUBLIC_ORIGIN } from '#lib/config/public.ts';
	import Biblioteca from '#lib/components/pages/biblioteca/Biblioteca.svelte';

	const context = getAppContext();
	const app = $derived(context.client);
</script>

<Biblioteca {app} origin={PUBLIC_ORIGIN} />
