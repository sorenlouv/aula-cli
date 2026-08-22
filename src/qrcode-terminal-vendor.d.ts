/**
 * Types for qrcode-terminal's vendored encoder.
 *
 * `@types/qrcode-terminal` covers only the package's own `generate()`, which
 * returns a finished string of block characters. `qr-svg.ts` needs the matrix
 * behind it, so it imports the vendored encoder directly — untyped CommonJS,
 * hence this. Four methods, unchanged since 2012; if a major version ever moves
 * them, this file is what fails the typecheck.
 */

declare module 'qrcode-terminal/vendor/QRCode/index.js' {
  export default class QRCode {
    constructor(typeNumber: number, errorCorrectLevel: number);
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  }
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js' {
  const levels: { L: number; M: number; Q: number; H: number };
  export default levels;
}
