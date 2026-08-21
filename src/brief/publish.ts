/**
 * Writing the outputs.
 *
 * One design, three files: the HTML to read on the Mac, a PDF to forward, and a
 * PNG of the top for chat apps that show images inline but files as a tap.
 *
 * The `beforeprint` hook is not a nicety. A collapsed <details> prints as a
 * heading with nothing under it, so without it the forwarded PDF silently loses
 * whole sections — which was caught the first time a PDF was actually made.
 *
 * Both scripts are inlined here rather than in the body, because `compose.ts`
 * owns the markup and `validate.ts` checks that body for external references.
 * Putting behaviour in the document wrapper keeps that separation intact and
 * gets it onto the fallback layout for free.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '../validation.ts';
import { DONE_SCRIPT } from './done.ts';
import { BRIEF_CSS } from './styles.ts';
import { BRIEF_DIR } from './state.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const PRINT_HOOK = `
  // A collapsed <details> prints as a heading with nothing beneath it, so the
  // PDF that gets forwarded would quietly lose sections. Expand for print only.
  //
  // \`.more\` is excluded, and the exclusion is the point: those hold verbatim
  // source material — whole message threads — rather than anything the brief
  // says. Expanding them would turn two forwardable pages into twenty, so they
  // are hidden in print instead (see the @media print rule in styles.ts) and
  // the original stays one link away in Aula.
  const SECTIONS = 'details:not(.more)';
  addEventListener('beforeprint', () => {
    for (const d of document.querySelectorAll(SECTIONS)) {
      d.dataset.wasOpen = String(d.open); d.open = true;
    }
  });
  addEventListener('afterprint', () => {
    for (const d of document.querySelectorAll(SECTIONS)) d.open = d.dataset.wasOpen === 'true';
  });
`;

/** Separate tags so a throw in one cannot take the other down with it. */
const SCRIPTS = `<script>${PRINT_HOOK}</script>
<script>${DONE_SCRIPT}</script>`;

function wrapDocument(bodyHtml: string, title: string): string {
  return `<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${BRIEF_CSS}</style>
</head>
<body>
${bodyHtml}
${SCRIPTS}
</body>
</html>
`;
}

/**
 * The same page, shaped for hosting rather than for the filesystem.
 *
 * A published artifact supplies its own `<!doctype>`, `<html>`, `<head>` and
 * `<body>`, so this contributes only what goes *inside* them. The `<title>` is
 * kept at the top because only the first 8KB is scanned for it.
 */
function artifactDocument(bodyHtml: string, title: string): string {
  return `<title>${title}</title>
<style>${BRIEF_CSS}</style>
${bodyHtml}
${SCRIPTS}
`;
}

export type PublishResult = {
  htmlPath: string;
  /** Fragment form, ready to hand to the Artifact publisher. */
  artifactPath: string;
  pdfPath: string | null;
  pngPath: string | null;
  warnings: string[];
};

async function runChrome(args: string[], timeoutMs = 120_000): Promise<void> {
  const proc = Bun.spawn([CHROME, '--headless', '--disable-gpu', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const code = await proc.exited;
    if (code !== 0) throw new Error(`Chrome exited ${code}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Writes the dated files plus stable `latest.*` copies.
 *
 * PDF and PNG failures are warnings, never errors: a brief you can read is
 * worth more than no brief at all, and Chrome is the one dependency here that
 * lives outside this project.
 */
export async function publish(
  body: string,
  opts: { day: string; title: string; dir?: string; pdf?: boolean; png?: boolean },
): Promise<PublishResult> {
  const dir = opts.dir ?? BRIEF_DIR;
  mkdirSync(dir, { recursive: true });

  const document = wrapDocument(body, opts.title);
  const htmlPath = join(dir, `brief-${opts.day}.html`);
  writeFileSync(htmlPath, document);
  writeFileSync(join(dir, 'latest.html'), document);

  // Stable path on purpose: republishing the same file redeploys to the same
  // URL, so the link that has been shared keeps working.
  const artifactPath = join(dir, 'artifact.html');
  writeFileSync(artifactPath, artifactDocument(body, opts.title));

  const warnings: string[] = [];
  let pdfPath: string | null = null;
  let pngPath: string | null = null;

  // Off unless asked for: the shared URL is the thing that gets read.
  if (opts.pdf === true) {
    pdfPath = join(dir, `brief-${opts.day}.pdf`);
    try {
      await runChrome([
        '--no-pdf-header-footer',
        '--run-all-compositor-stages-before-draw',
        `--print-to-pdf=${pdfPath}`,
        `file://${htmlPath}`,
      ]);
    } catch (err) {
      warnings.push(`PDF blev ikke dannet: ${errorMessage(err)}`);
      pdfPath = null;
    }
  }

  if (opts.png === true) {
    pngPath = join(dir, `brief-${opts.day}.png`);
    try {
      await runChrome([
        '--window-size=1000,1300',
        '--hide-scrollbars',
        `--screenshot=${pngPath}`,
        `file://${htmlPath}`,
      ]);
    } catch (err) {
      warnings.push(`PNG blev ikke dannet: ${errorMessage(err)}`);
      pngPath = null;
    }
  }

  return { htmlPath, artifactPath, pdfPath, pngPath, warnings };
}
