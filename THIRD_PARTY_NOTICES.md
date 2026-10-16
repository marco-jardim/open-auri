# Third-party notices

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
