/**
 * The document wrapper's two print promises.
 *
 * Both are one line of a string constant, and both fail silently: a collapsed
 * section prints as a heading with nothing under it, and a source dump that
 * prints turns two forwardable pages into twenty. Neither shows up until
 * somebody actually makes a PDF, which is exactly why they are pinned here.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish } from './publish.ts';

describe('the printed copy', () => {
  const write = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aula-publish-'));
    try {
      const result = await publish('<div class="wrap">Oversigt</div>', {
        day: '2026-08-13',
        title: 'Aula AI oversigt',
        dir,
      });
      return {
        html: readFileSync(result.htmlPath, 'utf8'),
        artifact: readFileSync(result.artifactPath, 'utf8'),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('expands the collapsed sections, and only those', async () => {
    const { html, artifact } = await write();
    // Not `querySelectorAll('details')`: that would drag every message thread
    // on the page into the PDF.
    expect(html).toContain("'details:not(.more)'");
    expect(html).toContain('beforeprint');
    expect(artifact).toContain("'details:not(.more)'");
  });

  test('keeps the verbatim source material out of print', async () => {
    const { html } = await write();
    const print = /@media print\{([\s\S]*?)\n\}/.exec(html)?.[1] ?? '';
    expect(print).toContain('.more{display:none}');
  });

  // A more-block lives inside the context section, so a descendant selector let the
  // outer section's open state decide the inner block's arrow: shut, pointing
  // up. Measured in a browser, not reasoned about.
  test('a collapsed block nested in an open section keeps its own chevron', async () => {
    const { html } = await write();
    expect(html).toContain('details[open]>summary::after');
    expect(html).not.toContain('details[open] summary::after');
  });

  test('the fragment for hosting carries the same behaviour as the file', async () => {
    const { html, artifact } = await write();
    expect(artifact).not.toContain('<!doctype');
    expect(artifact.startsWith('<title>')).toBe(true);
    for (const marker of ['afterprint', 'aula.done.v1']) {
      expect(html).toContain(marker);
      expect(artifact).toContain(marker);
    }
  });
});
