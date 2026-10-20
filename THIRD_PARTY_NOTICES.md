# Third-party notices

## Bundled npm packages

The full list of packages included in the client and server/Worker bundles,
with installed versions, license identifiers and complete license texts, is
served at [`/third-party-licenses.txt`](web/static/third-party-licenses.txt).
After building the web app, run `npm run notices` to regenerate
`web/static/third-party-licenses.txt` from the bundle sourcemaps under
`web/.svelte-kit/output/`. This includes bundled runtimes even when their
packages are declared as development dependencies, generated Paraglide runtime
sources, and SSR imports left for Wrangler to bundle. For those external
imports, the generator conservatively includes their production dependency
closure (including resvg WASM). The resvg-wasm npm tarballs omit a license file;
the generator uses the identical full MPL-2.0 text shipped by `@cf-wasm/resvg`
and records that provenance. Missing license texts otherwise stop generation.

## Android app (native dependencies)

Licenses of the native Android dependencies (Licensee androidRelease report) are listed in
[web/static/third-party-licenses-android.txt](web/static/third-party-licenses-android.txt),
published at /third-party-licenses-android.txt. Regenerate after a release build:
`npm run build:android:release && npm run notices:android`.

## resvg (MPL-2.0)

The server/Worker uses `@cf-wasm/resvg` and `@resvg/resvg-wasm` (including the
`@resvg/resvg-wasm-legacy` npm alias) under the Mozilla Public License 2.0.
These are unmodified npm packages; their corresponding source is available
from the upstream repositories and npm releases below. The versions and full
license texts are included in `/third-party-licenses.txt`.

- `@cf-wasm/resvg`: <https://github.com/fineshopdesign/cf-wasm> and
  <https://www.npmjs.com/package/@cf-wasm/resvg>.
- `@resvg/resvg-wasm`: <https://github.com/yisibl/resvg-js> and
  <https://www.npmjs.com/package/@resvg/resvg-wasm>.
- MPL-2.0: <https://www.mozilla.org/MPL/2.0/>. Source files covered by the MPL
  remain available under that license; the surrounding application is AGPL-3.0.

## AutoEq

`src/dsp/eq0xcb.mjs` contains a JavaScript port of the peaking, low-shelf and
high-shelf biquad design from AutoEq
(`autoeq/peq.py`: `Peaking`, `LowShelf` and `HighShelf.biquad_coefficients`),
<https://github.com/jaakkopasanen/AutoEq>.

`src/solver/peq.mjs` reimplements in JavaScript, without copying code, the
parametric-EQ initialization and loss from AutoEq's `autoeq/peq.py` (file at
commit `853360a1626b387e1d3d87f3f7ad8c7514d30839`, 2023-10-29): peaking-filter
initialization from the largest peak or dip by width × height, applied one
filter at a time; shelf initialization from the 40 Hz–10 kHz level split with
Q 0.7; the RMSE loss over 20 Hz–20 kHz with averaging above 10 kHz; and the
peaking sharpness penalty. The optimizer, gate projection, perceptual
weighting, opposite-neighbour penalty and treble-detail term are this
project's own work.

```
MIT License

Copyright (c) 2018-2022 Jaakko Pasanen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## libebur128

`src/meter/loudness.mjs` re-derives the ITU-R BS.1770 K-weighting filters at
any sample rate from the analog-prototype parameters and the derivation used by
libebur128 (`ebur128/ebur128.c`, `ebur128_init_filter`),
<https://github.com/jiixyj/libebur128>. No code is copied; the constants are
cited in the module. License (MIT), verbatim from the upstream `COPYING`:

```
Copyright (c) 2011 Jan Kokemüller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Kuba reference implementation

The 0xCB byte layout and the reference presets come from
<https://equalizador.kuba.audio/>. No code from it is included in this
repository; `test/fixtures/eq0xcb.reference.json` holds derived data (the
expected bytes for each preset), credited there and in `docs/README.md`.

## Fonts

The web app self-hosts the following fonts (latin subset, WOFF2, from the
Fontsource npm packages) under `web/static/fonts/<family>/`. Each folder
contains the full license text as `LICENSE.txt`. No font is loaded from Google
Fonts or any CDN. The files are unmodified apart from the latin subsetting done
upstream by Fontsource.

| Family | Styles/weights | License | Copyright |
|---|---|---|---|
| Instrument Serif | 400 normal, 400 italic | SIL OFL 1.1 | Copyright 2022 The Instrument Serif Project Authors |
| Geist (variable) | wght 100–900 | SIL OFL 1.1 | Copyright 2024 The Geist Project Authors |
| JetBrains Mono | 400, 500 | SIL OFL 1.1 | Copyright 2020 The JetBrains Mono Project Authors |
| Courier Prime | 400, 700 | SIL OFL 1.1 | Copyright 2015 The Courier Prime Project Authors |
| Barlow Condensed | 400, 500, 600, 700 | SIL OFL 1.1 | Copyright 2017 The Barlow Project Authors |
| Oswald | 400, 500, 600 | SIL OFL 1.1 | Copyright 2016 The Oswald Project Authors |
| EB Garamond | 400, 500, 600; italic 400, 500 | SIL OFL 1.1 | Copyright 2017 The EB Garamond Project Authors |
| VT323 | 400 | SIL OFL 1.1 | Copyright 2011, The VT323 Project Authors |
| Special Elite | 400 | Apache License 2.0 | Copyright (c) 2010 by Brian J. Bonislawsky DBA Astigmatic (AOETI) |
| Permanent Marker | 400 | Apache License 2.0 | Copyright (c) 2010 by Font Diner, Inc. |

### Open Graph fonts

The server/Worker also uses the self-hosted TTF files
`web/static/og-font/InstrumentSerif-Regular.ttf` (Instrument Serif) and
`web/static/og-font/JetBrainsMono.ttf` (JetBrains Mono) to render Open Graph
images. Both are licensed under SIL Open Font License 1.1 (OFL-1.1). Their
copyright notices and upstream license-text links accompany the files in
[`web/static/og-font/LICENSE-OFL.txt`](web/static/og-font/LICENSE-OFL.txt),
also served at `/og-font/LICENSE-OFL.txt`.

## AutoEq measurement and target data

`tools/import-autoeq.mjs` converts headphone measurements and targets from the
AutoEq repository (<https://github.com/jaakkopasanen/AutoEq>, MIT, Copyright
(c) 2018-2022 Jaakko Pasanen) into compact packs generated at build time under
`web/static/data/autoeq/` (not versioned). Each measurement keeps its original
source attribution; see `docs/autoeq-data.md` for sources and the removal
process.
