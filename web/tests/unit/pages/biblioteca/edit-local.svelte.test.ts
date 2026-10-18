// LIBEDIT: name and description of a personal curve in the local (browser) library, edited
// from the Biblioteca track sheet. The store is the real one, in memory (no IndexedDB).
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { createClientApp, type ClientApp } from '#lib/app/client.svelte.ts';
import { createAudioEngine, IDLE_STATE } from '#lib/audio/engine.ts';
import { neutralCurve, type CurveData } from '#lib/state/model.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';
import Biblioteca from '#lib/components/pages/biblioteca/Biblioteca.svelte';
import TrackSheet from '#lib/components/pages/biblioteca/TrackSheet.svelte';
import { archiveTapes, type Tape } from '#lib/components/pages/biblioteca/archive.ts';

// Before integration, layer this task's staging keys over the generated copy. After the merge
// deletes staging, the same tests consume the merged catalogs.
vi.mock('#lib/paraglide/messages.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('#lib/paraglide/messages.js')>();
	const { getLocale } = await import('#lib/paraglide/runtime.js');
	const catalogs = import.meta.glob<Record<string, string>>(
		[
			'../../../../messages/_staging/LIBEDIT.*.json',
			'../../../../messages/pt-BR.json',
			'../../../../messages/en-US.json'
		],
		{ eager: true, import: 'default' }
	);
	const catalog = (locale: string) =>
		Object.assign(
			{},
			...Object.entries(catalogs)
				.filter(([path]) => path.endsWith(`${locale}.json`))
				.map(([, values]) => values)
		) as Record<string, string>;
	const pt = catalog('pt-BR');
	const en = catalog('en-US');
	const task = Object.fromEntries(
		Object.keys(pt)
			.filter((key) => key.startsWith('biblioteca_edit_'))
			.map((key) => [key, () => (getLocale() === 'en-US' ? en : pt)[key]])
	);
	return { ...original, m: { ...original.m, ...task } };
});
// The gate verdict does not matter here: keep it pending rather than spawning a worker.
vi.mock('#lib/workers/gate-client.ts', () => ({
	createGateWorker: () => ({
		commit: () => new Promise(() => undefined),
		dispose: () => undefined
	})
}));

