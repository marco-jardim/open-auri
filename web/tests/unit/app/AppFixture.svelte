<script lang="ts">
	import { onMount } from 'svelte';
	import { setAppContext, type ClientApp, type ClientAppOptions } from '#lib/app/index.ts';
	import ConsumerFixture from './ConsumerFixture.svelte';
	let {
		options,
		onready,
		onconsumer
	}: {
		options: ClientAppOptions;
		onready: (app: ClientApp) => void;
		onconsumer: (app: ClientApp) => void;
	} = $props();
	const context = setAppContext();
	onMount(() => {
		// FUX.2: the runtime is a dynamic chunk, so the mount resolves after the first render.
		void context.mount(options).then((app) => {
			if (!app) throw new Error('Browser app not initialized');
			onready(app);
		});
		return () => context.dispose();
	});
</script>

<ConsumerFixture onclient={onconsumer} />
