/**
 * Terminal QR rendering for the MitID app login.
 *
 * MitID picks the channel-binding mode itself. Some accounts get an OTP to
 * compare; others get "TQR", where the app scans a code off the screen. In TQR
 * mode the channel binding is split in half and published as *two* codes that
 * refresh every few seconds, so this has to redraw rather than print.
 */

import { stderr } from 'node:process';
import qrcode from 'qrcode-terminal';

function toLines(payload: string): string[] {
  let rendered = '';
  // Despite the callback shape, small-mode generation is synchronous.
  qrcode.generate(payload, { small: true }, (out: string) => {
    rendered = out;
  });
  return rendered.split('\n');
}

/** Lays the two codes out side by side — stacked, they overflow most terminals. */
function sideBySide(left: string[], right: string[], gap = '   '): string[] {
  const height = Math.max(left.length, right.length);
  const width = Math.max(...left.map((l) => l.length));
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const l = (left[i] ?? '').padEnd(width);
    out.push(`${l}${gap}${right[i] ?? ''}`);
  }
  return out;
}

/**
 * Redraws the pair in place on a TTY, so a refreshing code does not scroll the
 * instructions off screen. Falls back to plain appending when piped.
 */
export function createQrRenderer(): (qr1: string, qr2: string, updateCount: number) => void {
  let previousLineCount = 0;

  return (qr1: string, qr2: string, updateCount: number) => {
    const body = sideBySide(toLines(qr1), toLines(qr2));
    const lines = [
      `  Scan with the MitID app — the two halves refresh together (#${updateCount}):`,
      '',
      ...body,
      '',
    ];
    const text = `${lines.join('\n')}\n`;

    if (previousLineCount > 0 && stderr.isTTY) {
      // Up N lines, then clear everything below the cursor.
      stderr.write(`\x1b[${previousLineCount}A\x1b[0J`);
    }
    stderr.write(text);
    previousLineCount = lines.length;
  };
}
