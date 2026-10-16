export {
	CABLE_STATUS_EVENT,
	CABLE_WRITTEN_EVENT,
	NEUTRAL_CURVE,
	SIMULATED_LABEL_SUFFIX,
	createCableService,
	detectCableSupport,
	isCableDevice,
	type CableService
} from './service.ts';
export {
	EXPERIMENTAL_CONFIRMATION_TEXT,
	FLASH_NOTICE_TEXT,
	LAMP_IDS,
	LOUDNESS_WARNING_TEXT,
	REASON_MESSAGE_KEYS,
	evaluateChecklist,
	hasExperimentalKinds,
	lampOf,
	lampsFromGate,
	reasonView
} from './checklist.ts';
export {
	GESTURE_TTL_MS,
	browserUserActivation,
	consumeGestureToken,
	createGestureToken,
	type GestureEventLike,
	type GestureOptions
} from './gesture.ts';
export type * from './types.ts';
