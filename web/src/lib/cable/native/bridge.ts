/**
 * The `OpenAuriUsb` plugin of the Android app. This is the only module of the site that imports
 * `@capacitor/core` (which creates `window.Capacitor` as a side effect): `detect.ts` loads it
 * with a dynamic import, and only inside the Android app, so the desktop bundle never contains
 * it. Never import it statically from anywhere else.
 *
 * Never `await` the plugin, resolve a promise with it or return it from an async function or a
 * `then` callback: Capacitor's plugin proxy answers every property, `then` included, so it would
 * be taken for a thenable and its native `then` called. Read it from this module's namespace.
 */
import { registerPlugin } from '@capacitor/core';
import type { OpenAuriUsbPlugin } from './hid.ts';

/** Name the native plugin is registered under (bridgeApi 1). */
export const OPEN_AURI_USB_PLUGIN = 'OpenAuriUsb';

export const OpenAuriUsb = registerPlugin<OpenAuriUsbPlugin>(OPEN_AURI_USB_PLUGIN);
