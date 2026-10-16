/// <reference lib="webworker" />

import { dev, version } from '$app/env';
import { assets, immutable, prerendered } from '$app/manifest';
import { self } from '$app/service-worker';
import {
	API_MAX_ENTRIES,
	AUTOEQ_MAX_ENTRIES,
	SKIP_WAITING,
	cacheNames,
	canStorePublicResponse,
	evictionCount,
	isAnonymous,
	manifestUrl,
	obsoleteCaches,
	precacheUrls,
	requestStrategy
} from './lib/pwa/strategy.ts';

const scope = self.registration.scope;
const names = cacheNames(version);
const urls = precacheUrls(
	[...immutable, ...assets, ...prerendered, { path: '' }, { path: 'offline' }],
	scope
);
const shell = new Set(urls);
const offlineUrl = manifestUrl('offline', scope);

// Serialize puts + eviction across concurrent pack/API fetches, including quota failures.
let writes = Promise.resolve();
function store(cache: Cache, request: Request, response: Response, limit: number): Promise<void> {
	const copy = response.clone();
	writes = writes
		.then(async () => {
			await cache.put(request, copy);
			const keys = await cache.keys();
			for (const key of keys.slice(0, evictionCount(keys.length, limit))) {
				await cache.delete(key);
			}
		})
		.catch((error: unknown) => console.warn('PWA runtime cache write failed', error));
	return writes;
}

function unavailable(): Response {
	return new Response(JSON.stringify({ error: 'offline' }), {
		status: 503,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
}

async function apiNetworkFirst(request: Request): Promise<Response> {
	// Default fetch credentials are same-origin. Even an invisible HttpOnly session cookie must
	// disqualify a request, so opt-in public F3 fetches must explicitly use credentials: 'omit'.
	const cache = isAnonymous(request) ? await caches.open(names.api) : null;
	try {
		const response = await fetch(request);
		if (cache && response.status >= 500) {
			const cached = await cache.match(request);
			if (cached) return cached;
		}
		if (cache) {
			if (canStorePublicResponse(response, true)) {
				await store(cache, request, response, API_MAX_ENTRIES);
			} else {
				// A formerly public endpoint may become private. Do not retain its old response.
				await cache.delete(request);
			}
		}
		return response;
	} catch (error: unknown) {
		const cached = await cache?.match(request);
		if (cached) return cached;
		console.info('PWA API unavailable', request.url, error);
		return unavailable();
	}
}

async function cacheFirst(request: Request, name: string, limit: number): Promise<Response> {
	const cache = await caches.open(name);
	const cached = await cache.match(request);
	if (cached) return cached;
	// These URLs are build/static public assets, never a personalized server response.
	const publicRequest = new Request(request, { credentials: 'omit' });
	const response = await fetch(publicRequest);
	if (canStorePublicResponse(response)) await store(cache, publicRequest, response, limit);
	return response;
}

async function navigate(request: Request): Promise<Response> {
	try {
		// Never put live navigation responses in CacheStorage, since they can be personalized.
		const response = await fetch(request);
		if (response.status < 500) return response;
	} catch (error: unknown) {
		console.info('PWA serving offline app shell', error);
	}
	const cache = await caches.open(names.precache);
	const url = new URL(request.url);
	url.search = '';
	url.hash = '';
	const cached = await cache.match(url.href);
	if (cached) return cached;
	// Keep the document URL aligned with its prerendered route, relative asset URLs and hydration.
	if (url.href !== offlineUrl && (await cache.match(offlineUrl))) {
		return Response.redirect(offlineUrl, 302);
	}
	return unavailable();
}

if (!dev) {
	self.addEventListener('install', (event) => {
		event.waitUntil(
			(async () => {
				const cache = await caches.open(names.precache);
				await Promise.all(
					urls.map(async (url) => {
						const request = new Request(url, {
							credentials: 'omit',
							cache: 'reload',
							redirect: 'error'
						});
						const response = await fetch(request);
						if (!canStorePublicResponse(response)) {
							throw new Error(`Unsafe or unavailable precache response: ${url}`);
						}
						await cache.put(request, response);
					})
				);
				// No skipWaiting here: updates require an explicit, write-safe user gesture.
			})()
		);
	});

	self.addEventListener('activate', (event) => {
		event.waitUntil(
			(async () => {
				await Promise.all(
					obsoleteCaches(await caches.keys(), version).map((name) => caches.delete(name))
				);
				await self.clients.claim();
			})()
		);
	});

	self.addEventListener('message', (event) => {
		const data: unknown = event.data;
		if (
			typeof data === 'object' &&
			data !== null &&
			'type' in data &&
			data.type === SKIP_WAITING &&
			event.source &&
			'url' in event.source &&
			new URL(event.source.url).origin === self.location.origin
		) {
			event.waitUntil(self.skipWaiting());
		}
	});

	self.addEventListener('fetch', (event) => {
		const { request } = event;
		switch (requestStrategy(request, scope, shell)) {
			case 'api-network-first':
				event.respondWith(apiNetworkFirst(request));
				break;
			case 'autoeq-cache-first':
				event.respondWith(cacheFirst(request, names.autoeq, AUTOEQ_MAX_ENTRIES));
				break;
			case 'precache':
				event.respondWith(cacheFirst(request, names.precache, Number.POSITIVE_INFINITY));
				break;
			case 'navigation':
				event.respondWith(navigate(request));
				break;
			// Non-GET, authenticated, cross-origin, Range and unknown asset requests bypass caches.
			case 'network-only':
				break;
		}
	});
}
