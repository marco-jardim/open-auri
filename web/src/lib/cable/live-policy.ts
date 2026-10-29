/**
 * Operational switch of the live (no-flash) cable preview (issues #67/#70, plan
 * docs/plans/2026-10-28-modo-sem-flash-plano.md §3 Fase 2). Like `android-status.ts`, it is
 * changed only by a site deploy: `enabled: false` turns the live preview off everywhere (the
 * service then reports `liveCapable: false` and refuses `startLive`), saving with a flash write
 * keeps working.
 */

export interface LiveApplyPolicy {
	/** false turns live applies off on every transport (WebHID, simulated and native). */
	readonly enabled: boolean;
}

export const LIVE_APPLY_POLICY: LiveApplyPolicy = {
	enabled: true
};
