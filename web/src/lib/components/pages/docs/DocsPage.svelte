<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import { OFFICIAL_PRESETS } from 'open-auri/catalog';
	// Direct chart imports (FUX.B): the charts barrel would bring every chart into the page.
	import PolarDiagram from '#lib/charts/PolarDiagram.svelte';
	import ConfirmDialog from '#lib/components/chrome/ConfirmDialog.svelte';
	// Only `creditSources` (no prose) from the index; the locale prose arrives as `content` (L7).
	import { creditSources } from '#lib/content/docs/credits.ts';
	import type { DocsContent } from '#lib/content/docs/types.ts';
	import { docsForEnvironment } from '#lib/content/docs/environment.ts';
	import { getNativeCableState, isNativeAndroid } from '#lib/app/context.svelte.ts';
	import { autoEqMitNotice } from '#lib/content/docs/mit.ts';
	import { activeSection, isSearchShortcut } from './search.ts';
	import { auriPreset, softRangeRows, tapeHex, thresholdRows } from './model.ts';
	import { confirmedClear, type LocalDataBackends } from './clear-local-data.ts';
	import type { DocsUi } from './ui.ts';
	import SearchDialog from './SearchDialog.svelte';
	import ProtocolWidgets from './ProtocolWidgets.svelte';
	import EnvironmentExtras from './EnvironmentExtras.svelte';
	import { keyboardScroll } from './keyboard-scroll.ts';
	import { glossaryEntries } from './glossary-entries.ts';
	import { traceOnce } from './trace.ts';
	import LazyArt from '#lib/components/art/LazyArt.svelte';

	type NotifyTone = 'success' | 'error';
	let {
		content: sourceContent,
		ui,
		githubUrl,
		clearDisabled = false,
		prepareClear,
		onCleared,
		notify,
		getBackends = () => ({
			local: window.localStorage,
			session: window.sessionStorage,
			indexedDB: window.indexedDB
		})
	}: {
		content: DocsContent;
		ui: DocsUi;
		githubUrl: string;
		clearDisabled?: boolean;
		prepareClear?: () => void | Promise<void>;
		onCleared?: () => void;
		/** Shows a toast when the app's toast store is reachable; returns false otherwise. */
		notify?: (message: string, tone: NotifyTone) => boolean;
		getBackends?: () => LocalDataBackends;
	} = $props();
	const nativeCable = getNativeCableState();
	const nativeAtLoad = isNativeAndroid();
	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
	});
	const inApp = $derived(nativeAtLoad || nativeCable.result.kind !== 'none');
	const content = $derived(docsForEnvironment(sourceContent, inApp));
	const glossaryTerms = $derived(glossaryEntries());
	let progress = $state(0);
	let showTop = $state(false);
	let barBottom = $state(56);
	let copyNote = $state('');
	let copyTimer = 0;
	let titleHeading: HTMLHeadingElement;

	/** Copies the absolute link to an anchor without touching the document URL or history. */
	async function copyLink(id: string) {
		const href = new URL(`#${id}`, window.location.href).href;
		let message = ui.linkCopied;
		let tone: NotifyTone = 'success';
		try {
			await navigator.clipboard.writeText(href);
		} catch (cause) {
			message = ui.linkCopyFailed;
			tone = 'error';
			console.warn('Clipboard unavailable for the Docs anchor', cause);
		}
		if (notify?.(message, tone)) return;
		copyNote = message;
		clearTimeout(copyTimer);
		copyTimer = window.setTimeout(() => (copyNote = ''), 2600);
	}
	/**
	 * Bottom edge of the chrome bar in the viewport. `[data-chrome="bar"]` is only a wrapper: its
	 * in-flow child is the spacer, which scrolls away with the page (its bottom goes negative),
	 * while the bar itself is `position: fixed`. So measure the wrapper's fixed or sticky boxes,
	 * and fall back to the wrapper (an in-flow bar) clamped at 0. A negative value here used to
	 * reach `rootMargin` as `--Npx`, and IntersectionObserver throws on that.
	 */
	function chromeBottom(): number {
		const wrapper = document.querySelector('[data-chrome="bar"]');
		if (!wrapper) return 56;
		let bottom = 0;
		for (const element of [wrapper, ...wrapper.children]) {
			const position = getComputedStyle(element).position;
			if (position === 'fixed' || position === 'sticky') {
				bottom = Math.max(bottom, element.getBoundingClientRect().bottom);
			}
		}
		return bottom > 0 ? bottom : Math.max(0, wrapper.getBoundingClientRect().bottom);
	}
	function backToTop() {
		stopSettling?.();
		window.scrollTo({ top: 0, behavior: prefersReducedMotion.current ? 'instant' : 'smooth' });
		titleHeading.focus({ preventScroll: true });
	}

	/*
	 * Deep links (`/docs#g-camadas` from an explainer's "Ver no glossário"). The router scrolls to
	 * the hash right after the first render, but the page keeps moving afterwards: EB Garamond
	 * replaces its fallback, the two-column glossary rebalances (terms change column) and the
	 * charts render. The target then drifts out of view. So the page places the target under
	 * the chrome itself and holds it there until layout is quiet, unless the reader steers.
	 */
	const SETTLE_QUIET_MS = 700;
	const SETTLE_CAP_MS = 5000;
	/** Any of these means the reader is steering: re-alignment stops at once. */
	const READER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
	let paper: HTMLElement | undefined;
	let hashTargetId = $state('');
	let stopSettling: (() => void) | undefined;

	const chromeOffset = () => chromeBottom() + 24;

	function hashTarget(): HTMLElement | null {
		const fragment = window.location.hash.slice(1);
		if (!fragment) return null;
		let id = fragment;
		try {
			id = decodeURIComponent(fragment);
		} catch (cause) {
			if (!(cause instanceof URIError)) throw cause;
		}
		const target = document.getElementById(id);
		return target && paper?.contains(target) ? target : null;
	}
	function place(target: HTMLElement, behavior: ScrollBehavior) {
		const top = window.scrollY + target.getBoundingClientRect().top - chromeOffset();
		window.scrollTo({ top: Math.max(0, Math.round(top)), behavior });
	}
	/**
	 * Brings the target of `location.hash` under the chrome, then re-aligns it (instantly) on
	 * every layout change until fonts are loaded and layout has been quiet for a moment, with a
	 * hard cap. Exported for the route's `afterNavigate` (same-page navigations without
	 * `hashchange`).
	 */
	export function revealHash(smooth = false) {
		stopSettling?.();
		const target = hashTarget();
		hashTargetId = target?.id ?? '';
		if (!target) return;
		const behavior: ScrollBehavior = smooth && !prefersReducedMotion.current ? 'smooth' : 'instant';
		let stopped = false;
		let frame = 0;
		let quiet = 0;
		let retry = 0;
		let fontsReady = !('fonts' in document);
		// A smooth scroll is not corrected mid-flight (until scrollend, or a fallback).
		let busyUntil = behavior === 'smooth' ? performance.now() + 900 : 0;
		const resizes = new ResizeObserver(() => schedule());
		const cap = window.setTimeout(() => stop(), SETTLE_CAP_MS);
		function stop() {
			if (stopped) return;
			stopped = true;
			resizes.disconnect();
			cancelAnimationFrame(frame);
			clearTimeout(quiet);
			clearTimeout(retry);
			clearTimeout(cap);
			window.removeEventListener('scrollend', smoothDone);
			if ('fonts' in document) document.fonts.removeEventListener('loadingdone', schedule);
			for (const type of READER_INPUT) window.removeEventListener(type, stop, true);
			if (stopSettling === stop) stopSettling = undefined;
		}
		function smoothDone() {
			busyUntil = 0;
		}
		function schedule() {
			if (!stopped && !frame) frame = requestAnimationFrame(realign);
		}
		function realign() {
			frame = 0;
			if (stopped) return;
			if (!target?.isConnected) {
				stop();
				return;
			}
			const wait = busyUntil - performance.now();
			if (wait > 0) {
				clearTimeout(retry);
				retry = window.setTimeout(schedule, wait);
				return;
			}
			if (Math.abs(target.getBoundingClientRect().top - chromeOffset()) > 2) {
				place(target, 'instant');
			}
			clearTimeout(quiet);
			if (fontsReady) quiet = window.setTimeout(stop, SETTLE_QUIET_MS);
		}
		place(target, behavior);
		stopSettling = stop;
		if (paper) resizes.observe(paper);
		window.addEventListener('scrollend', smoothDone, { once: true });
		for (const type of READER_INPUT) {
			window.addEventListener(type, stop, { capture: true, passive: true });
		}
		if ('fonts' in document) {
			document.fonts.addEventListener('loadingdone', schedule);
			// One frame first: the page's font loads start at its first layout, after this call.
			requestAnimationFrame(() => {
				void document.fonts.ready.then(() => {
					fontsReady = true;
					schedule();
				});
			});
		}
		schedule();
	}
	let searchOpen = $state(false);
	let confirmOpen = $state(false);
	let clearing = $state(false);
	let status = $state<'idle' | 'clearing' | 'cleared' | 'error'>('idle');
	let active = $state('comeco');
	let scrollMargin = $state(0);
	let presetId = $state('padrao');
	const preset = $derived(
		OFFICIAL_PRESETS.find((candidate) => candidate.id === presetId) ?? auriPreset
	);
	const thresholds = $derived(thresholdRows(content));
	const softRanges = $derived(softRangeRows(content.locale));
	let article: HTMLElement;
	let searchOpener: HTMLButtonElement;
	let searchOrigin: HTMLElement | null = null;

	function openSearch() {
		if (searchOpen) return;
		const focused = document.activeElement;
		searchOrigin =
			focused instanceof HTMLElement &&
			focused !== document.body &&
			focused !== document.documentElement
				? focused
				: null;
		searchOpen = true;
	}
	function searchReturnFocus() {
		return searchOrigin?.isConnected ? searchOrigin : searchOpener;
	}

	function onKeydown(event: KeyboardEvent) {
		if (!isSearchShortcut(event) || document.querySelector('dialog[open]')) return;
		event.preventDefault();
		openSearch();
	}
	async function navigate(id: string) {
		await tick();
		const section = document.getElementById(id);
		if (!section) return;
		stopSettling?.();
		section.scrollIntoView({
			block: 'start',
			behavior: prefersReducedMotion.current ? 'instant' : 'auto'
		});
		section.focus({ preventScroll: true });
		active = id;
	}
	onMount(() => {
		let frame = 0;
		let offset = 80;
		let atEnd = false;
		let dirty = true;
		let bandKey = '';
		let sections: HTMLElement[] = [];
		let sectionObserver: IntersectionObserver | undefined;
		/** Same rule as before (last heading above the chrome, explicit end), read on demand. */
		const pick = () => {
			active = activeSection(
				sections.map((section) => ({ id: section.id, top: section.getBoundingClientRect().top })),
				offset,
				atEnd
			);
		};
		/**
		 * The current section changes only when a chapter crosses the reading band just below the
		 * chrome, so the index follows IntersectionObserver instead of reading every chapter on
		 * every scroll frame. The band is rebuilt only when the chrome or the viewport changes.
		 */
		const observeBand = () => {
			// Never negative: `rootMargin: '--Npx …'` is a SyntaxError that took the page down.
			const top = Math.max(0, Math.round(offset));
			const height = Math.max(48, Math.round(window.innerHeight * 0.35));
			const bottom = Math.max(0, window.innerHeight - top - height);
			const key = `${top}:${bottom}:${sections.length}`;
			if (key === bandKey) return;
			bandKey = key;
			sectionObserver?.disconnect();
			sectionObserver = new IntersectionObserver(pick, {
				root: document,
				rootMargin: `-${top}px 0px -${bottom}px 0px`,
				threshold: 0
			});
			for (const section of sections) sectionObserver.observe(section);
		};
		const update = () => {
			frame = 0;
			barBottom = chromeBottom();
			offset = barBottom + 24;
			const padding =
				Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
			// Native anchor navigation adds root scroll-padding and section scroll-margin.
			scrollMargin = Math.max(0, offset - padding);
			const root = document.documentElement;
			const travel = root.scrollHeight - window.innerHeight;
			// Reading progress is real scroll state: no easing, no transition.
			progress = travel > 0 ? Math.min(1, Math.max(0, window.scrollY / travel)) : 0;
			showTop = window.scrollY > window.innerHeight * 0.75;
			const end = window.scrollY + window.innerHeight >= root.scrollHeight - 2;
			if (dirty) sections = [...article.querySelectorAll<HTMLElement>('section.chapter')];
			observeBand();
			if (dirty || end !== atEnd) {
				atEnd = end;
				dirty = false;
				pick();
			}
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(update);
		};
		const relayout = () => {
			dirty = true;
			schedule();
		};
		// In-page glossary links change the hash natively; follow them with the same offset.
		const onHashChange = () => revealHash(true);
		window.addEventListener('scroll', schedule, { passive: true });
		window.addEventListener('resize', relayout);
		window.addEventListener('hashchange', onHashChange);
		const observer = new ResizeObserver(relayout);
		observer.observe(article);
		update();
		revealHash();
		return () => {
			window.removeEventListener('scroll', schedule);
			window.removeEventListener('resize', relayout);
			window.removeEventListener('hashchange', onHashChange);
			observer.disconnect();
			sectionObserver?.disconnect();
			cancelAnimationFrame(frame);
			clearTimeout(copyTimer);
			stopSettling?.();
		};
	});
	async function clear(confirmed: boolean) {
		if (!confirmed || clearDisabled || clearing) return;
		clearing = true;
		status = 'clearing';
		try {
			await confirmedClear(confirmed, getBackends, prepareClear);
			status = 'cleared';
			onCleared?.();
		} catch (cause) {
			status = 'error';
			console.error('Local data deletion failed', cause);
		} finally {
			clearing = false;
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<main
	bind:this={paper}
	class="paper"
	data-surface="paper"
	lang={content.locale}
	style:--docs-scroll-offset={`${scrollMargin}px`}
>
	<LazyArt load={() => import('#lib/components/art/DocsArt.svelte')} />
	<div
		class="reading-progress"
		aria-hidden="true"
		style:top={`${barBottom}px`}
		style:transform={`scaleX(${progress})`}
	></div>
	<div class="tape-wrap">
		<p>{ui.tape}</p>
		<div class="tape" use:keyboardScroll role="region" aria-label={ui.tape}>
			<code>{tapeHex}</code>
		</div>
	</div>
	<div class="doc-layout">
		<aside class="toc">
			<nav aria-label={ui.contents}>
				<button
					bind:this={searchOpener}
					class="search"
					type="button"
					aria-keyshortcuts="Control+k Meta+k"
					onclick={openSearch}>{ui.search}<kbd aria-hidden="true">Ctrl K / ⌘ K</kbd></button
				>
				<p class="toc-label">{ui.contents} / {content.sections.length}</p>
				<ol>
					{#each content.sections as section, index (section.id)}
						<li>
							<a
								href="#{section.id}"
								aria-current={active === section.id ? 'location' : undefined}
								onclick={(event) => {
									event.preventDefault();
									void navigate(section.id);
								}}><span>{String(index + 1).padStart(2, '0')}</span>{section.title}</a
							>
						</li>
					{/each}
				</ol>
				<p class="toc-bottom">0xCB / REV. 15.X.2026<br />220 B · 96 kHz</p>
			</nav>
		</aside>
		<div class="document">
			<div class="running-head">
				<span>{ui.runningHead}</span><span>VOL. II · N.º 08 · 2026</span>
			</div>
			<header class="title-block">
				<p class="reprint">{content.reprint}</p>
				<!-- The explicit space keeps "0xCB e seus limites" as words in the text and the
				     accessible name: <br> breaks the line but contributes no whitespace. -->
				<h1 bind:this={titleHeading} id="docs-top" tabindex="-1">
					{content.titleLead} <br /><em>{content.titleEmphasis}</em>
				</h1>
				<p class="subtitle">{content.subtitle}</p>
				<p class="byline">{content.introduction}</p>
			</header>
			<div class="hero-plate">
				<figure>
					<!-- A full 480-unit plot plus separate caption/legend keeps polar labels apart, including at 390px. -->
					<div class="polar-scroll" use:keyboardScroll role="region" aria-label={ui.polar}>
						<div class="polar-chart" use:traceOnce>
							<PolarDiagram curve={preset} label={ui.polar} description={content.polarCaption} />
						</div>
					</div>
					<div class="preset-row">
						<label for="polar-preset">{ui.preset}</label><select
							id="polar-preset"
							bind:value={presetId}
							>{#each OFFICIAL_PRESETS as option (option.id)}<option value={option.id}
									>{option.label}</option
								>{/each}</select
						><output for="polar-preset"
							>{preset.label} · CRC 0x{preset.crc
								.toString(16)
								.toUpperCase()
								.padStart(4, '0')}</output
						>
					</div>
					<figcaption>{content.polarCaption}</figcaption>
				</figure>
				<aside class="plate-note">
					<p class="equation">ν ≤ 2B</p>
					<p>{content.telegraphNote}</p>
					<p class="equation">|p| &lt; 1</p>
					<p>{content.stabilityNote}</p>
				</aside>
			</div>
			<article bind:this={article} aria-label={content.subtitle}>
				{#each sourceContent.sections as section, index (section.id)}
					<section
						class="chapter"
						id={section.id}
						tabindex="-1"
						aria-labelledby="heading-{section.id}"
						data-folio={String(index + 2).padStart(3, '0')}
					>
						<div class="chapter-head">
							<h2 id="heading-{section.id}">
								<span class="section-number">{String(index + 1).padStart(2, '0')}</span>
								<a
									href="#{section.id}"
									onclick={(event) => {
										event.preventDefault();
										void navigate(section.id);
									}}>{section.title}</a
								>
							</h2>
							<button
								type="button"
								class="anchor-copy"
								aria-label={ui.copyLink(section.title)}
								title={ui.copyLink(section.title)}
								onclick={() => void copyLink(section.id)}><span aria-hidden="true">¶</span></button
							>
						</div>
						<div class="columns">
							{#each section.paragraphs as paragraph (paragraph)}<p>{paragraph}</p>{/each}
							{#if section.browserOnly || section.appOnly}
								<EnvironmentExtras {section} {inApp} {hydrated} part="paragraphs" />
							{/if}
							{#if section.items}<ul>
									{#each section.items as item (item)}<li>{item}</li>{/each}
								</ul>{/if}
						</div>
						{#if section.id === 'envelope'}
							<p class="inset"><strong>{content.safetyCaveat}</strong></p>
							<div class="table-scroll" role="region" use:keyboardScroll aria-label={ui.thresholds}>
								<table>
									<caption>{ui.thresholds}</caption><thead
										><tr><th scope="col">{ui.quantity}</th><th scope="col">{ui.limit}</th></tr
										></thead
									><tbody
										>{#each thresholds as row (row.id)}<tr data-threshold={row.id}
												><th scope="row">{row.label}</th><td><code>{row.value}</code></td></tr
											>{/each}</tbody
									>
								</table>
							</div>
							<p class="fine">{ui.codec}</p>
							<div class="table-scroll" role="region" use:keyboardScroll aria-label={ui.softRanges}>
								<table>
									<caption>{ui.softRanges}</caption><thead
										><tr
											><th scope="col">{ui.profile}</th><th scope="col">{ui.hz}</th><th scope="col"
												>{ui.gain}</th
											><th scope="col">Q</th></tr
										></thead
									><tbody
										>{#each softRanges as range (range.profile)}<tr
												><th scope="row">{range.profile}</th><td>{range.frequency}</td><td
													>{range.gain ?? ui.noGain}</td
												><td>{range.q}</td></tr
											>{/each}</tbody
									>
								</table>
							</div>
						{:else if section.id === 'protocolo'}<ProtocolWidgets {content} {ui} />
						{:else if section.id === 'memoria'}<p class="inset">
								<strong>{content.flashNotice}</strong>
							</p>
						{:else if section.id === 'dados-locais'}
							<button
								type="button"
								class="erase"
								disabled={clearDisabled || clearing}
								onclick={() => (confirmOpen = true)}>{ui.clear}</button
							>
							<p class="fine" role="status">
								{status === 'clearing'
									? ui.clearing
									: status === 'cleared'
										? ui.cleared
										: status === 'error'
											? ui.clearError
											: ''}
							</p>
						{:else if section.id === 'glossario'}
							<h3 class="glossary-head">{ui.glossaryInterface}</h3>
							<dl class="glossary-terms">
								{#each glossaryTerms as entry (entry.term)}<div
										class="term"
										class:is-target={hashTargetId === entry.id}
										id={entry.id}
										data-glossary-term={entry.term}
									>
										<dt>
											<a href="#{entry.id}">{entry.title}</a><button
												type="button"
												class="anchor-copy"
												aria-label={ui.copyLink(entry.title)}
												title={ui.copyLink(entry.title)}
												onclick={() => void copyLink(entry.id)}
												><span aria-hidden="true">¶</span></button
											>
										</dt>
										<dd>
											{entry.body}
											{#if entry.warning}<strong class="literal">{entry.warning}</strong>{/if}
										</dd>
									</div>{/each}
							</dl>
							<h3 class="glossary-head">{ui.glossaryTechnical}</h3>
							<dl>
								{#each content.glossary as [term, definition] (term)}<div>
										<dt>{term}</dt>
										<dd>{definition}</dd>
									</div>{/each}
							</dl>
						{:else if section.id === 'pagina-oficial'}
							<h3>{ui.officialPresets}</h3>
							<ul class="official-presets">
								{#each OFFICIAL_PRESETS as official (official.id)}<li>
										<strong>{official.label}</strong>
										<p class="fine">
											{ui.descriptionAttribution}: <span lang="pt-BR">{official.description}</span>
										</p>
										<p class="fine">{ui.licensePending}</p>
									</li>{/each}
							</ul>
						{:else if section.id === 'creditos'}
							<ul class="credits">
								{#each creditSources as credit (credit.href)}<li>
										<a href={credit.href}>{credit.label} ↗</a>
									</li>{/each}
							</ul>
							<p>
								<a href={`${githubUrl.replace(/\/$/, '')}/blob/main/docs/autoeq-data.md`}
									>{ui.autoeq} ↗</a
								>
							</p>
							<details>
								<summary>{ui.mit}</summary>
								<pre class="license">{autoEqMitNotice}</pre>
							</details>
						{/if}
						{#if section.links}<div class="links">
								{#each section.links as link (link.href)}<a href={link.href}>{link.label} ↗</a
									>{/each}
							</div>{/if}
						{#if section.browserOnly?.links || section.appOnly?.links}
							<EnvironmentExtras {section} {inApp} {hydrated} part="links" />
						{/if}
					</section>
				{/each}
			</article>
			<div class="endmark"><span>open-auri / 15.X.2026</span><span>FINIS · 021</span></div>
		</div>
	</div>
	{#if showTop}<button type="button" class="to-top" onclick={backToTop}
			><span aria-hidden="true">↑</span> {ui.backToTop}</button
		>{/if}
	<p class="copy-note" role="status">{copyNote}</p>
</main>
<SearchDialog
	{content}
	{ui}
	bind:open={searchOpen}
	returnFocus={searchReturnFocus}
	onNavigate={(id) => void navigate(id)}
/>
<ConfirmDialog
	bind:open={confirmOpen}
	title={ui.clearTitle}
	description={ui.clearDescription}
	confirmLabel={ui.clear}
	cancelLabel={ui.cancel}
	confirmDisabled={clearDisabled || clearing}
	onResult={(confirmed) => void clear(confirmed)}
/>

<style>
	.paper {
		--paper-rule: #ad9c81;
		/* Holds the art layer (DocsArt) under the text, above the paper itself. */
		position: relative;
		isolation: isolate;
		background:
			radial-gradient(ellipse at 50% 25%, transparent 30%, #a8884922),
			repeating-linear-gradient(3deg, #78552804 0 1px, transparent 1px 4px), #efe6d2;
		color: #29251f;
		font:
			19px/1.55 'EB Garamond',
			Georgia,
			serif;
		padding-bottom: 20px;
	}
	.paper :global(*) {
		box-sizing: border-box;
	}
	.paper ::selection {
		background: #8c2f2f;
		color: #efe6d2;
	}
	a {
		color: inherit;
		text-underline-offset: 4px;
	}
	a:hover {
		color: #8c2f2f;
	}
	button,
	select {
		font: inherit;
	}
	button,
	select {
		cursor: pointer;
	}
	button:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
	:focus-visible {
		outline: 2px solid #8c2f2f;
		outline-offset: 4px;
	}
	.tape-wrap {
		padding: 10px 0 16px;
		border-bottom: 1px solid var(--paper-rule);
	}
	.tape-wrap p {
		margin: 0 26px 6px;
		color: #6b5e4c;
		font: 9px/1.5 var(--font-mono, monospace);
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}
	.tape {
		overflow-x: auto;
		background: #dcc894;
		border-block: 1px solid #8f7748;
		padding: 16px 24px;
		transform: rotate(-0.15deg);
		box-shadow: 0 3px 5px #74532d22;
		scrollbar-width: thin;
	}
	.tape code {
		display: block;
		width: max-content;
		white-space: nowrap;
		color: #51452e;
		font: 10px/1.4 var(--font-mono, monospace);
		letter-spacing: 0.07em;
	}
	.doc-layout {
		display: grid;
		grid-template-columns: 202px minmax(0, 1fr);
		gap: 40px;
		max-width: 1440px;
		margin: auto;
		padding: 0 36px;
	}
	.toc {
		padding-top: 34px;
		font-family: var(--font-sans, 'Geist', sans-serif);
	}
	.toc nav {
		position: sticky;
		top: 90px;
		max-height: calc(100dvh - 110px);
		overflow-y: auto;
	}
	.search {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		border: 1px solid var(--paper-rule);
		background: #fff3;
		color: #51452e;
		padding: 10px 9px;
		font-size: 11px;
	}
	kbd {
		font: 9px/1.5 var(--font-mono, monospace);
		white-space: nowrap;
	}
	.toc-label {
		padding-bottom: 10px;
		border-bottom: 2px solid #29251f;
		margin: 26px 0 10px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}
	.toc ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.toc a {
		display: grid;
		grid-template-columns: 20px 1fr;
		gap: 7px;
		text-decoration: none;
		font-size: 11px;
		line-height: 1.45;
		color: #6b5e4c;
		padding: 7px 8px;
		border-left: 1px solid var(--paper-rule);
	}
	.toc a span {
		font: 9px/1.8 var(--font-mono, monospace);
	}
	.toc a[aria-current] {
		color: #8c2f2f;
		border-left: 2px solid #8c2f2f;
		background: #8c2f2f08;
	}
	.toc-bottom {
		margin: 22px 8px;
		padding-top: 14px;
		border-top: 1px solid var(--paper-rule);
		font: 9px/1.8 var(--font-mono, monospace);
		color: #6b5e4c;
	}
	.document {
		min-width: 0;
	}
	.running-head {
		display: flex;
		justify-content: space-between;
		gap: 15px;
		padding: 29px 0 10px;
		border-bottom: 1px solid #29251f;
		font-size: 10px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}
	.title-block {
		text-align: center;
		padding: 23px 7% 25px;
		border-bottom: 3px double #29251f;
	}
	.reprint {
		font: 10px/1.5 var(--font-mono, monospace);
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: #8c2f2f;
		margin-bottom: 17px;
	}
	h1 {
		font:
			400 clamp(38px, 4.6vw, 66px)/1.01 'EB Garamond',
			Georgia,
			serif;
		letter-spacing: -1.5px;
		text-wrap: balance;
		margin: 0;
	}
	h1 em {
		color: #8c2f2f;
		font-weight: 400;
	}
	.subtitle {
		font-size: 23px;
		font-style: italic;
		margin: 16px 0 0;
	}
	.byline {
		margin-top: 13px;
		font: 10px/1.7 var(--font-sans, sans-serif);
		color: #6b5e4c;
	}
	.hero-plate {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 190px;
		gap: 25px;
		padding: 28px 0;
		border-bottom: 1px solid #29251f;
	}
	figure {
		margin: 0;
		min-width: 0;
	}
	.polar-scroll {
		overflow-x: auto;
		scrollbar-width: thin;
	}
	.polar-chart {
		min-width: 480px;
	}
	.polar-chart :global(.chart text) {
		font-size: 11px;
	}
	figcaption {
		font-size: 16px;
		line-height: 1.45;
		margin: 14px 0;
	}
	.preset-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px 12px;
		font: 11px/1.5 var(--font-sans, sans-serif);
	}
	select {
		padding: 7px 10px;
		color: #29251f;
		background: #fff3;
		border: 1px solid #6b5e4c;
	}
	output {
		font: 10px/1.6 var(--font-mono, monospace);
	}
	.plate-note {
		border-left: 1px solid var(--paper-rule);
		padding-left: 20px;
		font-size: 16px;
	}
	.plate-note p {
		margin: 0 0 18px;
	}
	.plate-note .equation {
		font-style: italic;
		color: #8c2f2f;
		font-size: 38px;
		line-height: 1;
	}
	.chapter {
		/* Keep anchor/TOC geometry real. Only the fixed-ratio protocol scenes skip rendering. */
		position: relative;
		padding: 31px 0 33px;
		border-bottom: 1px solid #29251f;
		scroll-margin-top: var(--docs-scroll-offset);
	}
	.chapter::before {
		content: attr(data-folio);
		position: absolute;
		right: -28px;
		top: 34px;
		font-size: 12px;
		color: #6b5e4c;
		writing-mode: vertical-rl;
	}
	h2 {
		font:
			400 28px/1.15 'EB Garamond',
			Georgia,
			serif;
		font-variant: small-caps;
		letter-spacing: 0.055em;
		margin: 0;
	}
	h2 a {
		text-decoration: none;
	}
	.chapter-head {
		display: flex;
		align-items: center;
		gap: var(--space-2, 8px);
		margin: 0 0 20px;
	}
	/* Copyable anchor: quiet at rest (the page reads as print), visible on hover and focus. */
	.anchor-copy {
		display: inline-grid;
		place-items: center;
		flex: none;
		min-width: var(--hit, 36px);
		min-height: var(--hit, 36px);
		padding: 0;
		border: 0;
		background: none;
		color: #8c2f2f;
		font: 400 var(--fs-title) / 1 var(--journal);
		opacity: 0;
		transition: opacity var(--dur-fast) var(--ease-out);
	}
	.chapter-head:hover .anchor-copy,
	.term:hover .anchor-copy,
	.term:target .anchor-copy,
	.term.is-target .anchor-copy,
	.anchor-copy:focus-visible {
		opacity: 1;
	}
	@media (hover: none) {
		/* Touch has no hover: the anchor stays visible at full contrast. */
		.anchor-copy {
			opacity: 1;
		}
	}
	h1[tabindex]:focus:not(:focus-visible) {
		outline: none;
	}
	.reading-progress {
		position: fixed;
		left: 0;
		right: 0;
		z-index: 4;
		height: 2px;
		background: #8c2f2f;
		transform-origin: left center;
		pointer-events: none;
	}
	.glossary-head {
		margin: 8px 0 14px;
		font: 400 var(--fs-title) / var(--lh-title) var(--journal);
		font-variant: small-caps;
		letter-spacing: 0.04em;
	}
	.glossary-terms {
		margin-bottom: 32px;
	}
	.term {
		scroll-margin-top: var(--docs-scroll-offset);
		padding: 6px 0 6px 12px;
		border-left: 2px solid transparent;
	}
	/* `:target` covers full loads; `.is-target` covers client-side arrivals (`pushState` does
	   not update `:target`) and follows later hash changes. */
	.term:target,
	.term.is-target {
		border-left-color: #8c2f2f;
		background: #8c2f2f0d;
	}
	.term dt {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.term dt a {
		color: #8c2f2f;
		text-decoration: none;
	}
	.term dt a:hover {
		text-decoration: underline;
	}
	.term .anchor-copy {
		min-width: 28px;
		min-height: 28px;
		font-size: var(--fs-lede);
	}
	.literal {
		display: block;
		margin-top: 8px;
		color: #8c2f2f;
	}
	.to-top {
		position: fixed;
		left: max(16px, env(safe-area-inset-left));
		bottom: calc(16px + env(safe-area-inset-bottom));
		z-index: 4;
		min-height: var(--hit, 36px);
		padding: 0 14px;
		border: 1px solid #29251f;
		background: #efe6d2;
		color: #29251f;
		font: 500 var(--fs-caption) / 1 var(--face-body);
		box-shadow: 0 6px 16px -8px #29251f99;
	}
	.to-top:hover {
		color: #8c2f2f;
		border-color: #8c2f2f;
	}
	.copy-note {
		position: fixed;
		left: 50%;
		bottom: calc(16px + env(safe-area-inset-bottom));
		z-index: 4;
		margin: 0;
		padding: 8px 14px;
		transform: translateX(-50%);
		background: #29251f;
		color: #efe6d2;
		font: 500 var(--fs-small) / var(--lh-small) var(--face-body);
		pointer-events: none;
	}
	.copy-note:empty {
		opacity: 0;
	}
	/* traceOnce (trace.ts): a plotter sweep that reveals the real figure once, left to right. */
	.paper :global([data-trace='armed'] svg) {
		clip-path: inset(0 100% 0 0);
	}
	.paper :global([data-trace='run'] svg) {
		animation: docs-trace calc(var(--dur-scene, 0.72s) * 1.5)
			var(--ease-in-out, cubic-bezier(0.65, 0, 0.35, 1)) both;
	}
	@keyframes -global-docs-trace {
		from {
			clip-path: inset(0 100% 0 0);
		}
		to {
			clip-path: inset(0 0 0 0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.paper :global([data-trace] svg) {
			clip-path: none;
			animation: none;
		}
		.anchor-copy {
			transition: none;
		}
	}
	.section-number {
		font: 11px var(--font-mono, monospace);
		color: #8c2f2f;
		/* With the word space that follows it (accessible name "02 Title"), about 14px as before. */
		margin-right: 6px;
		vertical-align: middle;
	}
	.columns {
		columns: 2;
		column-gap: 30px;
		column-rule: 1px solid #59442524;
		hyphens: auto;
		orphans: 3;
		widows: 3;
	}
	.columns p {
		margin: 0 0 13px;
	}
	.columns ul {
		padding-left: 20px;
		margin: 0;
	}
	.columns li {
		margin-bottom: 12px;
	}
	.inset {
		border: 1px solid var(--paper-rule);
		padding: 16px 20px;
		background: #dbc99e22;
		margin: 20px 0;
		color: #8c2f2f;
	}
	.table-scroll {
		overflow-x: auto;
		margin: 24px 0 12px;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		text-align: left;
		font: 11px/1.8 var(--font-sans, sans-serif);
	}
	caption {
		text-align: left;
		font:
			23px/1.4 'EB Garamond',
			Georgia,
			serif;
		margin-bottom: 12px;
	}
	th,
	td {
		padding: 9px 12px;
		border-bottom: 1px solid var(--paper-rule);
	}
	thead th {
		border-block: 1px solid #29251f;
	}
	td code {
		white-space: nowrap;
		font: 11px/1.6 var(--font-mono, monospace);
	}
	.fine {
		font: 12px/1.7 var(--font-sans, sans-serif);
	}
	.erase {
		margin-top: 20px;
		padding: 10px 16px;
		border: 1px solid #8c2f2f;
		background: #8c2f2f;
		color: #fff4ef;
		font: 12px/1.5 var(--font-sans, sans-serif);
	}
	dl {
		columns: 2;
		column-gap: 30px;
	}
	dl div {
		break-inside: avoid;
		margin-bottom: 18px;
	}
	dt {
		font-weight: 600;
		color: #8c2f2f;
	}
	dd {
		margin: 4px 0 0;
		font-size: 17px;
	}
	.credits {
		columns: 2;
		padding-left: 20px;
	}
	.credits li {
		break-inside: avoid;
		padding-bottom: 9px;
	}
	.official-presets {
		columns: 2;
		padding-left: 20px;
	}
	.official-presets li {
		break-inside: avoid;
		padding-bottom: 14px;
	}
	.official-presets p {
		margin: 4px 0;
	}
	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 12px 24px;
		margin-top: 18px;
		font: 12px/1.5 var(--font-sans, sans-serif);
	}
	summary {
		cursor: pointer;
		margin-top: 20px;
	}
	.license {
		white-space: pre-wrap;
		font: 11px/1.8 var(--font-mono, monospace);
	}
	.endmark {
		display: flex;
		justify-content: space-between;
		padding: 18px 0;
		font: 9px/1.6 var(--font-mono, monospace);
	}
	@media (max-width: 1200px) {
		.doc-layout {
			grid-template-columns: 177px minmax(0, 1fr);
			gap: 27px;
			padding-inline: 27px;
		}
		.hero-plate {
			grid-template-columns: 1fr;
		}
		.plate-note {
			display: grid;
			grid-template-columns: 90px 1fr;
			gap: 10px;
			border-left: 0;
			border-top: 1px solid var(--paper-rule);
			padding: 20px 0 0;
		}
		.toc nav {
			top: 140px;
			max-height: calc(100dvh - 160px);
		}
	}
	@media (max-width: 950px) {
		.columns,
		dl,
		.official-presets {
			columns: 1;
		}
		.doc-layout {
			grid-template-columns: 155px minmax(0, 1fr);
			gap: 25px;
		}
		.toc a {
			font-size: 10px;
		}
	}
	@media (max-width: 650px) {
		.doc-layout {
			display: block;
			padding-inline: 21px;
		}
		.toc {
			padding-top: 20px;
		}
		.toc nav {
			position: static;
			max-height: none;
			overflow: visible;
		}
		.toc-label,
		.toc-bottom {
			display: none;
		}
		.toc ol {
			display: flex;
			overflow-x: auto;
			padding: 14px 0 9px;
			gap: 13px;
			border-bottom: 1px solid var(--paper-rule);
		}
		.toc li {
			flex-shrink: 0;
		}
		.toc a {
			display: flex;
			border-left: 0;
			padding: 4px 0;
			white-space: nowrap;
		}
		.toc a[aria-current] {
			border-left: 0;
			border-bottom: 1px solid #8c2f2f;
		}
		.running-head {
			font-size: 8px;
			letter-spacing: 0.04em;
			padding-top: 18px;
		}
		.title-block {
			padding: 22px 0;
		}
		h1 {
			font-size: 44px;
			letter-spacing: -1px;
		}
		.reprint {
			font-size: 8px;
		}
		.hero-plate {
			padding-top: 18px;
			gap: 15px;
		}
		.chapter::before {
			right: -14px;
			font-size: 10px;
		}
		h2 {
			font-size: 26px;
		}
		.columns {
			font-size: 18px;
		}
		.credits {
			columns: 1;
		}
	}
	@media print {
		.toc,
		.tape-wrap,
		.erase,
		.reading-progress,
		.to-top,
		.copy-note,
		.anchor-copy {
			display: none;
		}
		.paper :global([data-trace] svg) {
			clip-path: none;
			animation: none;
		}
		.doc-layout {
			display: block;
			padding: 0;
		}
		.paper {
			background: #fff;
		}
		.polar-chart {
			min-width: 0;
		}
		.chapter {
			break-inside: auto;
		}
	}
</style>
