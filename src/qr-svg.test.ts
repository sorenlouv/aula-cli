import assert from 'node:assert/strict';
import { test } from 'node:test';
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import { qrSvg } from './qr-svg.ts';
import { buildQrPayloads } from './vendor/aula-auth/mitid-poll-machine.ts';

const QUIET = 4;

/** Reads the dark modules back out of the SVG, as `"row,col"` keys. */
function darkModules(svg: string): Set<string> {
  const out = new Set<string>();
  for (const match of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1"\/>/g)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    for (let i = 0; i < Number(match[3]); i++) out.add(`${y},${x + i}`);
  }
  return out;
}

/** What the encoder says the symbol is, independent of how it was drawn. */
function expectedModules(payload: string): { dark: Set<string>; count: number } {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(payload);
  qr.make();
  const count = qr.getModuleCount();
  const dark = new Set<string>();
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) dark.add(`${row + QUIET},${col + QUIET}`);
    }
  }
  return { dark, count };
}

// The failure this guards is silent and total: an SVG can look like a QR code
// to a human at every zoom level and still be undecodable, because one row is
// off by one or the quiet zone is missing. Comparing against the encoder is the
// only check that catches that without a camera.
test('draws exactly the modules the encoder produced', () => {
  const { qr1Json } = buildQrPayloads('a3f19c8e42b7d05169fe3a8c2d4b7e01', 3);
  const { dark, count } = expectedModules(qr1Json);
  const drawn = darkModules(qrSvg(qr1Json));

  assert.deepEqual([...drawn].sort(), [...dark].sort());
  assert.match(qrSvg(qr1Json), new RegExp(`viewBox="0 0 ${count + QUIET * 2} ${count + QUIET * 2}"`));
});

test('keeps the quiet zone clear', () => {
  const { qr1Json } = buildQrPayloads('a3f19c8e42b7d05169fe3a8c2d4b7e01', 1);
  const { count } = expectedModules(qr1Json);
  const side = count + QUIET * 2;

  for (const key of darkModules(qrSvg(qr1Json))) {
    const [row, col] = key.split(',').map(Number) as [number, number];
    const inside = row >= QUIET && row < side - QUIET && col >= QUIET && col < side - QUIET;
    assert.ok(inside, `module at ${key} sits in the quiet zone`);
  }
});

test('merges horizontal runs rather than emitting a rect per module', () => {
  const { qr1Json } = buildQrPayloads('a3f19c8e42b7d05169fe3a8c2d4b7e01', 1);
  const svg = qrSvg(qr1Json);
  const rects = [...svg.matchAll(/<rect x=/g)].length;
  const modules = darkModules(svg).size;

  // Every symbol has three finder patterns, whose top row is seven dark modules
  // in a row. If nothing merged, that would be seven rects.
  assert.match(svg, /width="7"/);
  assert.ok(rects < modules * 0.7, `expected runs, got ${rects} rects for ${modules} modules`);
});

// Both halves carry different data, and a renderer that ignored its argument
// would still produce something that scans — just the wrong thing, twice.
test('the two halves render differently', () => {
  const { qr1Json, qr2Json } = buildQrPayloads('a3f19c8e42b7d05169fe3a8c2d4b7e01', 1);
  assert.notEqual(qrSvg(qr1Json), qrSvg(qr2Json));
});

// Scanners are much less reliable on inverted codes, so the symbol carries its
// own light ground no matter what theme the page around it is using.
test('is black on white, whatever the page is', () => {
  const svg = qrSvg('anything');
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#fff"\/>/);
  assert.match(svg, /<g fill="#000">/);
});

// This module reaches past qrcode-terminal's public API into its vendored
// encoder, which is the sort of thing that breaks quietly on an upgrade. It
// would break at the worst moment — a login, on the one code path a user cannot
// work around — so the shape is asserted here, where an upgrade has to notice.
test('the vendored encoder still exposes the matrix', () => {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  assert.equal(typeof qr.addData, 'function');
  assert.equal(typeof qr.make, 'function');
  assert.equal(typeof qr.getModuleCount, 'function');
  assert.equal(typeof qr.isDark, 'function');
  assert.equal(typeof QRErrorCorrectLevel.L, 'number');
});
