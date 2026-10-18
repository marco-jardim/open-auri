// Preparo's output (SAÍDA) is preselected from the live cable: a connected real cable means
// "Cabo em Neutro" unless the last real write was not Neutro; no cable (or no WebHID, a simulated
// cable) means "Outra saída". It follows
// connects and disconnects until the listener picks an output by hand, and never overrides that
// pick. The cable cannot be read, so when this browser's journal says the last real write did not
// leave Neutro, neither output is selected: a note asks for Neutro or another output, and starting
// requires a hand pick. Choosing only declares the output: no HID report is ever sent.
import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { FakeHIDDevice } from 'open-auri/transport';
import BlindTest from '#lib/components/pages/teste-cego/BlindTest.svelte';
import { NEUTRAL_CRC, type CableView } from '#lib/components/pages/teste-cego/output.ts';
import { createAudioEngine, type AudioEngine } from '#lib/audio/engine.ts';
import { m } from '#lib/paraglide/messages.js';
import { setLocale } from '#lib/paraglide/runtime.js';

let audio: AudioEngine | null = null;
afterEach(async () => {
	await cleanup();
	await audio?.dispose();
	audio = null;
	vi.restoreAllMocks();
	await setLocale('pt-BR', { reload: false });
});

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const radio = (label: string) => page.getByRole('radio', { name: new RegExp(`^${escape(label)}`) });
const neutral = () => radio(m.cego_neutral());
const other = () => radio(m.cego_other());

/** BlindTest on Preparo, fed a cable view (reduced motion: no swap wait). */
function mount(cable: CableView | null, extra: { audio?: AudioEngine } = {}) {
	return render(BlindTest, { reducedMotion: true, cable, ...extra });
}

type Journal = CableView['journal'];
type Connection = CableView['state']['connection'];

function view(
	device: FakeHIDDevice,
	connection: Connection,
	journal: Journal = [],
	mode: CableView['state']['mode'] = 'real'
): CableView {
	return {
		state: { mode, connection, devices: connection === 'connected' ? [device] : [] },
		journal
	};
}

async function expectOutput(choice: 'neutral' | 'other' | null) {
	if (choice === null) {
		await expect.element(neutral()).not.toBeChecked();
		await expect.element(other()).not.toBeChecked();
		return;
	}
	await expect.element(choice === 'neutral' ? neutral() : other()).toBeChecked();
	await expect.element(choice === 'neutral' ? other() : neutral()).not.toBeChecked();
}

test('a connected real cable preselects the cable in Neutro, and says why', async () => {
	const device = new FakeHIDDevice();
	await mount(view(device, 'connected'));
	await expectOutput('neutral');
	await expect.element(page.getByText(m.cego_tcout_auto_cable(), { exact: true })).toBeVisible();
	expect(device.attempts).toBe(0);
});

test('no cable, a cable still connecting, a simulated cable or no app: another output', async () => {
	const device = new FakeHIDDevice();
	const screen = await mount(view(device, 'disconnected'));
	await expectOutput('other');
	await expect.element(page.getByText(m.cego_tcout_auto_none(), { exact: true })).toBeVisible();
	await screen.rerender({ cable: view(device, 'connecting') });
	await expectOutput('other');
	// No WebHID: the app's simulated cable is not a cable output, even when "connected".
	await screen.rerender({ cable: view(device, 'connected', [], 'simulated') });
	await expectOutput('other');
	await screen.rerender({ cable: null });
	await expectOutput('other');
});

test('connects and disconnects during Preparo move the choice until it is picked by hand', async () => {
	const device = new FakeHIDDevice();
	const screen = await mount(view(device, 'disconnected'));
	await expectOutput('other');
	await screen.rerender({ cable: view(device, 'connected') });
	await expectOutput('neutral');
	await expect.element(page.getByText(m.cego_tcout_auto_cable(), { exact: true })).toBeVisible();
	await screen.rerender({ cable: view(device, 'disconnected') });
	await expectOutput('other');
	await screen.rerender({ cable: view(device, 'connected') });
	await expectOutput('neutral');
});

test('a manual choice is never overridden, not even a confirmation of the preselected one', async () => {
	const device = new FakeHIDDevice();
	const screen = await mount(view(device, 'connected'));
	await expectOutput('neutral');
	await other().click();
	await expectOutput('other');
	expect(screen.container.textContent).not.toContain(m.cego_tcout_auto_cable());
	await screen.rerender({ cable: view(device, 'disconnected') });
	await screen.rerender({ cable: view(device, 'connected') });
	await expectOutput('other');

	// Confirming the preselected option by hand also counts as a pick.
	await cleanup();
	const again = await mount(view(device, 'connected'));
	await neutral().click();
	await again.rerender({ cable: view(device, 'disconnected') });
	await expectOutput('neutral');
	expect(again.container.textContent).not.toContain(m.cego_tcout_auto_none());
});

