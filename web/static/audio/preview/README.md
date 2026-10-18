# Open-auri preview audio / Áudio de prévia

## CC0 1.0

All compositions, performances, test signals and synthesis in this collection are original.
The authors dedicate them to the public domain under **CC0 1.0 Universal** (CC0-1.0):
https://creativecommons.org/publicdomain/zero/1.0/
No samples, recordings, soundfonts, external scores or npm dependencies are used.

## Regenerate

Requires Node.js >= 22, from the repository root:

```sh
node tools/gen-preview-audio.mjs web/static/audio/preview
node tools/gen-preview-audio.mjs web/static/audio/preview --only funk
node --test test/tools/gen-preview-audio.test.mjs
```

IDs: test-signals, rock, pop, country, percussion, electronic, hiphop, funk, worship.
--only writes just the selected WAV and an inventory for that invocation; it does not delete
older WAVs in the directory. --short produces diagnostic renders (one bar / 8% signal times),
not production previews. The seed is fixed, and there are no timestamps in the outputs.
Byte determinism is intended for the same Node/runtime; transcendental rounding may vary
across JavaScript engines or architectures.

## Format and listening notes

48 kHz, 24-bit PCM stereo WAV masters. Start quietly: these are analytical EQ comparison
signals, not a hearing test, an SPL calibration, or a substitute for calibrated equipment.
Reference and sweep: -18 dBFS RMS. Octave and full-band pink noise: -20 dBFS RMS per channel,
normalized after 75 ms raised-cosine fades. Octaves use center / sqrt(2) through center * sqrt(2).
The reference timeline is 62 s: 6 s reference, 1 s silence, 12 s logarithmic sweep, 1 s silence,
ten 2 s octave bursts each followed by 0.4 s silence, 8 s full-band pink noise, 2 s silence,
4 s identical-channel pink noise, then the same 4 s with right polarity inverted.
Inverted polarity intentionally cancels in mono; it is not a level-matching passage.

Music uses original genre-inspired scores, not imitations of particular songs or artists:
rock has double-panned distorted guitar mids; pop has chords and FM melody; country has
plucked guitar and alternating bass; percussion isolates drums; electronic has four-on-the-floor
and deep bass; hip hop has swung hats and sub; Brazilian funk has a roughly 130 BPM tamborzão
groove; worship has acoustic plucks, bright detuned pads and a longer stereo reverb impression.
All are integer-bar 4/4 loops (16–24 s), rounded to the nearest sample. Releases wrap around;
75 ms cosine boundary fades make repetition/crossfading click-safe. No extra tail extends a bar.
The drum/hat micro-envelopes are shorter than the track/section boundary fades.

Music targets -16.0 integrated LUFS (within 0.3 LU). The BS.1770-4 stereo meter uses the ITU
48 kHz high-shelf and RLB high-pass, summed channel powers, 400 ms blocks with 75% overlap,
a -70 LUFS absolute gate and a -10 LU relative gate. A stereo-linked soft-knee limiter is
followed by re-metering, so peak limiting does not silently change the loudness target.
Peak mastering uses 4x 24-tap windowed-sinc reconstruction and a -1.2 dBTP ceiling, leaving
0.2 dB below -1 dBTP. Tests additionally inspect 8x reconstruction.
Brighter hats, snare/clap crack, FM leads and pitched percussion carry the upper spectrum.
Broad stereo-linked EQ gently bounds the existing instrument bands; it adds no noise layer.
Diagnostic bands are 20–120, 120–500, 500–2000, 2000–6000 and 6000–20000 Hz. Presence and air
must be no more than 14 and 18 dB below low mids, respectively; sub is at most 6 dB above them.
The manifest reports integrated LUFS, actual RMS and estimated true peak, frame counts,
tempo/bar counts, and contiguous bilingual sections including silence. Times are seconds,
ends are exclusive.
Do not normalize individual sections again when analytically comparing EQ curves.

## Contents

