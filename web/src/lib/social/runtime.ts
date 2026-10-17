// Deferred social runtime (FUX.2, spec §5.3 L3). Only AccountEntry stays in the static closure;
// the social api, outbox, session, the cable outbox bridge and SocialSync are one dynamic group.
// The root layout loads it together with the app runtime and attaches the bridge before the app
// is published, so no real `cable:written` event can happen without the bridge listening.
import type * as Social from './index.ts';
import type * as Bridge from '#lib/cable/outbox-bridge.ts';
import type SocialSyncComponent from '#lib/components/social/SocialSync.svelte';

export interface SocialRuntime {
	createSocialApi: typeof Social.createSocialApi;
	createSocialOutbox: typeof Social.createSocialOutbox;
	createSocialSession: typeof Social.createSocialSession;
	startOutboxBridge: typeof Bridge.startOutboxBridge;
	SocialSync: typeof SocialSyncComponent;
}

let pending: Promise<SocialRuntime> | undefined;

/** Imports the social group once; a failed import is retried on the next call. */
export function loadSocialRuntime(): Promise<SocialRuntime> {
	return (pending ??= Promise.all([
		import('./index.ts'),
		import('#lib/cable/outbox-bridge.ts'),
		import('#lib/components/social/SocialSync.svelte')
	]).then(
		([social, bridge, sync]) => ({
			createSocialApi: social.createSocialApi,
			createSocialOutbox: social.createSocialOutbox,
			createSocialSession: social.createSocialSession,
			startOutboxBridge: bridge.startOutboxBridge,
			SocialSync: sync.default
		}),
		(error: unknown) => {
			pending = undefined;
			throw error;
		}
	));
}
