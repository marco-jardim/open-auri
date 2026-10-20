<!--
	One console channel strip: a published curve. Bridge: real LEDs only while this channel plays
	(ChannelMeter). Face: S8 avatar, read-only knob summary computed from the curve, SOLO (listen,
	level matched against your curve) and SEL (send to the master scope). Identification tape: the
	author's nickname (link to /u/<nick>), the curve name and its license. User text only as text.
-->
<script lang="ts">
	import type { PreviewChain } from '#lib/audio/engine.ts';
	import type { MeterTap, TapOptions } from '#lib/audio/meters.ts';
	import { formatNumber } from '#lib/components/cable/i18n.ts';
	import Button from '#lib/components/primitives/Button.svelte';
	import HideActions from '#lib/components/social/HideActions.svelte';
	import { authorHiddenId } from '#lib/social/hidden.ts';
	import { m } from '#lib/paraglide/messages.js';
	import YoloCurveNotice from '#lib/components/yolo/YoloCurveNotice.svelte';
	import ChannelMeter from './ChannelMeter.svelte';
	import CurveAvatar from './CurveAvatar.svelte';
	import { knobAngle, knobSummary, licenseShort, profileHref, type Channel } from './model.ts';

	let {
		channel,
		number,
		playing = false,
		chain = null,
		selected = false,
		disabled = false,
		tap,
		onlisten,
		onselect
	}: {
		channel: Channel;
		number: number;
		playing?: boolean;
		chain?: PreviewChain | null;
		selected?: boolean;
		disabled?: boolean;
		tap?: (node: AudioNode, options?: TapOptions) => Promise<MeterTap>;
		onlisten: (channel: Channel) => void;
		onselect: (channel: Channel) => void;
	} = $props();

	const chno = $derived(String(number).padStart(2, '0'));
	const knobs = $derived(channel.curve ? knobSummary(channel.curve) : null);
	const authorName = $derived(
		channel.author ? `@${channel.author.displayUsername}` : m.comunidade_author_removed()
	);
	const tilt = $derived(`${((number * 37) % 7) * 0.25 - 0.8}deg`);
	/** Why SOLO cannot act right now (always said, never a silent grey key: T8). */
	const soloReason = $derived(
		!channel.curve
			? m.comunidade_channel_invalid()
			: disabled
				? m.comunidade_v2_reason_busy()
				: null
	);
</script>

<li
	class="strip"
	class:selected
	class:playing
	data-testid="channel-strip"
	data-lineage={channel.lineageId}
	aria-label={m.comunidade_channel_label({ number: chno, name: channel.name })}
