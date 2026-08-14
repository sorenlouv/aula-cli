import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQrRenderer } from './qr.ts';
import { buildQrPayloads } from './vendor/aula-auth/mitid-poll-machine.ts';

/** Captures stderr for the duration of one call. */
function capture(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

test('renders both halves of the channel binding, side by side', () => {
  const { qr1Json, qr2Json } = buildQrPayloads('a3f19c8e42b7d05169fe3a8c2d4b7e01', 3);
  const out = capture(() => createQrRenderer()(qr1Json, qr2Json, 3));

  const body = out.split('\n').filter((l) => l.includes('█'));
  assert.ok(body.length > 10, 'expected a QR-sized block of output');

  // Side by side, not stacked: every row carries part of both codes, separated
  // by the gap. Stacking two codes overflows a normal terminal.
  const gapped = body.filter((l) => /█\s{3,}[\s▄▀█]*█/.test(l));
  assert.ok(gapped.length > 10, 'expected both codes on the same rows');

  assert.match(out, /#3/, 'should show which refresh this is');
});

// The bug this guards: MitID picks OTP *or* QR per account, and a QR-mode login
// against an OTP-only implementation just polls in silence looking like a hang.
test('the two codes differ, so each half is really being drawn', () => {
  const { qr1Json, qr2Json } = buildQrPayloads('a3f19c8e42b7d05169fe3a8c2d4b7e01', 1);
  assert.notEqual(qr1Json, qr2Json);

  const rows = capture(() => createQrRenderer()(qr1Json, qr2Json, 1))
    .split('\n')
    .filter((l) => l.includes('█'));
  let left = '';
  let right = '';
  for (const row of rows) {
    const parts = row.split(/\s{3,}/);
    left += parts[0] ?? '';
    right += parts[1] ?? '';
  }
  assert.notEqual(left, right, 'the halves must not render as the same code');
});
