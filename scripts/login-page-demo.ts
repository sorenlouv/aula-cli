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
 * The two ask modes exercise the real `askUsername` / `askIdentity`, including
 * the re-ask: the first answer is rejected on purpose, because the inline error
 * is the part that is easiest to get subtly wrong and impossible to see from a
 * test.
 *
 *   bun scripts/login-page-demo.ts           # TQR: the two rotating codes
 *   bun scripts/login-page-demo.ts otp       # the code-comparison mode
 *   bun scripts/login-page-demo.ts username  # the username form, rejected once
 *   bun scripts/login-page-demo.ts identity  # the identity picker
 *   bun scripts/login-page-demo.ts --fail    # what a rejected login looks like
 *   bun scripts/login-page-demo.ts --hold    # keep rotating until Ctrl-C
 */

import { randomUUID } from 'node:crypto';
import { startLoginPage } from '../src/login-page.ts';
import { buildQrPayloads } from '../src/vendor/aula-auth/mitid-poll-machine.ts';

const args = new Set(process.argv.slice(2));

/**
 * Spelled out rather than chained ternaries: an unrecognised word silently
 * running the QR demo is a demo that proves nothing about the mode you asked
 * for.
 */
function pickMode(): 'qr' | 'otp' | 'username' | 'identity' {
  if (args.has('otp')) return 'otp';
  if (args.has('username')) return 'username';
  if (args.has('identity')) return 'identity';
  return 'qr';
}

const mode = pickMode();
const shouldFail = args.has('--fail');
/** Rotate forever instead of finishing — for looking at the page properly. */
const hold = args.has('--hold');

// The real login opens on the username form. The QR and OTP demos are about
// what comes after it, so they start where the CLI would be by then.
const page = startLoginPage(mode === 'username' ? { kind: 'ask-username' } : { kind: 'starting' });
process.stderr.write(`\nLogin page: ${page.url}\n`);
process.stderr.write('(this is the line an agent would hand to the user)\n\n');

if (!args.has('--no-open')) {
  Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', page.url]);
}

// MitID's binding value is a hex string it halves across the two codes; any
// 32 hex characters exercise the same encode.
const channelBinding = () => randomUUID().replaceAll('-', '');

if (mode === 'username') {
  const first = await page.askUsername();
  process.stderr.write(`  typed: ${first}\n`);

  // Rejected once, the way a MitID `identity_not_found` comes back: the card is
  // redrawn with an empty field to retype into and the message underneath it.
  process.stderr.write('  rejecting it, to show the re-ask\n');
  const second = await page.askUsername({
    error: 'MitID kender ikke det brugernavn. Tjek det, og prøv igen.',
  });
  process.stderr.write(`  typed again: ${second}\n`);
} else if (mode === 'identity') {
  const options = ['Alma Eksempelsen — forælder', 'Viggo Eksempelsen — forælder'];

  const rejected = await page.askIdentity(options);
  process.stderr.write(`  picked: ${options[rejected - 1]} (option ${rejected})\n`);

  process.stderr.write('  rejecting it, to show the re-ask\n');
  const picked = await page.askIdentity(options, {
    error: 'Det login kunne ikke bruges. Vælg et andet.',
  });
  process.stderr.write(`  picked again: ${options[picked - 1]} (option ${picked})\n`);
} else if (mode === 'qr') {
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
// Copied verbatim from what `login.ts` hands to `finish()`, Danish included:
// the outcome is the last thing the parent reads, so a demo that invents its
// own wording is a demo of a page nobody ships.
await page.finish(
  shouldFail
    ? {
        ok: false,
        message:
          'MitID afviste login, fordi der allerede er en åben MitID-session. Åbn MitID-appen, ' +
          'afvis en eventuel ventende anmodning, luk faner med aula.dk, og prøv igen om et par minutter.',
      }
    : { ok: true, message: 'Du er logget ind. Aula er klar til at læse med.' },
);
process.stderr.write(`  done (${shouldFail ? 'failed' : 'ok'})\n`);