>
	<div class="bridge-seg">
		{#if playing && chain}
			<ChannelMeter {chain} {tap} label={m.comunidade_channel_leds({ number: chno })} />
		{:else}
			<span class="meter-off" aria-hidden="true"></span>
		{/if}
		<span class="chno">{chno}</span>
	</div>
	<div class="face">
		<span class="ex-tag">
			{#if channel.rank !== null}#{channel.rank}{:else}{licenseShort(channel.license)}{/if}
		</span>
		<CurveAvatar
			curve={channel.curve}
			s1={channel.s1}
			label={m.comunidade_avatar_label({ name: channel.name })}
		/>
		{#if knobs}
			<div class="knobs">
				<div class="ro-knob">
					<span class="k-lbl">{m.comunidade_knob_bass()}</span>
					<span class="knob" style:--angle="{knobAngle(knobs.bass)}deg" aria-hidden="true"
						><i class="cp"></i></span
					>
					<span class="k-val">{formatNumber(knobs.bass, 1, true)}</span>
				</div>
				<div class="ro-knob">
					<span class="k-lbl">{m.comunidade_knob_treble()}</span>
					<span class="knob treble" style:--angle="{knobAngle(knobs.treble)}deg" aria-hidden="true"
						><i class="cp"></i></span
					>
					<span class="k-val">{formatNumber(knobs.treble, 1, true)}</span>
				</div>
			</div>
		{:else}
			<p class="invalid">{m.comunidade_channel_invalid()}</p>
		{/if}
		<div class="btns">
			<Button
				size="sm"
				class="sq solo"
				aria-pressed={playing}
				aria-label={playing
					? m.comunidade_channel_stop({ name: channel.name })
					: m.comunidade_channel_listen({ name: channel.name })}
				disabledReason={soloReason}
				onclick={() => onlisten(channel)}>{m.comunidade_solo()}</Button
			>
			<Button
				size="sm"
				class="sq sel"
				aria-pressed={selected}
				aria-label={m.comunidade_channel_select({ name: channel.name })}
				disabledReason={channel.curve ? null : m.comunidade_channel_invalid()}
				onclick={() => onselect(channel)}>{m.comunidade_sel()}</Button
			>
		</div>
		{#if channel.score !== null}
			<span class="readout" title={m.comunidade_score_title()}
				>{formatNumber(channel.score, 0)}</span
			>
		{/if}
		<div class="scribble" style:--tilt={tilt}>
			{#if channel.author}
				<a class="m1" href={profileHref(channel.author)}>{authorName}</a>
			{:else}
				<span class="m1 removed">{authorName}</span>
			{/if}
			<a class="m2" href="/c/{encodeURIComponent(channel.lineageId)}" lang={channel.lang}
				>{channel.name}</a
			>
			<span class="lic lic-{channel.license === 'CC0-1.0' ? 'cc0' : 'ccby'}"
				>{licenseShort(channel.license)}</span
			>
		</div>
		{#if channel.yolo}
			<!-- Every YOLO card carries the mark (compact: no interactive content). -->
			<YoloCurveNotice variant="public" compact class="strip-yolo" />
		{/if}
		<HideActions
			lineageId={channel.lineageId}
			author={authorHiddenId(channel.author)}
			curveName={channel.name}
			authorName={channel.author?.displayUsername}
		/>
	</div>
</li>

<style>
	.strip {
		width: 104px;
		flex: 0 0 104px;
		display: flex;
		flex-direction: column;
		border-right: 1px solid #0b0c0d;
		box-shadow: inset 1px 0 0 #ffffff12;
		list-style: none;
	}
	.bridge-seg {
		position: relative;
		height: 132px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-end;
		padding: 8px 0;
		background: linear-gradient(#111213, #1b1c1e);
		border-bottom: 7px solid #0d0e0f;
		box-shadow:
			inset 0 -1px 0 #ffffff12,
			0 6px 10px #0009;
	}
	.meter-off {
		display: block;
		width: 16px;
		height: 86px;
		border-radius: 2px;
		background: #070808;
		box-shadow: 0 0 0 1px #000;
	}
	.chno {
		font: 500 var(--fs-caption) var(--face-data);
		color: #e4e0d6;
		margin-top: 6px;
		letter-spacing: 0.06em;
	}
	.selected .chno,
	.playing .chno {
		color: var(--accent);
		text-shadow: 0 0 8px #3ddc9788;
	}
	.face {
		position: relative;
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 14px 4px 12px;
		background:
			radial-gradient(140% 50% at 0 0, #ffffff12, transparent 60%),
			repeating-linear-gradient(90deg, #ffffff04 0 1px, transparent 1px 3px),
			linear-gradient(180deg, #35383c, #2c2f32 50%, #27292c);
		box-shadow:
			inset 1px 0 0 #ffffff14,
			inset -1px 0 0 #00000080;
	}
	.ex-tag {
		font: 500 var(--label-min) var(--face-data);
		letter-spacing: 0.06em;
		color: #d6d2c8;
		text-transform: uppercase;
	}
	.knobs {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2px;
		width: 100%;
	}
	.ro-knob {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}
	.k-lbl {
		font: 500 var(--label-min) var(--face-data);
		color: #e4e0d6;
	}
	.k-val {
		font: 400 var(--label-min) var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
		color: #ffd79a;
	}
	.knob {
		position: relative;
		width: 26px;
		height: 26px;
		border-radius: 50%;
		background:
			radial-gradient(circle at 32% 28%, #ffffff33, transparent 46%),
			repeating-conic-gradient(#141516 0 5deg, #3c3e41 5deg 10deg);
		box-shadow:
			2px 4px 5px #000c,
			inset 0 0 0 1px #000;
	}
	.knob .cp {
		position: absolute;
		inset: 21%;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #ffb3b0, #d9483f 55%, #6d1d18);
		transform: rotate(var(--angle));
	}
	.knob.treble .cp {
		background: radial-gradient(circle at 35% 30%, #c8e2ff, #3f7fd9 55%, #173d6d);
	}
	.knob .cp::after {
		content: '';
		position: absolute;
		left: calc(50% - 1px);
		top: -30%;
		width: 2px;
		height: 62%;
		border-radius: 1px;
		background: #f6f3ec;
	}
	.invalid {
		margin: 0;
		font: 400 var(--label-min) / var(--lh-small) var(--face-data);
		color: #ffb3b5;
		text-align: center;
	}
	.btns {
		display: flex;
		gap: 4px;
	}
	/* SOLO and SEL are the Button primitive dressed as console keys (behaviour, focus ring and the
	   unavailable reason come from the primitive). */
	.btns :global(.sq) {
		width: 44px;
		min-width: 44px;
		height: 30px;
		min-height: 30px;
		padding: 0;
		border-radius: var(--rad-sm);
		border: 1px solid #000;
		background: linear-gradient(#4a4d51, #2d2f33);
		color: #f0ece3;
		font: 600 var(--label-min) / 1 var(--face-body);
		letter-spacing: var(--tracking-caps);
		box-shadow:
			0 3px 0 #111,
			inset 0 1px 0 #ffffff26;
	}
	.btns :global(.sq.solo[aria-pressed='true']) {
		background: radial-gradient(circle at 50% 40%, #fff3c4, #ffc248 60%, #c98a1c);
		color: #2a1d05;
		box-shadow:
			0 0 12px #ffc24888,
			0 1px 0 #111;
		transform: translateY(2px);
	}
	.btns :global(.sq.sel[aria-pressed='true']) {
		background: radial-gradient(circle at 50% 40%, #d8fff0, var(--accent) 60%, #1f9a68);
		color: #062016;
		box-shadow:
			0 0 12px #3ddc9788,
			0 1px 0 #111;
		transform: translateY(2px);
	}
	.readout {
		font: 400 var(--fs-caption) var(--face-data);
		font-variant-numeric: tabular-nums slashed-zero;
		background: #0a0a0b;
		color: #ffdca6;
		border: 1px solid #000;
		padding: 3px 6px;
		min-width: 56px;
		text-align: center;
		border-radius: 2px;
	}
	.scribble {
		width: 100%;
		min-height: 64px;
		margin-top: auto;
		padding: 6px 4px 5px;
		background: linear-gradient(180deg, #f8f5ec, #e9e4d6);
		color: var(--marker-ink);
		box-shadow: 0 2px 3px #000a;
		transform: rotate(var(--tilt, -0.7deg));
		font-family: var(--marker);
		line-height: 1.08;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
	}
	.scribble a {
		color: inherit;
		text-decoration: none;
	}
	/* WCAG 2.2 target size: the tape links are at least 24 × 24 px. */
	.scribble .m1,
	.scribble .m2 {
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		min-width: 24px;
		min-height: 24px;
		max-width: 100%;
		padding: 2px 2px;
	}
	.scribble a:hover {
		text-decoration: underline;
	}
	.m1 {
		display: block;
		font-size: var(--label-min);
		overflow-wrap: anywhere;
		color: #23255f;
	}
	.m1.removed {
		font-style: italic;
	}
	.m2 {
		display: block;
		font-size: var(--fs-ui);
		color: #141414 !important;
		overflow-wrap: anywhere;
	}
	.lic {
		font: 500 var(--label-min) var(--face-data);
		padding: 1px 4px;
		border-radius: 2px;
		border: 1px solid #000;
	}
	.lic-cc0 {
		background: #e9e6dc;
		color: #151515;
	}
	.lic-ccby {
		background: #2f3a52;
		color: #e7eefc;
	}
	@media (prefers-reduced-motion: reduce) {
		.btns :global(.sq) {
			transition: none;
		}
	}
</style>
