<script lang="ts">
	// Courier Prime (--type) comes from the global fonts.css (spec §5.6): no page font imports.
	import { OFFICIAL_PRESETS } from 'open-auri/catalog';
	import { Button, EmptyState, Skeleton } from '#lib/components/primitives/index.ts';
	import { Tour, TourTrigger } from '#lib/components/comprehension/index.ts';
	import type { ClientApp } from '#lib/app/client.svelte.ts';
	import { IDLE_STATE, type AudioEngineState } from '#lib/audio/engine.ts';
	import { tap, type MeterTap, type MeterUpdate, type TapOptions } from '#lib/audio/meters.ts';
	// Direct chart imports (FUX.B): the charts barrel would bring every chart into the page.
	import MiniCurve from '#lib/charts/MiniCurve.svelte';
	import EmBreve from '#lib/components/chrome/EmBreve.svelte';
	import LazyArt from '#lib/components/art/LazyArt.svelte';
	import { neutralCurve } from '#lib/state/model.ts';
	import { createGateWorker } from '#lib/workers/gate-client.ts';
	import { getLocale } from '#lib/paraglide/runtime.js';
	import { m } from '#lib/paraglide/messages.js';
	import type { SocialApi, SocialSession } from '#lib/social/index.ts';
	import MeterBridge from './MeterBridge.svelte';
	import ReelHousing from './ReelHousing.svelte';
	import Deferred from '#lib/components/pages/lazy/Deferred.svelte';
	import { minhaBiblioteca } from './lazy.ts';
	import {
		archiveTapes,
		selectTapes,
		referencePack,
		rmsTo,
		number,
		type Sort,
		type Tag,
		type Tape,
		type Shelf,
		type GateResult
	} from './archive.ts';

	let {
		app = null,
		origin,
		social = null
	}: {
		app?: ClientApp | null;
		origin: string;
		/** Account shelves (T4.14); without it the page is the local library only. */
		social?: {
			session: SocialSession;
			api: SocialApi;
			currentPath?: string;
		} | null;
	} = $props();
	const id = $props.id();
	const locale = $derived(getLocale());
	const fallback = neutralCurve();
	const current = $derived(app?.state.curve.current ?? fallback);
	const tapes = $derived(archiveTapes(app?.state.library.items ?? []));
	let query = $state('');
	let tag = $state<Tag | 'all'>('all');
	let sort = $state<Sort>('official');
	let selected = $state<Tape | null>(null);
	let notice = $state('');
	let saving = $state(false);
	let verdict = $state.raw<GateResult | null>(null);
	let audioState = $state.raw<AudioEngineState>({ ...IDLE_STATE });
	let meterUpdate = $state.raw<MeterUpdate>({ mode: 'data', frame: null });
	/** VU of the source before any curve (Nível). */
	let sourceUpdate = $state.raw<MeterUpdate>({ mode: 'data', frame: null });
	/** VU of the sheet's selected A/B chain output (Preamp); DATA without a sheet audition. */
	let outputUpdate = $state.raw<MeterUpdate>({ mode: 'data', frame: null });
	const audioReady = $derived(audioState.ready);
	const engine = $derived(app?.audio);
	const reference = $derived(app?.state.meterRef.value ?? -18);
	const monitor = $derived(selected ?? current);
	const tagLabels = $derived({
		bass: m.biblioteca_bass(),
		bright: m.biblioteca_bright(),
		dark: m.biblioteca_dark(),
		lean: m.biblioteca_lean(),
		flat: m.biblioteca_flat()
	});
	const shelfNames = $derived({
		preferencia: m.biblioteca_preference(),
		referencia: m.biblioteca_reference(),
		local: m.biblioteca_local()
	});
	const groups: Shelf[] = ['preferencia', 'referencia', 'local'];
	const officialTapes = $derived(tapes.filter((tape) => tape.group !== 'local'));
	/** Comparison reference: "Sua curva" is the editor curve from the existing state. */
	let referenceId = $state('current');
	const comparison = $derived(
		referenceId === 'current'
			? current
			: (officialTapes.find((tape) => tape.id === referenceId) ?? current)
	);
	const visible = $derived(
		selectTapes(tapes, { query, tag, sort, current: comparison, locale, tagLabels })
	);
	const masterRank = $derived(
		new Map(
			[...officialTapes]
				.sort((a, b) => a.order - b.order)
				.map((tape, index) => [tape.id, index + 1] as const)
		)
	);
	const rmsByTape = $derived(new Map(visible.map((tape) => [tape.id, rmsTo(tape, comparison)])));
	const pack = OFFICIAL_PRESETS;
	const packOpen = $derived(query.trim() === '' && tag === 'all');
	/** FUX.2: the runtime may still be loading (client null) or IndexedDB still restoring. */
	const libraryLoading = $derived(!app || app.state.library.loading);
	const hasLocal = $derived(tapes.some((tape) => tape.group === 'local'));
	const examples = $derived(officialTapes.slice(0, 3));
	const firstCard = $derived(visible[0]?.id ?? null);
	const pad = (value: number) => String(value).padStart(2, '0');
	function serial(tape: Tape): string {
		const rank = masterRank.get(tape.id);
		return tape.group === 'local' || rank === undefined
			? 'LOCAL'
			: m.biblioteca_master({ n: pad(rank), total: pad(officialTapes.length) });
	}

	$effect(() => {
		if (!engine) return;
		audioState = engine.state();
		return engine.onChange((state) => {
			audioState = state;
		});
	});
	/** One pre-volume tap; its teardown disconnects it and leaves the dial in DATA. */
	function listenTo(
		node: AudioNode,
		options: TapOptions,
		onUpdate: (update: MeterUpdate) => void
	): () => void {
		let cancelled = false;
		let meter: MeterTap | null = null;
		let unsubscribe: (() => void) | undefined;
		void tap(node, options)
			.then((source) => {
				if (cancelled) {
					source.disconnect();
					return;
				}
				meter = source;
				unsubscribe = source.subscribe(onUpdate);
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					notice = m.biblioteca_audio_error();
					console.error('Biblioteca meter failed', error);
				}
			});
		return () => {
			cancelled = true;
			unsubscribe?.();
			meter?.disconnect();
			onUpdate({ mode: 'data', frame: null });
		};
	}
	$effect(() => {
		if (!engine || !audioReady) return;
		// Pre-volume taps: readings reflect the signal, never the monitor volume.
		const teardowns = [
			// What is playing (post-curve sum): correlation and peak.
			listenTo(
				engine.getMeterBus(),
				{ reference, kinds: ['ppm', 'correlation'], ppmType: 'I' },
				(update) => {
					meterUpdate = update;
				}
			),
			// The source before any curve (the bus every chain hangs off): level.
			listenTo(engine.getSourceBus(), { reference, kinds: ['vu'] }, (update) => {
				sourceUpdate = update;
			})
		];
		return () => {
			for (const teardown of teardowns) teardown();
		};
	});
	$effect(() => {
		const curve = monitor;
		const worker = createGateWorker();
		let cancelled = false;
		verdict = null;
		void worker
			.commit({
				// Selecting a tape stores it in deep $state. Worker messages cannot clone its proxy.
				bands: $state.snapshot(curve.bands),
				preampDb: curve.preampDb,
				experimental: true
			})
			.then((result) => {
				if (!cancelled) verdict = result.verdict;
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					notice = m.biblioteca_gate_error();
					console.error('Biblioteca gate failed', error);
				}
			});
		return () => {
			cancelled = true;
			worker.dispose();
		};
	});

	function clear() {
		query = '';
		tag = 'all';
	}
	async function save() {
		if (!app || saving) return;
		saving = true;
		try {
			const result = await app.state.library.save(current);
			notice = result ? m.biblioteca_saved() : m.biblioteca_local_error();
		} catch (error) {
			notice = m.biblioteca_local_error();
			console.error('Biblioteca save failed', error);
		} finally {
			saving = false;
		}
	}
	async function exportPack() {
		try {
			const { downloadBlob } = await import('./sheet-export.ts');
			downloadBlob(
				new Blob([referencePack()], { type: 'application/json' }),
				'open-auri-reference-pack.json'
			);
		} catch (error) {
			notice = m.biblioteca_export_error();
			console.error('Biblioteca pack export failed', error);
		}
	}
