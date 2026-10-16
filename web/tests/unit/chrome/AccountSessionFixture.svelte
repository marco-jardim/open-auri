<script lang="ts">
	import {
		AccountEntry,
		AccountSession,
		type AccountProbe,
		type AccountSummary
	} from '#lib/components/chrome/index.ts';

	interface Props {
		user: AccountSummary | null;
		resolved: boolean;
		path: string;
		probe: AccountProbe;
	}

	let { user, resolved, path, probe }: Props = $props();
	const session = new AccountSession(
		() => ({ user, resolved, path }),
		(signal) => probe(signal)
	);
</script>

<AccountEntry user={session.current} currentPath={path} pending={!session.known} />
<output data-known={session.known}></output>