test('the note shows only when the last real write of this browser was not Neutro', async () => {
	const device = new FakeHIDDevice();
	const note = () => page.getByText(m.cego_tcout_not_neutral(), { exact: true });
	const cases: Array<{ journal: Journal; shown: boolean }> = [
		{ journal: [], shown: false },
		{ journal: [{ crc: NEUTRAL_CRC, status: 'ok' }], shown: false },
		{ journal: [{ crc: 0x1234, status: 'ok' }], shown: true },
		// An interrupted write left something unknown on the cable, even when it was Neutro.
		{ journal: [{ crc: NEUTRAL_CRC, status: 'interrupted' }], shown: true },
		// Simulated writes never reached a cable: the last real one decides.
		{
			journal: [
				{ crc: NEUTRAL_CRC, status: 'ok' },
				{ crc: 0x1234, status: 'simulated' }
			],
			shown: false
		},
		{
			journal: [
				{ crc: NEUTRAL_CRC, status: 'ok' },
				{ crc: 0x2b2b, status: 'ok' }
			],
			shown: true
		},
		{
			journal: [
				{ crc: 0x2b2b, status: 'ok' },
				{ crc: NEUTRAL_CRC, status: 'simulated' }
			],
			shown: true
		},
		{ journal: [{ crc: 0x1234, status: 'simulated' }], shown: false }
	];
	const screen = await mount(view(device, 'connected'));
	for (const { journal, shown } of cases) {
		await screen.rerender({ cable: view(device, 'connected', journal) });
		await expectOutput(shown ? null : 'neutral');
		if (shown) {
			await expect.element(note()).toBeVisible();
			await expect.element(neutral()).toHaveAccessibleDescription(m.cego_tcout_not_neutral());
			await expect.element(page.getByText(m.cego_fux_output_hint(), { exact: true })).toBeVisible();
			expect(screen.container.textContent).not.toContain(m.cego_tcout_auto_cable());
		} else {
			await expect.element(note()).not.toBeInTheDocument();
		}
	}
	// With another output declared the cable's content does not matter: no note.
	await screen.rerender({ cable: view(device, 'disconnected', [{ crc: 0x1234, status: 'ok' }]) });
	await expectOutput('other');
	await expect.element(note()).not.toBeInTheDocument();
});

for (const choice of ['neutral', 'other'] as const) {
	test(`a non-Neutral write refuses start until ${choice} is picked by hand`, async () => {
		await setLocale('en-US', { reload: false });
		const device = new FakeHIDDevice();
		audio = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
		audio.setVolume(-40);
		const screen = await mount(view(device, 'connected', [{ crc: 0x1234, status: 'ok' }]), {
			audio
		});
		await expectOutput(null);
		await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
		await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
		await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
		await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
		await expect
			.element(page.getByText(m.cego_confirmation_required(), { exact: true }))
			.toBeVisible();
		expect(screen.container.querySelectorAll('.stage .fader')).toHaveLength(0);
		await page.getByRole('tab', { name: new RegExp(m.cego_setup()) }).click();
		await (choice === 'neutral' ? neutral() : other()).click();
		await expectOutput(choice);
		if (choice === 'neutral') {
			await expect
				.element(page.getByText(m.cego_tcout_not_neutral(), { exact: true }))
				.toBeVisible();
		} else {
			await expect
				.element(page.getByText(m.cego_tcout_not_neutral(), { exact: true }))
				.not.toBeInTheDocument();
		}
		// Subsequent cable updates must not overwrite either explicit declaration.
		await screen.rerender({ cable: view(device, 'disconnected') });
		await screen.rerender({ cable: view(device, 'connected', [{ crc: 0x1234, status: 'ok' }]) });
		await expectOutput(choice);
		await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
		await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
		await expect
			.element(page.getByRole('slider', { name: m.cego_rating({ number: 1 }), exact: true }))
			.toBeInTheDocument();
		await page.getByRole('button', { name: m.cego_cancel(), exact: true }).click();
		expect(device.opened).toBe(false);
		expect(device.attempts).toBe(0);
		expect(device.sent).toEqual([]);
	}, 30000);
}

for (const scenario of ['empty journal', 'Neutral journal', 'disconnected'] as const) {
	test(`${scenario} still starts without a hand pick`, async () => {
		await setLocale('en-US', { reload: false });
		const device = new FakeHIDDevice();
		audio = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
		audio.setVolume(-40);
		await mount(
			view(
				device,
				scenario === 'disconnected' ? 'disconnected' : 'connected',
				scenario === 'empty journal'
					? []
					: [{ crc: scenario === 'Neutral journal' ? NEUTRAL_CRC : 0x1234, status: 'ok' }]
			),
			{ audio }
		);
		await expectOutput(scenario === 'disconnected' ? 'other' : 'neutral');
		await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
		await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
		await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
		await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
		await expect
			.element(page.getByRole('slider', { name: m.cego_rating({ number: 1 }), exact: true }))
			.toBeInTheDocument();
		await page.getByRole('button', { name: m.cego_cancel(), exact: true }).click();
		expect(device.attempts).toBe(0);
	}, 30000);
}

test('declaring the output, following the cable and starting the test never send a HID report', async () => {
	await setLocale('en-US', { reload: false });
	const device = new FakeHIDDevice();
	audio = createAudioEngine({ indexedDB: null, hasUserActivation: () => true });
	audio.setVolume(-40);
	const screen = await mount(view(device, 'connected', [{ crc: 0x1234, status: 'ok' }]), { audio });
	await expectOutput(null);
	await screen.rerender({ cable: view(device, 'disconnected') });
	await screen.rerender({ cable: view(device, 'connected') });
	await other().click();
	await neutral().click();
	await page.getByRole('tab', { name: new RegExp(m.cego_candidates()) }).click();
	await page.getByRole('checkbox', { name: /^Auri\b/ }).click();
	await page.getByRole('checkbox', { name: /^Natural\b/ }).click();
	await page.getByRole('button', { name: m.cego_start(), exact: true }).click();
	const fader = page.getByRole('slider', { name: m.cego_rating({ number: 1 }), exact: true });
	await expect.element(fader).toBeInTheDocument();
	await page.getByRole('button', { name: m.cego_cancel(), exact: true }).click();
	// The cable was handed over the whole time and never opened nor sent anything.
	expect(device.opened).toBe(false);
	expect(device.attempts).toBe(0);
	expect(device.sent).toEqual([]);
}, 30000);