</script>

<svelte:head
	><title>{m.biblioteca_title()} · open-auri</title><meta
		name="description"
		content={m.biblioteca_intro()}
	/></svelte:head
>

<div class="room">
	<LazyArt load={() => import('#lib/components/art/BibliotecaArt.svelte')} />
	<div class="window" aria-hidden="true"></div>
	<section class="hero" aria-labelledby="{id}-title">
		<div class="tape-path" aria-hidden="true"></div>
		<div class="deck-left"><ReelHousing /></div>
		<div class="deck-right"><ReelHousing /></div>
		<div class="hero-copy">
			<div class="caps">{m.biblioteca_eyebrow()}</div>
			<h1 id="{id}-title">{m.biblioteca_title()}</h1>
			<p>{m.biblioteca_intro()}</p>
			<span class="room-number">{m.biblioteca_spec()}</span>
			<div class="tour-trigger"><TourTrigger page="biblioteca" /></div>
		</div>
	</section>
	<MeterBridge
		curve={monitor}
		{current}
		reference={comparison}
		{verdict}
		update={meterUpdate}
		source={sourceUpdate}
		output={outputUpdate}
		{locale}
	/>
	<section class="archive" aria-labelledby="{id}-vault">
		<div class="archive-head">
			<div>
				<h2 id="{id}-vault">{m.biblioteca_vault()}</h2>
				<p>{m.biblioteca_source()}</p>
			</div>
			<span class="count" aria-live="polite">{m.biblioteca_count({ count: visible.length })}</span>
		</div>
		<div class="controls">
			<div class="log-card">
				<label for="{id}-search">{m.biblioteca_search()}</label><input
					id="{id}-search"
					type="search"
					autocomplete="off"
					bind:value={query}
					placeholder={m.biblioteca_placeholder()}
				/>
			</div>
			<fieldset>
				<legend>{m.biblioteca_tags()}</legend>
				<div class="filter-buttons">
					<button
						class="push"
						type="button"
						aria-pressed={tag === 'all'}
						onclick={() => {
							tag = 'all';
						}}>{m.biblioteca_all()}</button
					>{#each Object.entries(tagLabels) as [key, label] (key)}<button
							class="push"
							type="button"
							aria-pressed={tag === key}
							onclick={() => {
								tag = key as Tag;
							}}>{label}</button
						>{/each}
				</div>
			</fieldset>
			<div class="sort-panel">
				<span class="knob" aria-hidden="true"></span><label for="{id}-sort"
					>{m.biblioteca_sort()}<select id="{id}-sort" bind:value={sort}
						><option value="official">{m.biblioteca_sort_official()}</option><option value="name"
							>{m.biblioteca_sort_name()}</option
						><option value="pre">{m.biblioteca_sort_pre()}</option><option value="distance"
							>{m.biblioteca_sort_distance()}</option
						></select
					></label
				>
			</div>
		</div>
		<div class="reference">
			<label class="reference-select" for="{id}-reference"
				>{m.biblioteca_current()}<select id="{id}-reference" bind:value={referenceId}
					><option value="current">{m.biblioteca_your_curve({ name: current.name })}</option
					>{#each officialTapes as tape (tape.id)}<option value={tape.id}>{tape.name}</option
						>{/each}</select
				></label
			>
			<details>
				<summary>{m.biblioteca_method()}</summary>
				<p>{m.biblioteca_method_note()}</p>
			</details>
		</div>
		{#if visible.length === 0}<div class="empty">
				<p>{m.biblioteca_empty()}</p>
				<Button variant="ghost" onclick={clear}>{m.biblioteca_clear()}</Button>
			</div>{/if}
		{#each groups as group (group)}
			<section
				class="shelf-group"
				aria-labelledby="{id}-{group}"
				data-tour={group === 'local' ? 'biblioteca-shelf' : undefined}
			>
				<div class="shelf-title">
					<h3 id="{id}-{group}">{shelfNames[group]}</h3>
					<span>{visible.filter((tape) => tape.group === group).length}</span
					>{#if group === 'local'}<span class="shelf-action"
							><Button
								size="sm"
								disabledReason={app ? null : m.biblioteca_reason_loading()}
								loading={saving}
								onclick={save}>{m.biblioteca_save()}</Button
							></span
						>{/if}
				</div>
				{#if group === 'local' && app?.state.library.error}<p role="alert">
						{m.biblioteca_local_error()}
					</p>{/if}
				{#if group === 'local' && !hasLocal}
					{#if libraryLoading}
						<div class="shelves" aria-busy="true">
							{#each [0, 1] as slot (slot)}<Skeleton
									class="tape-skeleton"
									height="300px"
									label={m.biblioteca_reason_loading()}
								/>{/each}
						</div>
					{:else if !app?.state.library.error}
						<div class="library-empty">
							<EmptyState title={m.empty_library_title()} why={m.empty_library_body()}>
								{#snippet illustration()}
									<svg viewBox="0 0 96 64" width="96" height="64" fill="none" stroke="currentColor">
										<rect x="10" y="10" width="76" height="46" rx="2" stroke-width="1.5" />
										<rect x="22" y="18" width="52" height="14" stroke-width="1" />
										<path d="M18 44h60M18 50h40" stroke-width="1" stroke-dasharray="3 4" />
									</svg>
								{/snippet}
								{#snippet action()}
									<Button variant="primary" loading={saving} onclick={save}
										>{m.empty_library_action()}</Button
									>
								{/snippet}
							</EmptyState>
						</div>
						<ul class="shelves examples" aria-label={m.biblioteca_example_box()}>
							{#each examples as tape (tape.id)}<li class="example-box">
									<span class="tape-header"
										><span class="serial">{m.empty_example()}</span><span>96 kHz</span></span
									>
									<span class="tape-label"
										><strong>{tape.name}</strong><span>{m.biblioteca_example_box()}</span></span
									>
									<span class="tape-chart" aria-hidden="true"
										><MiniCurve
											curve={tape}
											label={tape.name}
											description={m.biblioteca_response()}
											color="#5b4725"
											minDb={-15}
											maxDb={15}
										/></span
									>
								</li>{/each}
						</ul>
					{/if}
				{/if}
				<div class="shelves">
					{#each visible.filter((tape) => tape.group === group) as tape (tape.id)}
						<button
							type="button"
							class="tape"
							class:active={selected?.id === tape.id}
							data-tour={tape.id === firstCard ? 'biblioteca-card' : undefined}
							onclick={() => {
								selected = tape;
							}}
						>
							<span class="tape-header"
								><span class="serial">{serial(tape)}</span><span>96 kHz</span><span
									class="dot"
									aria-hidden="true"
								></span></span
							>
							<span class="tape-label"
								><strong>{tape.name}</strong><span class="tape-sub"
									><span>{tape.source}</span><span>pre {number(tape.preampDb, locale)} dB</span
									></span
								></span
							>
							<span class="tape-chart"
								><span class="mini-frame"
									><MiniCurve
										curve={tape}
										label={tape.name}
										description={m.biblioteca_response()}
										color="#5b4725"
										minDb={-15}
										maxDb={15}
									/><span class="mini-y" aria-hidden="true"
										><span>+15</span><span>0</span><span>−15</span></span
									></span
								><span class="mini-x" aria-hidden="true"
									><span>20</span><span>1k</span><span>20k</span></span
								></span
							>
							{#if tape.description && tape.group === 'local'}<span
									class="tape-description own-description">{tape.description}</span
								><small>{m.biblioteca_edit_local_description()}</small>
							{:else if tape.description}<span
									class="tape-description"
									lang={locale === 'en-US' && !tape.descriptionEn ? 'pt-BR' : locale}
									>{locale === 'en-US' && tape.descriptionEn
										? tape.descriptionEn
										: tape.description}</span
								><small
									>{locale === 'en-US' && !tape.descriptionEn
										? m.biblioteca_original_description()
										: m.biblioteca_description()}</small
								>{/if}
							<span class="tape-tags">{tape.tags.map((value) => tagLabels[value]).join(' · ')}</span
							>
							<span class="tape-bottom"
								><span
									>{tape.group === 'local'
										? m.biblioteca_local_license()
										: m.biblioteca_license()}</span
								><span>RMS {number(rmsByTape.get(tape.id) ?? null, locale, 2)}</span></span
							>
						</button>
					{/each}
					{#if group === 'referencia' && packOpen}
						<article class="pack-box" aria-labelledby="{id}-pack">
							<span class="tape-header"
								><span class="serial">BOX SET · VOL. 01</span><span>v1 · JSON</span></span
							>
							<span class="tape-label"
								><h4 id="{id}-pack">{m.biblioteca_pack_box({ count: pack.length })}</h4>
								<span class="tape-sub"
									><span>{m.biblioteca_pack()}</span><span
										>{pack.length} / {officialTapes.length}</span
									></span
								></span
							>
							<span class="pack-art" aria-hidden="true">Vol. 01</span>
							<p class="tape-description">{m.biblioteca_pack_note()}</p>
							<p class="tape-tags">{pack.map((preset) => preset.label).join(' · ')}</p>
							<p class="tape-tags">{m.biblioteca_pack_order()}</p>
							<span class="tape-bottom"
								><span>{m.biblioteca_license()}</span><span
									>{pack.length} / {officialTapes.length}</span
								></span
							>
							<div class="pack-action">
								<Button size="sm" onclick={exportPack}>{m.biblioteca_pack_export()}</Button>
							</div>
						</article>
					{/if}
				</div>
			</section>
		{/each}
		{#if social}{@const shelves = social}
			<div class="account-card">
				<Deferred module={minhaBiblioteca} height="9rem">
					{#snippet children(MinhaBiblioteca)}
						<MinhaBiblioteca
							session={shelves.session}
							api={shelves.api}
							localItems={app?.state.library.items ?? []}
							{origin}
							{locale}
							currentPath={shelves.currentPath ?? '/biblioteca'}
						/>
					{/snippet}
				</Deferred>
			</div>{/if}
		<div class="community">
			<div>
				<h3>{m.biblioteca_community()}</h3>
				<p>{m.biblioteca_community_note()}</p>
			</div>
			<a href="/comunidade">{m.biblioteca_community_link()}</a>
		</div>
	</section>
	<div class="hardware-note">
		<EmBreve title={m.biblioteca_read_cable()} />
		<p>{m.biblioteca_hardware()}</p>
	</div>
	<div class="notice" role="status">{notice}</div>
</div>
<Tour page="biblioteca" />

{#if selected}
	{@const tape = selected}
	{#await import('./TrackSheet.svelte') then { default: TrackSheet }}
		{#key tape.id}<TrackSheet
				{tape}
				{current}
				{origin}
				{locale}
				{app}
				{verdict}
				{audioState}
				onClose={() => {
					selected = null;
				}}
				onStatus={(message) => {
					notice = message;
				}}
				onOutputMeter={(update) => {
					outputUpdate = update;
				}}
				onEdited={() => {
					// The store already holds the edit: reopen the same box from the fresh shelf.
					selected = tapes.find((candidate) => candidate.id === tape.id) ?? selected;
				}}
			/>{/key}
	{:catch}
		<p role="alert">{m.layout_error_generic()}</p>
	{/await}
{/if}

<style>
	.room {
		position: relative;
		isolation: isolate;
		padding: 0 28px 48px;
		overflow: hidden;
		color: #ece7dd;
		background:
			linear-gradient(90deg, #0006, transparent 20% 80%, #0006),
			repeating-linear-gradient(1deg, #0000 0 3px, #21130955 4px, #0000 6px 12px),
			repeating-linear-gradient(
				90deg,
				#5b3823 0,
				#44291c 5px,
				#71472b 7px,
				#4c2d1c 10px,
				#3b251a 90px,
				#241810 92px,
				#6b4328 96px,
				#4a2e1e 170px
			);
		font:
			14px/1.5 'Geist',
			Arial,
			sans-serif;
	}
	.window {
		position: absolute;
		z-index: -2;
		top: 10px;
		left: 12%;
		right: 12%;
		height: 265px;
		border: 13px ridge #30271e;
		background:
			linear-gradient(120deg, #96896825, #28302d88 55%, #bda76d18),
			repeating-linear-gradient(90deg, #0000 0 24%, #191a16 24% 25%);
		box-shadow:
			inset 0 0 70px #000,
			0 0 90px #cba76d22;
	}
	.hero {
		position: relative;
		max-width: 1500px;
		min-height: 270px;
		box-sizing: border-box;
		margin: auto;
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 34px 250px 28px;
		text-align: center;
	}
	h1,
	h2,
	h3,
	p {
		margin: 0;
	}
	h1 {
		font:
			italic 88px/0.95 'Instrument Serif',
			Georgia,
			serif;
		letter-spacing: -0.035em;
		text-shadow: 0 4px 12px #000;
	}
	.caps {
		font-size: 10px;
		letter-spacing: 0.15em;
		text-transform: uppercase;
	}
	.hero .caps {
		color: #ebdcb9;
		margin-bottom: 13px;
	}
	.hero p {
		color: #e0d4bd;
		font:
			12px/1.7 'Courier Prime',
			monospace;
		max-width: 440px;
		margin: 16px auto 0;
	}
	.room-number {
		display: inline-block;
		border: 1px solid #c8bda64a;
		padding: 3px 10px;
		margin-top: 16px;
		color: #f4c66e;
		font:
			9px 'JetBrains Mono',
			monospace;
	}
	.deck-left,
	.deck-right {
		position: absolute;
		top: 21px;
		transform: rotate(-5deg);
	}
	.deck-left {
		left: 4px;
	}
	.deck-right {
		right: 4px;
		transform: rotate(5deg);
	}
	.tape-path {
		position: absolute;
		top: 183px;
		left: 170px;
		right: 170px;
		height: 44px;
		border-bottom: 5px solid #1c130e;
		border-radius: 0 0 50% 50%;
		z-index: -1;
	}
	.archive {
		max-width: 1500px;
		margin: 25px auto 0;
		padding: 24px 26px 0;
		border: 1px solid #84604155;
		background: linear-gradient(140deg, #34251bf5, #17130fed);
		box-shadow:
			inset 0 1px #a6794a66,
			0 14px 30px #0006;
	}
	.archive-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: 18px;
		margin-bottom: 22px;
	}
	h2 {
		color: #ede0bf;
		font:
			38px/1.1 'Instrument Serif',
			Georgia,
			serif;
	}
	.archive-head p,
	.count {
		color: #e0cdae;
		font:
			10px/1.8 'JetBrains Mono',
			monospace;
	}
	.archive-head p {
		margin-top: 8px;
	}
	.controls {
		display: grid;
		grid-template-columns: 1.35fr 1.25fr 0.85fr;
		gap: 20px;
		align-items: center;
		padding: 17px;
		background: linear-gradient(145deg, #616b5b, #48523f);
		border: 1px solid #7a82665c;
		box-shadow:
			0 4px 7px #0007,
			inset 1px 1px #d4d4ac44;
	}
	.log-card {
		transform: rotate(-1deg);
		padding: 9px 13px;
		background: repeating-linear-gradient(0deg, transparent 0 24px, #75633e2b 25px 26px), #e1d6b9;
		color: #302c23;
		box-shadow: 1px 3px 4px #0006;
	}
	.log-card label {
		display: block;
		font:
			10px 'Courier Prime',
			monospace;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.log-card input {
		box-sizing: border-box;
		width: 100%;
		padding: 7px 0 2px;
		color: #302c23;
		background: transparent;
		border: 0;
		font:
			16px 'Courier Prime',
			monospace;
	}
	.log-card input::placeholder {
		color: #5e523d;
	}
	fieldset {
		min-width: 0;
		border: 0;
		padding: 0;
		margin: 0;
	}
	legend {
		font:
			9px 'JetBrains Mono',
			monospace;
		color: #f0efd7;
		margin-bottom: 8px;
		text-transform: uppercase;
	}
	.filter-buttons {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.push {
		min-height: 34px;
		padding: 6px 9px;
		background: linear-gradient(#454b3e, #282e24);
		border: 1px solid #171c15;
		box-shadow:
			0 3px #1b2118,
			inset 0 1px #a8ad8d33;
		color: #f3efd9;
		font:
			10px 'JetBrains Mono',
			monospace;
	}
	.push[aria-pressed='true'] {
		background: linear-gradient(#edc57a, #bc8e3a);
		color: #211e15;
		box-shadow: 0 1px #292919;
		transform: translateY(2px);
	}
	.sort-panel {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 15px;
	}
	.knob {
		width: 48px;
		height: 48px;
		flex-shrink: 0;
		border-radius: 50%;
		background: repeating-conic-gradient(#171813 0deg 4deg, #45483b 5deg 7deg, #25271f 8deg 10deg);
		border: 5px solid #282b21;
		box-shadow: 0 0 0 4px #9c9d7933;
	}
	.knob:after {
		content: '';
		display: block;
		height: 20px;
		width: 3px;
		background: #d2c59e;
		margin: 2px auto;
	}
	.sort-panel label {
		font:
			9px 'JetBrains Mono',
			monospace;
		text-transform: uppercase;
		color: #f0efd7;
	}
	.sort-panel select {
		display: block;
		width: 100%;
		max-width: 170px;
		margin-top: 7px;
		padding: 8px 4px;
		font:
			11px 'JetBrains Mono',
			monospace;
		color: #f3eed5;
		background: #293023;
		border: 1px solid #abb28c66;
	}
	.reference {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		flex-wrap: wrap;
		gap: 14px;
		margin: 20px 0;
		font:
			10px/1.8 'JetBrains Mono',
			monospace;
		color: #e0cdae;
	}
	.reference details {
		max-width: 550px;
	}
	.reference summary {
		cursor: pointer;
	}
	.reference p {
		margin-top: 12px;
	}
	.shelf-group {
		content-visibility: auto;
		contain-intrinsic-size: auto 600px;
		overflow-clip-margin: 16px;
	}
	.shelf-title {
		display: flex;
		align-items: center;
		gap: 15px;
		padding: 14px 0 12px;
		border-top: 1px solid #b99c6a44;
		color: #decaa5;
	}
	.shelf-title h3 {
		margin-right: auto;
		font:
			22px 'Courier Prime',
			monospace;
	}
	.shelf-title span {
		font:
			10px 'JetBrains Mono',
			monospace;
	}
	.shelf-action {
		display: inline-flex;
	}
	.shelves {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 36px 24px;
		padding: 8px 3px 28px;
	}
	.tape {
		position: relative;
		display: block;
		width: 100%;
		min-width: 0;
		border: 1px solid #b6a17c;
		border-radius: 2px 4px 3px 1px;
		text-align: left;
		padding: 0;
		background:
			repeating-linear-gradient(0deg, #0000 0 3px, #9b805408 4px),
			linear-gradient(130deg, #eaddbd, #cab892 90%);
		color: #302c23;
		box-shadow:
			inset 3px 0 #f5ebcc,
			inset -7px 0 #9e896533,
			3px 5px 5px #0008,
			0 16px 0 -5px #805236,
			0 18px 0 -5px #241910;
		transform: perspective(900px) rotateY(-3deg);
		transition: transform 0.24s;
		cursor: pointer;
	}
	.tape:before {
		content: '';
		position: absolute;
		left: -8px;
		top: -1px;
		bottom: -1px;
		width: 8px;
		background: linear-gradient(90deg, #95805d, #ccba93);
		transform-origin: right;
		transform: skewY(-20deg);
		border: 1px solid #3a2f1f;
	}
	.tape:hover {
		transform: perspective(900px) rotateY(-7deg) translateY(-6px);
	}
	.tape.active {
		outline: 2px solid #d9a441;
		outline-offset: 4px;
	}
	.tape-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 15px 9px;
		border-bottom: 1px solid #63543945;
		font:
			10px 'JetBrains Mono',
			monospace;
	}
	.dot {
		width: 8px;
		height: 8px;
		border: 1px solid #6f6049;
		border-radius: 50%;
		background: #716342;
	}
	.tape-label {
		position: relative;
		display: block;
		margin: 12px 14px 0;
		background: #eee5cc99;
		border: 1px solid #81725255;
		padding: 12px 11px 8px;
	}
	.tape-label:before {
		content: '';
		width: 47px;
		height: 14px;
		background: #baa16a66;
		position: absolute;
		top: -8px;
		left: calc(50% - 23px);
		transform: rotate(-6deg);
	}
	.tape-label strong {
		display: block;
		font:
			700 23px/1.05 'Courier Prime',
			monospace;
		letter-spacing: -0.045em;
		overflow-wrap: anywhere;
	}
	.tape-label > span {
		display: block;
		margin-top: 7px;
		font:
			10px 'Courier Prime',
			monospace;
		overflow-wrap: anywhere;
	}
	.tape-chart {
		display: block;
		padding: 14px 15px;
	}
	.tape-description,
	.tape small,
	.tape-tags {
		display: block;
		padding: 0 15px 10px;
		font:
			12px/1.5 'Courier Prime',
			monospace;
	}
	.tape small {
		font-size: 10px;
	}
	/* A local curve's own description keeps its line breaks (at most five, S5). */
	.own-description {
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.tape-tags {
		font-size: 12px;
	}
	.tape-bottom {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		flex-wrap: wrap;
		padding: 10px 15px;
		border-top: 1px solid #63543945;
		font:
			10px 'JetBrains Mono',
			monospace;
	}
	.empty {
		display: grid;
		justify-items: start;
		gap: 12px;
		padding: 15px 0 25px;
		color: #e0cdae;
	}
	/* Design system v2.1 faces and scale (spec §2.1): Geist body, --type engraving, mono data. */
	.room {
		font: 400 var(--fs-ui, 14px) / 1.5 var(--face-body, 'Geist', Arial, sans-serif);
	}
	.tour-trigger {
		display: flex;
		justify-content: center;
		margin-top: 16px;
	}
	.reference-select {
		display: grid;
		gap: 6px;
		font: 400 var(--label-min, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.reference-select select {
		min-height: 36px;
		max-width: 300px;
		padding: 6px 8px;
		color: #f3eed5;
		background: #293023;
		border: 1px solid #abb28c99;
		font: 400 var(--fs-small, 13px) / 1.3 var(--face-body, 'Geist', sans-serif);
		text-transform: none;
		letter-spacing: 0;
	}
	.tape-header {
		gap: 8px;
		font: 400 var(--label-min, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
	}
	.serial {
		margin-right: auto;
		font-weight: 500;
		letter-spacing: 0.08em;
	}
	.tape-label strong,
	.tape-label h4 {
		display: block;
		margin: 0;
		font: 700 23px/1.05 var(--type, 'Courier Prime', monospace);
		letter-spacing: -0.045em;
		overflow-wrap: anywhere;
	}
	.tape-label > .tape-sub {
		display: flex;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 4px 10px;
		font: 400 var(--label-min, 11px) / 1.4 var(--type, 'Courier Prime', monospace);
	}
	.tape-description,
	.tape small,
	.tape-tags {
		font-family: var(--type, 'Courier Prime', monospace);
	}
	.mini-frame {
		position: relative;
		display: block;
		padding-left: 28px;
	}
	.mini-frame :global(svg) {
		border-left: 1px solid #63543977;
		border-bottom: 1px solid #63543977;
	}
	.mini-y {
		position: absolute;
		inset: 0 auto 0 0;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
	}
	.mini-x {
		position: relative;
		display: block;
		height: 1.4em;
		margin: 3px 0 0 28px;
	}
	.mini-x span {
		position: absolute;
		top: 0;
		transform: translateX(-50%);
	}
	/* Log axis: 20 Hz at 0, 1 kHz at log10(50) / 3 = 56.6 %, 20 kHz at 100 %. */
	.mini-x span:nth-child(1) {
		left: 0;
		transform: none;
	}
	.mini-x span:nth-child(2) {
		left: 56.6%;
	}
	.mini-x span:nth-child(3) {
		left: 100%;
		transform: translateX(-100%);
	}
	.mini-y,
	.mini-x {
		color: #4c4130;
		font: 400 var(--label-min, 11px) / 1 var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums;
	}
	.tape-bottom {
		font: 400 var(--label-min, 11px) / 1.4 var(--face-data, 'JetBrains Mono', monospace);
		font-variant-numeric: tabular-nums slashed-zero;
	}
	.tape {
		transition: transform var(--dur-slow, 0.36s) var(--ease-out, ease-out);
	}
	/* The open box slides out of the shelf while its sheet is open (UI transition, not data). */
	.tape.active {
		transform: perspective(900px) rotateY(-2deg) translate(8px, -18px);
		transition: transform var(--dur-scene, 0.72s) var(--ease-out, ease-out);
	}
	.pack-box,
	.example-box {
		position: relative;
		display: block;
		min-width: 0;
		border: 1px solid #b6a17c;
		border-radius: 2px 4px 3px 1px;
		background:
			repeating-linear-gradient(0deg, #0000 0 3px, #9b805408 4px),
			linear-gradient(130deg, #eaddbd, #cab892 90%);
		color: #302c23;
		box-shadow:
			inset 3px 0 #f5ebcc,
			inset -7px 0 #9e896533,
			3px 5px 5px #0008,
			0 16px 0 -5px #805236,
			0 18px 0 -5px #241910;
	}
	.pack-box {
		overflow-wrap: anywhere;
		background:
			repeating-linear-gradient(0deg, #0000 0 3px, #9b805408 4px),
			linear-gradient(130deg, #e2d5b2, #bfae86 90%);
	}
	.pack-box p {
		margin: 0;
	}
	.pack-art {
		display: grid;
		place-items: center;
		height: 72px;
		margin: 14px 15px;
		border: 2px solid #5b4725;
		color: #5b4725;
		font: italic 400 var(--fs-title, 26px) / 1 var(--face-display, 'Instrument Serif', serif);
	}
	.pack-action {
		padding: 10px 15px 14px;
	}
	.examples {
		margin: 0;
		list-style: none;
	}
	.example-box {
		border-style: dashed;
		padding-bottom: 12px;
	}
	.library-empty {
		color: #e0cdae;
		padding: 6px 0 18px;
	}
	.account-card {
		margin: 4px 0 22px;
		padding: 16px 18px;
		border: 1px solid #b99c6a44;
		border-radius: var(--rad-md, 6px);
		background: #17130fcc;
	}
	.shelves :global(.tape-skeleton) {
		border-radius: 2px 4px 3px 1px;
	}
	.community {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
		padding: 24px 0;
		border-top: 1px solid #b99c6a44;
		color: #e0cdae;
	}
	.community h3 {
		font:
			22px 'Courier Prime',
			monospace;
	}
	.community p {
		font-size: 12px;
		margin-top: 5px;
	}
	.community a {
		color: inherit;
		font-size: 12px;
		text-underline-offset: 4px;
	}
	button:not(.tape, .push) {
		min-height: 36px;
		padding: 8px 12px;
		border: 1px solid #b5ae9477;
		border-radius: 2px;
		background: #272d23;
		color: #ece7dd;
		cursor: pointer;
		font-family: inherit;
	}
	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.notice {
		max-width: 1000px;
		margin: 20px auto 0;
		color: #ffdf9d;
		font:
			12px 'JetBrains Mono',
			monospace;
	}
	.notice:empty {
		margin: 0;
	}
	.hardware-note {
		max-width: 1500px;
		margin: 24px auto 0;
	}
	.hardware-note p {
		margin-top: 18px;
		color: #ded0b5;
		font:
			10px/1.8 'JetBrains Mono',
			monospace;
	}
	:where(button, a, input, select, summary):focus-visible {
		outline: 3px solid #f6bd55;
		outline-offset: 4px;
	}
	@media (max-width: 1200px) {
		.shelves {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.controls {
			grid-template-columns: 1fr 1.2fr;
		}
		.sort-panel {
			grid-column: 1 / -1;
			justify-content: center;
		}
		.hero {
			padding-inline: 210px;
		}
		h1 {
			font-size: 74px;
		}
	}
	@media (max-width: 780px) {
		.room {
			padding-inline: 13px;
		}
		.window {
			display: none;
		}
		.hero:before {
			content: '';
			position: absolute;
			z-index: -1;
			inset: 4px 0 6px;
			border: 11px ridge #30271e;
			background:
				linear-gradient(120deg, #96896825, #28302d88 55%, #bda76d18),
				repeating-linear-gradient(90deg, #0000 0 24%, #191a16 24% 25%);
			box-shadow: inset 0 0 60px #000;
		}
		.hero {
			padding: 132px 20px 34px;
		}
		.deck-left,
		.deck-right {
			top: 14px;
		}
		.deck-left {
			left: 12px;
		}
		.deck-right {
			right: 12px;
		}
		.tape-path {
			left: 60px;
			right: 60px;
			top: 82px;
			height: 32px;
		}
		h1 {
			font-size: 65px;
		}
		.hero p {
			font-size: 11px;
		}
		.hero .caps {
			font-size: 8px;
		}
		.archive {
			padding: 20px 16px 0;
		}
		.archive-head {
			align-items: flex-start;
			flex-direction: column;
		}
		.archive-head h2 {
			font-size: 30px;
		}
		.archive-head p,
		.count {
			font-size: 9px;
		}
		.controls {
			grid-template-columns: 1fr;
			gap: 18px;
			padding: 13px;
		}
		.sort-panel {
			grid-column: auto;
			justify-content: space-between;
		}
		.shelves {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 32px 19px;
		}
		.community {
			align-items: flex-start;
			flex-direction: column;
		}
		.shelf-group {
			/* Keep narrow shelf headers and their hit targets out of skipped/clipped layout. */
			content-visibility: visible;
			contain-intrinsic-size: none;
		}
		.shelf-title {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 16px;
		}
		.shelf-title h3 {
			min-width: 0;
			margin-right: 0;
			overflow-wrap: anywhere;
		}
		.shelf-title > .shelf-action {
			/* Give the action its own full-width row, never the remainder beside the title. */
			grid-column: 1 / -1;
		}
		.shelf-action :global(button) {
			box-sizing: border-box;
			width: 100%;
			min-width: 44px;
			min-height: 44px;
			white-space: normal;
			overflow-wrap: anywhere;
		}
	}
	@media (max-width: 440px) {
		.shelves {
			grid-template-columns: 1fr;
			padding-inline: 6px;
		}
		.tape-label strong {
			font-size: 25px;
		}
		.tape-chart {
			padding-block: 8px;
		}
		.tape-chart :global(svg) {
			max-height: 100px;
		}
		h1 {
			font-size: 62px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.tape {
			transition: none;
		}
		.tape:hover,
		.tape.active {
			transform: none;
			transition: none;
		}
	}
</style>
