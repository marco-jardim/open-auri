<script lang="ts">
	import { navigating } from '$app/state';
	import { getAppContext } from '#lib/app/index.ts';
	import Perfil from '#lib/components/pages/perfil/Perfil.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const context = getAppContext();
	const app = $derived(context.client);
</script>

<Perfil {data} {app} loading={navigating.to?.route.id === '/u/[apelido]'} />
