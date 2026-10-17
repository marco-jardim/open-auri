<!--
	Packs (VCA): create a pack from your favorites and list your packs. Signed in and verified only;
	names and descriptions are user text, shown only through interpolation.
-->
<script lang="ts">
	import { m } from '#lib/paraglide/messages.js';
	import type { LibraryItem, SocialApi } from '#lib/social/index.ts';
	import LoginPrompt from './LoginPrompt.svelte';
	import {
		DESCRIPTION_MAX,
		NAME_MAX,
		errorText,
		type SessionView,
		type Visibility
	} from './model.ts';

	interface PackRow {
		id: string;
		name: string;
		description: string;
	}

	let { api, session, online }: { api: SocialApi; session: SessionView; online: boolean } =
		$props();

	const id = $props.id();
	let favorites = $state.raw<LibraryItem[]>([]);
	let packs = $state.raw<PackRow[]>([]);
	let chosen = $state<string[]>([]);
	let name = $state('');
	let description = $state('');
	let visibility = $state<Visibility>('private');
	let busy = $state(false);
	let message = $state('');

	$effect(() => {
		if (!session.verified || !online) return;
		void load();
	});

	async function load() {
		try {
			const [shelf, list] = await Promise.all([
				api.myLibrary({ shelf: 'favorites', limit: 100 }),
				api.myPacks({ limit: 50 })
			]);
			favorites = shelf.items;
			packs = list.items.map((pack) => ({
				id: pack.id,
				name: pack.name,
				description: pack.description
			}));
		} catch (error) {
			message = errorText(error);
		}
	}

	async function create() {
		if (busy || name.trim() === '' || chosen.length === 0) return;
		busy = true;
		message = '';
		try {
			const pack = await api.createPack({ name, description, visibility, items: [...chosen] });
			packs = [{ id: pack.id, name: pack.name, description: pack.description }, ...packs];
			chosen = [];
			name = '';
			description = '';
			message = m.comunidade_packs_created();
		} catch (error) {
			message = errorText(error);
		} finally {
			busy = false;
		}
	}
</script>

<section class="panel packs" aria-labelledby="{id}-title">
	<div class="sec-head">
		<h2 id="{id}-title">{m.comunidade_packs_title()}</h2>
		<p>{m.comunidade_packs_lede()}</p>
	</div>
	{#if !session.verified}
		<LoginPrompt signedIn={session.signedIn} />
	{:else}
		<div class="packs-grid">
			<div class="producer">
				<label>
					<span class="fld-lbl">{m.comunidade_packs_name()}</span>
					<input class="plain-input" maxlength={NAME_MAX} bind:value={name} autocomplete="off" />
				</label>
				<label>
					<span class="fld-lbl">{m.comunidade_onair_description()}</span>
					<textarea maxlength={DESCRIPTION_MAX} bind:value={description}></textarea>
				</label>
				<label>
					<span class="fld-lbl">{m.comunidade_onair_visibility()}</span>
					<select bind:value={visibility}>
						<option value="public">{m.comunidade_visibility_public()}</option>
						<option value="unlisted">{m.comunidade_visibility_unlisted()}</option>
						<option value="private">{m.comunidade_visibility_private()}</option>
					</select>
				</label>
				<fieldset>
					<legend class="fld-lbl">{m.comunidade_packs_from_favorites()}</legend>
					{#if favorites.length === 0}
						<p class="note">{m.comunidade_packs_no_favorites()}</p>
					{:else}
						{#each favorites as item (item.id)}
							<label class="check">
								<input type="checkbox" value={item.id} bind:group={chosen} />
								<span>{item.head.name}</span>
							</label>
						{/each}
					{/if}
				</fieldset>
				<button
					type="button"
					class="btn primary"
					disabled={busy || !online || name.trim() === '' || chosen.length === 0}
					onclick={create}>{m.comunidade_packs_create()}</button
				>
				<p class="note" role="status">{message}</p>
			</div>
			<div>
				<span class="fld-lbl">{m.comunidade_packs_yours()}</span>
				{#if packs.length === 0}
					<p class="note">{m.comunidade_packs_none()}</p>
				{:else}
					<ul class="pack-list">
						{#each packs as pack (pack.id)}
							<li>
								<span class="vca-plate">VCA</span>
								<span class="pack-name">{pack.name}</span>
								{#if pack.description}<span class="pack-desc">{pack.description}</span>{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	{/if}
</section>

<style>
	.packs {
		background: linear-gradient(180deg, #2f2b27, #1f1c19);
	}
	.packs-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 20px;
	}
	.producer {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.producer label:not(.check) {
		display: flex;
		flex-direction: column;
	}
	fieldset {
		border: 1px solid #ffffff1c;
		border-radius: 4px;
		padding: 8px 10px;
		margin: 0;
		max-height: 220px;
		overflow: auto;
	}
	.check {
		display: flex;
		gap: 8px;
		align-items: center;
		font-size: 12.5px;
		overflow-wrap: anywhere;
	}
	.check input {
		accent-color: var(--accent);
	}
	select {
		background: #0f0e0c;
		color: #ece7dd;
		border: 1px solid #000;
		padding: 6px 8px;
		font: 12px var(--mono);
	}
	.pack-list {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}
	.pack-list li {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 8px;
		align-items: center;
	}
	.vca-plate {
		font: 700 11px var(--mono);
		color: #1b1206;
		background: linear-gradient(#e9d9b4, #c8b48a);
		padding: 2px 6px;
		border-radius: 2px;
	}
	.pack-name {
		font: 14px var(--marker);
		overflow-wrap: anywhere;
	}
	.pack-desc {
		grid-column: 2;
		font-size: 12px;
		color: #bdb7ab;
		overflow-wrap: anywhere;
	}
	@media (max-width: 1000px) {
		.packs-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
