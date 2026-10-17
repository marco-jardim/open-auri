<!--
	Packs (VCA): create a pack from your favorites and list your packs. Signed in and verified only
	(the page's single account card explains it; here the action says why it is unavailable). Names
	and descriptions are user text, shown only through interpolation. The page mounts this panel
	only when its drawer opens, so nothing is requested before that.
-->
<script lang="ts">
	import Button from '#lib/components/primitives/Button.svelte';
	import { m } from '#lib/paraglide/messages.js';
	import type { LibraryItem, SocialApi } from '#lib/social/index.ts';
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

	/** Why "Criar pack" cannot act right now; null when it can (T8). */
	const createReason = $derived(
		!session.verified
			? session.signedIn
				? m.comunidade_verify_prompt()
				: m.comunidade_v2_reason_account()
			: !online
				? m.comunidade_offline()
				: name.trim() === '' || chosen.length === 0
					? m.comunidade_v2_reason_pack_name()
					: null
	);

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

<div class="packs" data-testid="packs-panel">
	{#if !session.verified}
		<div class="row-btns">
			<Button variant="primary" disabledReason={createReason}>{m.comunidade_packs_create()}</Button>
		</div>
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
				<label for="{id}-visibility">
					<span class="fld-lbl">{m.comunidade_onair_visibility()}</span>
				</label>
				<select id="{id}-visibility" class="desk-select" bind:value={visibility}>
					<option value="public">{m.comunidade_visibility_public()}</option>
					<option value="unlisted">{m.comunidade_visibility_unlisted()}</option>
					<option value="private">{m.comunidade_visibility_private()}</option>
				</select>
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
				<div>
					<Button variant="primary" disabledReason={createReason} loading={busy} onclick={create}
						>{m.comunidade_packs_create()}</Button
					>
				</div>
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
</div>

<style>
	.packs {
		padding-top: var(--space-3);
	}
	.packs-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-5);
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
		max-height: 220px;
		overflow: auto;
		margin: 0;
		padding: var(--space-2) 10px;
		border: 1px solid var(--rule-control);
		border-radius: var(--rad-md);
	}
	.check {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 24px;
		font-size: var(--fs-small);
		overflow-wrap: anywhere;
	}
	.check input {
		accent-color: var(--accent);
	}
	.pack-list {
		display: grid;
		gap: var(--space-2);
		margin: 6px 0 0;
		padding: 0;
		list-style: none;
	}
	.pack-list li {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px var(--space-2);
		align-items: center;
	}
	.vca-plate {
		padding: 2px 6px;
		border-radius: var(--rad-xs);
		background: linear-gradient(#e9d9b4, #c8b48a);
		color: #1b1206;
		font: 500 var(--label-min) var(--face-data);
	}
	.pack-name {
		font: var(--fs-ui) var(--marker);
		overflow-wrap: anywhere;
	}
	.pack-desc {
		grid-column: 2;
		color: var(--muted-hi);
		font-size: var(--fs-caption);
		overflow-wrap: anywhere;
	}
	@media (max-width: 1000px) {
		.packs-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
