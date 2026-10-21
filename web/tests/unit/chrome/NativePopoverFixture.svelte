<script lang="ts">
	import type { CableService } from '#lib/cable/service.ts';
	import CableStatus from '#lib/components/cable/CableStatus.svelte';
	import { nativeBackPopover } from '#lib/components/chrome/native-back.ts';

	let { service }: { service: CableService } = $props();
	const id = $props.id();
</script>

<!-- Same native popover and Back attachment as the layout's cable status. -->
<button type="button" popovertarget={id}>Cable status</button>
<button type="button">Outside</button>
<div {id} popover="auto" data-chrome="status" {@attach nativeBackPopover}>
	<CableStatus {service} />
</div>
