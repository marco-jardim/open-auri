import { expect, test } from 'vitest';
import { loadSocialRuntime } from '#lib/social/runtime.ts';
import { createSocialOutbox, createSocialSession } from '#lib/social/index.ts';
import { startOutboxBridge } from '#lib/cable/outbox-bridge.ts';
import SocialSync from '#lib/components/social/SocialSync.svelte';

test('the deferred social group loads once with the bridge, the outbox and SocialSync', async () => {
	const first = loadSocialRuntime();
	expect(loadSocialRuntime()).toBe(first);
	const runtime = await first;
	// The very same module exports: one session/outbox/bridge implementation, not a copy.
	expect(runtime.createSocialSession).toBe(createSocialSession);
	expect(runtime.createSocialOutbox).toBe(createSocialOutbox);
	expect(runtime.startOutboxBridge).toBe(startOutboxBridge);
	expect(runtime.SocialSync).toBe(SocialSync);
	expect(typeof runtime.createSocialApi).toBe('function');
	await expect(loadSocialRuntime()).resolves.toBe(runtime);
});