- **test-signals.wav** — 62.000 s
  - 0.000–6.000 s: Level reference: 1 kHz / Referência de nível: 1 kHz (sine)
  - 6.000–7.000 s: Silence / Silêncio (silence)
  - 7.000–19.000 s: Sweep: 20 Hz to 20 kHz / Varredura: 20 Hz a 20 kHz (sweep)
  - 19.000–20.000 s: Silence / Silêncio (silence)
  - 20.000–22.000 s: Pink noise: 31.5 Hz / Ruído rosa: 31.5 Hz (octave-noise)
  - 22.000–22.400 s: Silence / Silêncio (silence)
  - 22.400–24.400 s: Pink noise: 63 Hz / Ruído rosa: 63 Hz (octave-noise)
  - 24.400–24.800 s: Silence / Silêncio (silence)
  - 24.800–26.800 s: Pink noise: 125 Hz / Ruído rosa: 125 Hz (octave-noise)
  - 26.800–27.200 s: Silence / Silêncio (silence)
  - 27.200–29.200 s: Pink noise: 250 Hz / Ruído rosa: 250 Hz (octave-noise)
  - 29.200–29.600 s: Silence / Silêncio (silence)
  - 29.600–31.600 s: Pink noise: 500 Hz / Ruído rosa: 500 Hz (octave-noise)
  - 31.600–32.000 s: Silence / Silêncio (silence)
  - 32.000–34.000 s: Pink noise: 1000 Hz / Ruído rosa: 1000 Hz (octave-noise)
  - 34.000–34.400 s: Silence / Silêncio (silence)
  - 34.400–36.400 s: Pink noise: 2000 Hz / Ruído rosa: 2000 Hz (octave-noise)
  - 36.400–36.800 s: Silence / Silêncio (silence)
  - 36.800–38.800 s: Pink noise: 4000 Hz / Ruído rosa: 4000 Hz (octave-noise)
  - 38.800–39.200 s: Silence / Silêncio (silence)
  - 39.200–41.200 s: Pink noise: 8000 Hz / Ruído rosa: 8000 Hz (octave-noise)
  - 41.200–41.600 s: Silence / Silêncio (silence)
  - 41.600–43.600 s: Pink noise: 16000 Hz / Ruído rosa: 16000 Hz (octave-noise)
  - 43.600–44.000 s: Silence / Silêncio (silence)
  - 44.000–52.000 s: Full-band pink noise / Ruído rosa de banda larga (pink-noise)
  - 52.000–54.000 s: Silence / Silêncio (silence)
  - 54.000–58.000 s: Stereo: in phase / Estéreo: em fase (phase)
  - 58.000–62.000 s: Stereo: right inverted / Estéreo: canal direito invertido (phase)

- **genre-rock.wav** — 17.143 s
  - 0.000–2.143 s: Bar 1 / Compasso 1 (music)
  - 2.143–4.286 s: Bar 2 / Compasso 2 (music)
  - 4.286–6.429 s: Bar 3 / Compasso 3 (music)
  - 6.429–8.571 s: Bar 4 / Compasso 4 (music)
  - 8.571–10.714 s: Bar 5 / Compasso 5 (music)
  - 10.714–12.857 s: Bar 6 / Compasso 6 (music)
  - 12.857–15.000 s: Bar 7 / Compasso 7 (music)
  - 15.000–17.143 s: Bar 8 / Compasso 8 (music)

- **genre-pop.wav** — 17.778 s
  - 0.000–2.222 s: Bar 1 / Compasso 1 (music)
  - 2.222–4.444 s: Bar 2 / Compasso 2 (music)
  - 4.444–6.667 s: Bar 3 / Compasso 3 (music)
  - 6.667–8.889 s: Bar 4 / Compasso 4 (music)
  - 8.889–11.111 s: Bar 5 / Compasso 5 (music)
  - 11.111–13.333 s: Bar 6 / Compasso 6 (music)
  - 13.333–15.556 s: Bar 7 / Compasso 7 (music)
  - 15.556–17.778 s: Bar 8 / Compasso 8 (music)

