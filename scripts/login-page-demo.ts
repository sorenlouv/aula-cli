/**
 * Drives `login-page.ts` through a fake MitID login, so the page can be looked
 * at without holding a real one open.
 *
 * The cadence is copied from `mitid-client.ts`: a 1s poll, a QR pair that
 * rotates every few polls, then `channel_verified`, then the approval. The
 * payloads are built by the production `buildQrPayloads`, so what the phone
 * would scan here is byte-for-byte the shape MitID sends — only the channel
 * binding is invented.
 *
 *   bun scripts/login-page-demo.ts        # TQR: the two rotating codes
 *   bun scripts/login-page-demo.ts otp    # the code-comparison mode
 *   bun scripts/login-page-demo.ts --fail # what a rejected login looks like
 *   bun scripts/login-page-demo.ts --hold # keep rotating until Ctrl-C
 */

import { randomUUID } from 'node:crypto';
import { startLoginPage } from '../src/login-page.ts';
import { buildQrPayloads } from '../src/vendor/aula-auth/mitid-poll-machine.ts';

const args = new Set(process.argv.slice(2));
const mode = args.has('otp') ? 'otp' : 'qr';
const shouldFail = args.has('--fail');
/** Rotate forever instead of finishing — for looking at the page properly. */
const hold = args.has('--hold');

const page = startLoginPage();
process.stderr.write(`\nLogin page: ${page.url}\n`);
process.stderr.write('(this is the line an agent would hand to the user)\n\n');

if (!args.has('--no-open')) {
  Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', page.url]);
}

// MitID's binding value is a hex string it halves across the two codes; any
// 32 hex characters exercise the same encode.
const channelBinding = () => randomUUID().replaceAll('-', '');

if (mode === 'qr') {
  for (let updateCount = 1; hold || updateCount <= 5; updateCount++) {
    const { qr1Json, qr2Json } = buildQrPayloads(channelBinding(), updateCount);
    page.update({ kind: 'qr', qr1: qr1Json, qr2: qr2Json, updateCount });
    process.stderr.write(`  QR rotation #${updateCount}\n`);
    await Bun.sleep(3_000);
  }
} else {
  await Bun.sleep(1_500);
  const otp = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  page.update({ kind: 'otp', otp });
  process.stderr.write(`  OTP shown: ${otp}\n`);
  await Bun.sleep(8_000);
}

page.update({ kind: 'verified' });
process.stderr.write('  channel verified — waiting for the app approval\n');
await Bun.sleep(4_000);

// `finish` waits for the browser to collect the outcome before stopping, so
// the page ends on the result rather than on "session ended".
await page.finish(
  shouldFail
    ? { ok: false, message: 'MitID reported a parallel session (CAP008).' }
    : { ok: true, message: 'Tokens saved. Aula is ready to read.' },
);
process.stderr.write(`  done (${shouldFail ? 'failed' : 'ok'})\n`);
