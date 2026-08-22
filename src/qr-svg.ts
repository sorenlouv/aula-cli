/**
 * QR codes as SVG, for the login page.
 *
 * The terminal renderer in `qr.ts` draws with half-block characters, which only
 * works where a character cell is a known rectangle of pixels. A browser is not
 * that, so the same payload has to be drawn as geometry — and the module matrix
 * is the one thing qrcode-terminal's public API does not hand out. Its vendored
 * encoder does, so this reaches past `generate()` into `vendor/QRCode`: same
 * dependency, same encoder, same bytes on screen as the terminal path, and no
 * second QR library to keep in step with the first.
 *
 * Black on white in both themes, deliberately. Plenty of scanners refuse an
 * inverted code, and a dark-mode QR that will not scan is worse than no page.
 */

import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';

/**
 * The quiet zone is part of the symbol, not decoration: scanners use it to find
 * the edges, and four modules is what the spec asks for.
 */
const QUIET = 4;

/** Same level the terminal path encodes at, so both renderings are one symbol. */
const LEVEL = QRErrorCorrectLevel.L;

/**
 * One row's dark modules as `[start, length]` runs.
 *
 * A 33×33 symbol is ~550 dark modules; drawn one rect each that is a 40 KB
 * element soup being re-parsed every poll. Merged into runs it is a tenth of
 * that, for a loop that costs nothing.
 */
function runs(isDark: (col: number) => boolean, count: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let col = 0; col <= count; col++) {
    const dark = col < count && isDark(col);
    if (dark && start === -1) start = col;
    if (!dark && start !== -1) {
      out.push([start, col - start]);
      start = -1;
    }
  }
  return out;
}

/**
 * Encodes `payload` and returns a standalone `<svg>` element.
 *
 * The viewBox is in module units, so the caller sizes the code in CSS and the
 * geometry stays integral at any size — no half-module seams, which are exactly
 * what a scanner reads as a broken symbol.
 */
export function qrSvg(payload: string, opts: { title?: string } = {}): string {
  const qr = new QRCode(-1, LEVEL);
  qr.addData(payload);
  qr.make();

  const count = qr.getModuleCount();
  const side = count + QUIET * 2;

  const rects: string[] = [];
  for (let row = 0; row < count; row++) {
    for (const [start, length] of runs((col) => qr.isDark(row, col), count)) {
      rects.push(`<rect x="${start + QUIET}" y="${row + QUIET}" width="${length}" height="1"/>`);
    }
  }

  const title = opts.title ? `<title>${opts.title}</title>` : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"`,
    ` shape-rendering="crispEdges" role="img">`,
    title,
    `<rect width="${side}" height="${side}" fill="#fff"/>`,
    `<g fill="#000">${rects.join('')}</g>`,
    `</svg>`,
  ].join('');
}
