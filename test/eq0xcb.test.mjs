import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as eq from '../src/dsp/eq0xcb.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/eq0xcb.reference.json', import.meta.url), 'utf8'),
);
const ids = Object.keys(fixture.presets);

// Independent known-answer test: CRC-16/CCITT-FALSE check value for "123456789"
// is 0x29B1, published in the CRC catalogue. This does not come from the bundle.
test('crc16-ccitt matches the published check value', () => {
  const bytes = [...'123456789'].map((c) => c.charCodeAt(0));
  assert.equal(eq.crc16(bytes), 0x29b1);
});

test('constants match the reference', () => {
  assert.deepEqual(eq.HEADER, fixture.constants.HEADER);
  assert.deepEqual(eq.APPLY, fixture.constants.APPLY);
  assert.equal(eq.REPORT_ID, fixture.constants.REPORT_ID);
  assert.equal(eq.FS, fixture.constants.FS);
  assert.equal(eq.VENDOR_ID, fixture.constants.VENDOR_ID);
  assert.equal(eq.PRODUCT_ID, fixture.constants.PRODUCT_ID);
});

test('preamp 0 dB encodes 1.0 in Q23', () => {
  assert.equal(eq.preampWord(0), 1 << 23);
});

test('fixture covers every Auri preset', () => {
  assert.ok(ids.length >= 11, `expected >= 11 presets, got ${ids.length}`);
});

for (const id of ids) {
  const ref = fixture.presets[id];

  test(`blob matches reference: ${id}`, () => {
    assert.equal(ref.blob.length, eq.BLOB_SIZE);
    assert.deepEqual(eq.blob(ref.bands, ref.pre), ref.blob);
  });

  test(`packets match reference: ${id}`, () => {
    const got = eq.packets(ref.bands, ref.pre).map((p) => Array.from(p));
    assert.deepEqual(got, ref.packets);
  });
}

test('packet framing: 9 reports of 31 bytes with the index in byte 0', () => {
  const { bands } = fixture.presets[ids[0]];
  const pk = eq.packets(bands, -3);
  assert.equal(pk.length, 9);
  pk.forEach((p, i) => {
    assert.equal(p.length, 31);
    assert.equal(p[0], i);
  });
});

test('blob rejects a band count other than 10', () => {
  assert.throws(() => eq.blob([], 0), /bands are required/);
});