- **genre-country.wav** — 18.462 s
  - 0.000–2.308 s: Bar 1 / Compasso 1 (music)
  - 2.308–4.615 s: Bar 2 / Compasso 2 (music)
  - 4.615–6.923 s: Bar 3 / Compasso 3 (music)
  - 6.923–9.231 s: Bar 4 / Compasso 4 (music)
  - 9.231–11.538 s: Bar 5 / Compasso 5 (music)
  - 11.538–13.846 s: Bar 6 / Compasso 6 (music)
  - 13.846–16.154 s: Bar 7 / Compasso 7 (music)
  - 16.154–18.462 s: Bar 8 / Compasso 8 (music)

- **genre-percussion.wav** — 19.200 s
  - 0.000–2.400 s: Bar 1 / Compasso 1 (music)
  - 2.400–4.800 s: Bar 2 / Compasso 2 (music)
  - 4.800–7.200 s: Bar 3 / Compasso 3 (music)
  - 7.200–9.600 s: Bar 4 / Compasso 4 (music)
  - 9.600–12.000 s: Bar 5 / Compasso 5 (music)
  - 12.000–14.400 s: Bar 6 / Compasso 6 (music)
  - 14.400–16.800 s: Bar 7 / Compasso 7 (music)
  - 16.800–19.200 s: Bar 8 / Compasso 8 (music)

- **genre-electronic.wav** — 16.000 s
  - 0.000–2.000 s: Bar 1 / Compasso 1 (music)
  - 2.000–4.000 s: Bar 2 / Compasso 2 (music)
  - 4.000–6.000 s: Bar 3 / Compasso 3 (music)
  - 6.000–8.000 s: Bar 4 / Compasso 4 (music)
  - 8.000–10.000 s: Bar 5 / Compasso 5 (music)
  - 10.000–12.000 s: Bar 6 / Compasso 6 (music)
  - 12.000–14.000 s: Bar 7 / Compasso 7 (music)
  - 14.000–16.000 s: Bar 8 / Compasso 8 (music)

- **genre-hiphop.wav** — 21.818 s
  - 0.000–2.727 s: Bar 1 / Compasso 1 (music)
  - 2.727–5.455 s: Bar 2 / Compasso 2 (music)
  - 5.455–8.182 s: Bar 3 / Compasso 3 (music)
  - 8.182–10.909 s: Bar 4 / Compasso 4 (music)
  - 10.909–13.636 s: Bar 5 / Compasso 5 (music)
  - 13.636–16.364 s: Bar 6 / Compasso 6 (music)
  - 16.364–19.091 s: Bar 7 / Compasso 7 (music)
  - 19.091–21.818 s: Bar 8 / Compasso 8 (music)

- **genre-funk.wav** — 22.154 s
  - 0.000–1.846 s: Bar 1 / Compasso 1 (music)
  - 1.846–3.692 s: Bar 2 / Compasso 2 (music)
  - 3.692–5.538 s: Bar 3 / Compasso 3 (music)
  - 5.538–7.385 s: Bar 4 / Compasso 4 (music)
  - 7.385–9.231 s: Bar 5 / Compasso 5 (music)
  - 9.231–11.077 s: Bar 6 / Compasso 6 (music)
  - 11.077–12.923 s: Bar 7 / Compasso 7 (music)
  - 12.923–14.769 s: Bar 8 / Compasso 8 (music)
  - 14.769–16.615 s: Bar 9 / Compasso 9 (music)
  - 16.615–18.462 s: Bar 10 / Compasso 10 (music)
  - 18.462–20.308 s: Bar 11 / Compasso 11 (music)
  - 20.308–22.154 s: Bar 12 / Compasso 12 (music)

- **genre-worship.wav** — 23.415 s
  - 0.000–2.927 s: Bar 1 / Compasso 1 (music)
  - 2.927–5.854 s: Bar 2 / Compasso 2 (music)
  - 5.854–8.780 s: Bar 3 / Compasso 3 (music)
  - 8.780–11.707 s: Bar 4 / Compasso 4 (music)
  - 11.707–14.634 s: Bar 5 / Compasso 5 (music)
  - 14.634–17.561 s: Bar 6 / Compasso 6 (music)
  - 17.561–20.488 s: Bar 7 / Compasso 7 (music)
  - 20.488–23.415 s: Bar 8 / Compasso 8 (music)