let app: ClientApp | null = null;
afterEach(async () => {
	await cleanup();
	app?.dispose();
	await app?.audio.dispose();
	app = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

/** A message as an exact RegExp fragment. */
function literal(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function curve(name: string, preampDb = -3): CurveData {
	return { name, source: 'custom', preampDb, bands: neutralCurve().bands };
}

/** A real client app with an in-memory library holding one saved curve. */
async function libraryApp(name = 'Minha curva') {
	app = createClientApp({
		storage: { local: null, session: null, indexedDB: null, channel: null },
		audio: createAudioEngine({ indexedDB: null })
	});
	await app.state.ready;
	const saved = await app.state.library.save(curve(name));
	if (!saved) throw new Error('Could not prepare the local library');
	return { client: app, saved };
}

/** Renders the page and opens the local curve's sheet from its shelf card. */
async function openLocalSheet(client: ClientApp) {
	const screen = await render(Biblioteca, { app: client, origin: 'https://example.test' });
	const card = () =>
		screen.container.querySelector<HTMLButtonElement>('[data-tour="biblioteca-shelf"] .tape');
	await expect.poll(() => card()).not.toBeNull();
	card()?.click();
	await expect.element(page.getByRole('dialog')).toBeVisible();
	return {
		screen,
		card,
		heading: () => screen.container.querySelector('dialog h2')?.textContent,
		open: page.getByRole('button', { name: m.biblioteca_edit_open(), exact: true }),
		name: page.getByRole('textbox', { name: m.biblioteca_edit_name(), exact: true }),
		description: page.getByRole('textbox', {
			name: m.biblioteca_edit_description(),
			exact: true
		}),
		save: page.getByRole('button', { name: m.biblioteca_edit_save(), exact: true }),
		cancel: page.getByRole('button', { name: m.biblioteca_edit_cancel(), exact: true })
	};
}

for (const locale of ['pt-BR', 'en-US'] as const) {
	test(`editing a local curve saves the name and description to the card, sheet and envelope in ${locale}`, async () => {
		await setLocale(locale, { reload: false });
		const { client, saved } = await libraryApp();
		const sheet = await openLocalSheet(client);
		expect(sheet.heading()).toBe('Minha curva');
		await sheet.open.click();
		await expect.element(sheet.name).toHaveFocus();
		await expect.element(sheet.name).toHaveValue('Minha curva');
		await expect.element(sheet.name).toHaveAttribute('maxlength', '48');
		await expect.element(sheet.description).toHaveAttribute('maxlength', '280');
		await sheet.name.fill('Graves de domingo');
		await sheet.description.fill('Para ouvir jazz.\nSem pressa.');
		await sheet.save.click();

		await expect.poll(sheet.heading).toBe('Graves de domingo');
		await expect
			.poll(() => sheet.card()?.querySelector('.tape-label strong')?.textContent)
			.toBe('Graves de domingo');
		expect(sheet.card()?.querySelector('.own-description')?.textContent).toBe(
			'Para ouvir jazz.\nSem pressa.'
		);
		expect(sheet.screen.container.querySelector('dialog .own-description')?.textContent).toBe(
			'Para ouvir jazz.\nSem pressa.'
		);
		await expect
			.element(page.getByText(m.biblioteca_edit_local_description(), { exact: true }).first())
			.toBeVisible();
		// The form closed and gave focus back to its opener; the page announced the save.
		await expect.element(sheet.open).toHaveFocus();
		await expect.poll(() => sheet.screen.container.querySelector('.edit-form')).toBeNull();
		await expect
			.element(sheet.screen.container.querySelector<HTMLElement>('.notice'))
			.toHaveTextContent(m.biblioteca_edit_saved());
		// Persisted in the store with a newer updatedAt, same id and curve.
		const [item] = client.state.library.items;
		expect(item).toMatchObject({
			id: saved.id,
			name: 'Graves de domingo',
			description: 'Para ouvir jazz.\nSem pressa.',
			s1: saved.s1
		});
		expect(item.updatedAt).toBeGreaterThan(saved.updatedAt);
		// The local S5 envelope uses the stored description.
		const envelope = sheet.screen.container.querySelector('dialog .envelope pre')?.textContent;
		expect(JSON.parse(envelope ?? '{}')).toMatchObject({
			name: 'Graves de domingo',
			description: 'Para ouvir jazz.\nSem pressa.'
		});
	});
}

test('invalid text shows the envelope issues, keeps the form open and writes nothing', async () => {
	const { client, saved } = await libraryApp();
	const sheet = await openLocalSheet(client);
	await sheet.open.click();
	await sheet.name.fill('   ');
	await sheet.description.fill('Veja www.exemplo.com');
	await sheet.save.click();
	await expect
		.element(page.getByText(m.biblioteca_edit_name_length(), { exact: true }))
		.toBeVisible();
	await expect.element(page.getByText(m.biblioteca_edit_url(), { exact: true })).toBeVisible();
	await expect.element(sheet.name).toHaveAttribute('aria-invalid', 'true');
	await expect.element(sheet.description).toHaveAttribute('aria-invalid', 'true');
	await expect.element(sheet.name).toHaveFocus();
	await expect
		.element(sheet.name)
		.toHaveAccessibleDescription(new RegExp(literal(m.biblioteca_edit_name_length())));
	// Typing in a field clears that field's issue only.
	await sheet.name.fill('Nome válido');
	await expect.element(sheet.name).toHaveAttribute('aria-invalid', 'false');
	await expect.element(page.getByText(m.biblioteca_edit_url(), { exact: true })).toBeVisible();
	await sheet.description.fill('1\n2\n3\n4\n5\n6');
	await sheet.save.click();
	await expect
		.element(page.getByText(m.biblioteca_edit_description_length(), { exact: true }))
		.toBeVisible();
	await expect.element(sheet.description).toHaveFocus();
	expect(sheet.heading()).toBe('Minha curva');
	expect(client.state.library.items[0]).toMatchObject({
		name: 'Minha curva',
		description: '',
		updatedAt: saved.updatedAt
	});
});

test('Cancelar and Esc discard the draft, keep the sheet open and restore the saved text', async () => {
	const { client, saved } = await libraryApp();
	const sheet = await openLocalSheet(client);
	await sheet.open.click();
	await sheet.name.fill('Rascunho');
	await sheet.description.fill('Não salvar');
	await sheet.cancel.click();
	await expect.poll(() => sheet.screen.container.querySelector('.edit-form')).toBeNull();
	await expect.element(sheet.open).toHaveFocus();
	expect(sheet.heading()).toBe('Minha curva');
	await sheet.open.click();
	await expect.element(sheet.name).toHaveValue('Minha curva');
	await expect.element(sheet.description).toHaveValue('');
	await sheet.name.fill('Outro rascunho');
	await userEvent.keyboard('{Escape}');
	await expect.poll(() => sheet.screen.container.querySelector('.edit-form')).toBeNull();
	// Esc closed the form only: the sheet is still open, and focus is back on the opener.
	expect(sheet.screen.container.querySelector('dialog')).not.toBeNull();
	await expect.element(sheet.open).toHaveFocus();
	expect(sheet.heading()).toBe('Minha curva');
	expect(client.state.library.items[0]).toMatchObject({
		name: 'Minha curva',
		updatedAt: saved.updatedAt
	});
	// With the form closed, Esc closes the sheet as before.
	await userEvent.keyboard('{Escape}');
	await expect.poll(() => sheet.screen.container.querySelector('dialog')).toBeNull();
});

test('only personal local curves offer the edit; it says why while the runtime loads', async () => {
	const [official] = archiveTapes([]);
	const local: Tape = {
		...official,
		id: 'local:mine',
		group: 'local',
		source: 'custom',
		name: 'Minha',
		description: '',
		descriptionEn: null
	};
	const props = {
		current: neutralCurve(),
		origin: 'https://example.test',
		locale: 'pt-BR' as const,
		app: null,
		verdict: null,
		audioState: { ...IDLE_STATE },
		onClose: vi.fn(),
		onStatus: vi.fn()
	};
	const label = m.biblioteca_edit_open();
	const screen = await render(TrackSheet, { ...props, tape: official });
	expect(screen.container.textContent).not.toContain(label);
	await screen.rerender({ ...props, tape: { ...local, source: 'community:abc' } });
	expect(screen.container.textContent).not.toContain(label);
	await screen.rerender({ ...props, tape: local });
	const edit = page.getByRole('button', { name: label, exact: true });
	await expect.element(edit).toHaveAttribute('aria-disabled', 'true');
	await expect.element(edit).toHaveAccessibleDescription(m.biblioteca_reason_loading());
	(edit.element() as HTMLButtonElement).click();
	expect(screen.container.querySelector('.edit-form')).toBeNull();
});
